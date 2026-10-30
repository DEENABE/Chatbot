import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { parseCsv } from '../docqa/tableParser.js';
import { DocIntelError } from './errors.js';
import { LIMITS, validateFile } from './formats.js';
import { display, isBlank } from './values.js';
import { sofficeConvert } from './libreoffice.js';

/**
 * DocumentParser: one structured model for every supported format.
 *
 * ParsedDocument = {
 *   name, ext, kind: 'spreadsheet'|'pdf'|'word'|'text'|'json', size,
 *   metadata: {...}, text,
 *   tables:   [{ name, columns, rows: [{ ref, values, formulas?, errors? }], source, headerRow, merged, formulaCells, warnings }],
 *   pages?:   [{ number, text, scanned, ocr? }]                 (PDF)
 *   blocks?:  [{ type: heading|paragraph|list|table, ... , index }]  (Word / Markdown)
 *   sections?:[{ title, level, start, end }]
 *   warnings: string[]
 * }
 * `ref` is the real sheet row number (XLSX), the CSV record number (header = 1),
 * or the table row number inside a PDF page / Word table.
 */

// ---------------------------------------------------------------- helpers

function decodeText(buffer, warnings) {
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf)
    return buffer.subarray(3).toString('utf8');
  if (buffer[0] === 0xff && buffer[1] === 0xfe)
    return new TextDecoder('utf-16le').decode(buffer.subarray(2));
  if (buffer[0] === 0xfe && buffer[1] === 0xff)
    return new TextDecoder('utf-16be').decode(buffer.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    warnings.push(
      'The file is not valid UTF-8; it was read as Windows-1252. Some characters may be wrong — save it as "CSV UTF-8" for exact text.',
    );
    return new TextDecoder('windows-1252').decode(buffer);
  }
}

const HEADER_NUMERIC = /^[-+]?[\d.,\s:/%₹$-]+$/;

/** First row among the first 10 non-empty rows that looks like column titles. */
function detectHeader(matrix) {
  const probe = matrix.slice(0, 10);
  if (!probe.length) return 0;
  const filledCount = (row) => row.values.filter((c) => !isBlank(c)).length;
  const maxFilled = Math.max(...probe.map(filledCount));
  const index = probe.findIndex((row) => {
    const filled = row.values.filter((c) => !isBlank(c));
    if (filled.length < Math.max(1, Math.ceil(maxFilled * 0.6))) return false;
    const textual = filled.filter((c) => typeof c === 'string' && !HEADER_NUMERIC.test(c)).length;
    if (textual / filled.length < 0.8) return false;
    return new Set(filled.map((c) => String(c).trim().toLowerCase())).size === filled.length;
  });
  return index < 0 ? 0 : index;
}

/**
 * Matrix rows [{ ref, values, formulas?, errors? }] → table with header detection.
 * Columns that are empty everywhere are dropped; duplicate titles get " 2".
 */
export function buildTable(name, matrix, source, extra = {}) {
  const rows = matrix.filter((r) => r.values.some((v) => !isBlank(v)));
  if (!rows.length) return null;
  if (rows.length > LIMITS.maxRows + 20)
    throw new DocIntelError(
      'TOO_LARGE',
      `"${name}" has more than ${LIMITS.maxRows.toLocaleString('en-IN')} rows — too many to process safely.`,
      { status: 413 },
    );
  const headerIndex = rows.length > 1 ? detectHeader(rows) : -1;
  const header = headerIndex >= 0 ? rows[headerIndex] : { ref: null, values: [] };
  const body = headerIndex >= 0 ? rows.slice(headerIndex + 1) : rows;
  const width = Math.min(
    LIMITS.maxColumns,
    Math.max(header.values.length, ...body.map((r) => r.values.length)),
  );
  const keep = [];
  for (let i = 0; i < width; i++)
    if (!isBlank(header.values[i]) || body.some((r) => !isBlank(r.values[i]))) keep.push(i);
  if (!keep.length) return null;
  const seen = new Map();
  const columns = keep.map((i) => {
    let title = isBlank(header.values[i])
      ? `Column ${columnLetter(i)}`
      : display(header.values[i]).replace(/\s+/g, ' ').trim();
    const key = title.toLowerCase();
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    return n > 1 ? `${title} ${n}` : title;
  });
  const headerKey = keep.map((i) => display(header.values[i]).toLowerCase()).join('\u0001');
  const data = [];
  for (const r of body) {
    const values = keep.map((i) => (r.values[i] === undefined ? null : r.values[i]));
    if (values.every(isBlank)) continue;
    if (
      headerIndex >= 0 &&
      keep.map((i) => display(r.values[i]).toLowerCase()).join('\u0001') === headerKey
    )
      continue;
    const row = { ref: r.ref, values };
    if (r.formulas) {
      const f = {};
      keep.forEach((src, dst) => r.formulas[src] && (f[dst] = r.formulas[src]));
      if (Object.keys(f).length) row.formulas = f;
    }
    if (r.errors) {
      const e = {};
      keep.forEach((src, dst) => r.errors[src] && (e[dst] = r.errors[src]));
      if (Object.keys(e).length) row.errors = e;
    }
    data.push(row);
  }
  return {
    name,
    columns,
    columnLetters: keep.map(columnLetter),
    rows: data,
    headerRow: header.ref,
    source,
    merged: extra.merged || [],
    formulaCells: data.reduce((n, r) => n + (r.formulas ? Object.keys(r.formulas).length : 0), 0),
    warnings: extra.warnings || [],
  };
}

export function columnLetter(index) {
  let s = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26))
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

// ------------------------------------------------------------ spreadsheet

function cellValue(cell) {
  const v = cell.value;
  if (v === null || v === undefined) return { value: null };
  if (v instanceof Date) return { value: v };
  if (typeof v !== 'object') return { value: v };
  if ('formula' in v || 'sharedFormula' in v) {
    const formula = v.formula || (v.sharedFormula ? cell.formula || v.sharedFormula : null);
    // ExcelJS's .value getter drops falsy results (0, false, ""), so read the model directly.
    const result = cell.model?.result !== undefined ? cell.model.result : v.result;
    if (result && typeof result === 'object' && 'error' in result)
      return { value: null, formula, error: result.error };
    if (result === undefined) return { value: null, formula, uncalculated: true };
    return { value: result instanceof Date ? result : result, formula };
  }
  if ('error' in v) return { value: null, error: v.error };
  if (Array.isArray(v.richText)) return { value: v.richText.map((t) => t.text).join('') };
  if ('text' in v)
    return {
      value:
        typeof v.text === 'object' && v.text?.richText
          ? v.text.richText.map((t) => t.text).join('')
          : v.text,
      hyperlink: v.hyperlink,
    };
  return { value: String(v) };
}

async function parseWorkbook(filePath, ext, warnings) {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.readFile(filePath, {
      ignoreNodes: [
        'dataValidations',
        'conditionalFormatting',
        'drawing',
        'picture',
        'legacyDrawing',
        'extLst',
      ],
    });
  } catch (error) {
    throw new DocIntelError(
      'CORRUPT_FILE',
      'The workbook could not be opened. It may be damaged, encrypted, or not a real Excel file.',
      { details: { reason: String(error.message).slice(0, 200) } },
    );
  }
  const tables = [];
  const sheets = [];
  let uncalculated = 0;
  for (const ws of workbook.worksheets) {
    const merges = Object.values(ws._merges || {}).map((m) => m.range || String(m));
    const mergeMap = new Map(); // "r:c" of slave → master address
    for (const range of merges) {
      const [a, b] = String(range).split(':');
      if (!b) continue;
      const s = ws.getCell(a);
      const e = ws.getCell(b);
      for (let r = s.row; r <= e.row; r++)
        for (let c = s.col; c <= e.col; c++)
          if (r !== s.row || c !== s.col) mergeMap.set(`${r}:${c}`, { r: s.row, c: s.col });
    }
    const matrix = [];
    const sheetWarnings = [];
    let mergedNumericSkipped = 0;
    const rowCount = Math.min(ws.actualRowCount ? ws.rowCount : 0, LIMITS.maxRows + 50);
    if (ws.rowCount > LIMITS.maxRows + 50)
      throw new DocIntelError(
        'TOO_LARGE',
        `Sheet "${ws.name}" has more than ${LIMITS.maxRows.toLocaleString('en-IN')} rows — too many to process safely.`,
        { status: 413 },
      );
    for (let r = 1; r <= rowCount; r++) {
      const row = ws.getRow(r);
      if (!row.hasValues && !mergeMap.size) continue;
      const values = [];
      let formulas = null;
      let errors = null;
      const width = Math.min(ws.columnCount, LIMITS.maxColumns);
      for (let c = 1; c <= width; c++) {
        const master = mergeMap.get(`${r}:${c}`);
        if (master) {
          const mv = cellValue(ws.getCell(master.r, master.c)).value;
          // Text is repeated across a merged area (e.g. a merged Region label); numbers are
          // kept only in the first cell so a merged amount is never counted twice.
          if (typeof mv === 'number') mergedNumericSkipped++;
          values.push(typeof mv === 'number' ? null : mv);
          continue;
        }
        const info = cellValue(ws.getCell(r, c));
        values.push(info.value);
        if (info.formula) (formulas ||= {})[c - 1] = info.formula;
        if (info.uncalculated) uncalculated++;
        if (info.error) (errors ||= {})[c - 1] = info.error;
      }
      matrix.push({
        ref: r,
        values,
        ...(formulas ? { formulas } : {}),
        ...(errors ? { errors } : {}),
      });
    }
    if (merges.length)
      sheetWarnings.push(
        `${merges.length} merged cell range(s): text is repeated across each merged area${mergedNumericSkipped ? '; merged numbers are counted once (first cell only)' : ''}.`,
      );
    const table = buildTable(
      ws.name,
      matrix,
      { kind: 'sheet', sheet: ws.name },
      { merged: merges, warnings: sheetWarnings },
    );
    sheets.push({
      name: ws.name,
      state: ws.state || 'visible',
      rows: table ? table.rows.length : 0,
      columns: table ? table.columns.length : 0,
      empty: !table,
    });
    if (table) {
      if (ws.state && ws.state !== 'visible')
        table.warnings.push(`Sheet "${ws.name}" is hidden in Excel.`);
      tables.push(table);
    }
  }
  if (uncalculated)
    warnings.push(
      `${uncalculated} formula cell(s) have no saved result (the workbook was never recalculated). Those cells are reported as blank; recalculate in Excel/LibreOffice for exact values.`,
    );
  return {
    tables,
    metadata: {
      sheets,
      creator: workbook.creator || null,
      lastModifiedBy: workbook.lastModifiedBy || null,
      created: workbook.created ? workbook.created.toISOString() : null,
      modified: workbook.modified ? workbook.modified.toISOString() : null,
    },
  };
}

function parseDelimited(text, ext, name) {
  let rows;
  if (ext === '.tsv')
    rows = text
      .replace(/^\uFEFF/, '')
      .split(/\r?\n/)
      .map((l) => l.split('\t'));
  else rows = parseCsv(text);
  while (rows.length && rows.at(-1).every((c) => c === '')) rows.pop();
  const matrix = rows.map((values, i) => ({
    ref: i + 1,
    values: values.map((v) => (v === '' ? null : v)),
  }));
  const table = buildTable(name, matrix, { kind: 'sheet', sheet: name });
  return table ? [table] : [];
}

// ------------------------------------------------------------------- PDF

function renderPageWithColumns(textContent) {
  const items = textContent.items
    .filter((it) => it.str !== undefined)
    .map((it) => ({
      str: it.str,
      x: it.transform[4],
      y: it.transform[5],
      w: it.width || 0,
      size: Math.abs(it.transform[3]) || Math.abs(it.transform[0]) || 10,
    }));
  const lines = [];
  for (const it of items) {
    const line = lines.find((l) => Math.abs(l.y - it.y) <= Math.max(1.5, it.size * 0.25));
    if (line) line.items.push(it);
    else lines.push({ y: it.y, items: [it] });
  }
  lines.sort((a, b) => b.y - a.y);
  return lines.map((l) => {
    l.items.sort((a, b) => a.x - b.x);
    let out = '';
    let end = null;
    for (const it of l.items) {
      if (end !== null) {
        const gap = it.x - end;
        if (gap > it.size * 1.5) out += '\t';
        else if (gap > it.size * 0.12 && !out.endsWith(' ') && !it.str.startsWith(' ')) out += ' ';
      }
      out += it.str;
      end = it.x + it.w;
    }
    return out.replace(/[ ]{2,}/g, ' ').trimEnd();
  });
}

/** Lines with ≥ 2 tab-separated columns repeated on ≥ 3 consecutive lines form a table. */
export function detectPdfTables(pageNumber, lines) {
  const tables = [];
  let run = [];
  const flush = () => {
    if (run.length >= 3) {
      const width = Math.max(...run.map((r) => r.cells.length));
      const consistent = run.filter((r) => r.cells.length === width).length / run.length >= 0.6;
      if (consistent) {
        const matrix = run.map((r, i) => ({
          ref: i + 1,
          values: r.cells.map((c) => (c === '' ? null : c)),
        }));
        const t = buildTable(`Page ${pageNumber} table ${tables.length + 1}`, matrix, {
          kind: 'pdf-table',
          page: pageNumber,
          table: tables.length + 1,
        });
        if (t) {
          t.warnings.push(
            'Table reconstructed from PDF text positions; verify columns against the page.',
          );
          tables.push(t);
        }
      }
    }
    run = [];
  };
  for (const line of lines) {
    const cells = line.split('\t').map((c) => c.trim());
    if (cells.length >= 2 && cells.filter(Boolean).length >= 2) run.push({ cells });
    else flush();
  }
  flush();
  return tables;
}

async function parsePdf(filePath, warnings, { ocr, signal } = {}) {
  const bytes = Uint8Array.from(await fs.readFile(filePath));
  const pages = [];
  let result;
  try {
    result = await pdfParse(bytes, {
      max: LIMITS.maxPdfPages,
      pagerender: async (pageData) => {
        const content = await pageData.getTextContent({
          normalizeWhitespace: false,
          disableCombineTextItems: false,
        });
        const lines = renderPageWithColumns(content);
        pages.push({
          number: pages.length + 1,
          lines,
          text: lines.join('\n').replace(/\t/g, '  '),
        });
        return '';
      },
    });
  } catch (error) {
    const msg = String(error?.message || '');
    if (/password|encrypt/i.test(msg))
      throw new DocIntelError(
        'ENCRYPTED',
        'This PDF is password-protected. Remove the password and upload again.',
      );
    throw new DocIntelError('CORRUPT_FILE', 'The PDF could not be read. It may be damaged.', {
      details: { reason: msg.slice(0, 200) },
    });
  }
  if (result.numpages > LIMITS.maxPdfPages)
    warnings.push(`Only the first ${LIMITS.maxPdfPages} of ${result.numpages} pages were read.`);
  const scanned = pages.filter((p) => p.text.replace(/\s+/g, '').length < 15).map((p) => p.number);
  for (const p of pages) p.scanned = scanned.includes(p.number);
  let ocrInfo = null;
  if (scanned.length) {
    if (ocr) {
      ocrInfo = await ocr(bytes, scanned, { totalPages: pages.length, signal }).catch((error) => ({
        error: String(error.message).slice(0, 200),
      }));
      if (ocrInfo?.pages)
        for (const o of ocrInfo.pages) {
          const page = pages[o.page - 1];
          if (page && o.text.trim()) {
            page.text = o.text;
            page.lines = o.text.split('\n');
            page.ocr = { confidence: o.confidence, engine: ocrInfo.engine };
          }
        }
    }
    const done = pages.filter((p) => p.ocr).map((p) => p.number);
    const missing = scanned.filter((n) => !done.includes(n));
    if (done.length)
      warnings.push(
        `OCR was used for page(s) ${compactList(done)} (average confidence ${Math.round(done.reduce((s, n) => s + pages[n - 1].ocr.confidence, 0) / done.length)}%). OCR text can contain mistakes — check important values against the page.`,
      );
    if (missing.length)
      warnings.push(
        `Page(s) ${compactList(missing)} look scanned (no text layer) and could not be read${ocrInfo?.reason ? `: ${ocrInfo.reason}` : ocrInfo?.error ? `: ${ocrInfo.error}` : ''}.`,
      );
  }
  const tables = pages.flatMap((p) => (p.ocr ? [] : detectPdfTables(p.number, p.lines)));
  const info = result.info || {};
  return {
    pages: pages.map(({ number, text, scanned: s, ocr: o }) => ({
      number,
      text,
      scanned: s,
      ...(o ? { ocr: o } : {}),
    })),
    tables,
    metadata: {
      pages: result.numpages,
      title: info.Title || null,
      author: info.Author || null,
      creator: info.Creator || null,
      producer: info.Producer || null,
      created: info.CreationDate || null,
      scannedPages: scanned,
      textBased: scanned.length < pages.length,
    },
  };
}

export const compactList = (nums) => {
  const out = [];
  for (let i = 0; i < nums.length; i++) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    out.push(j > i ? `${nums[i]}–${nums[j]}` : String(nums[i]));
    i = j;
  }
  return out.join(', ');
};

// ------------------------------------------------------------------ Word

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function htmlText(html) {
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|tr|h[1-6])>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
      if (e[0] === '#') {
        const code =
          e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

/** Top-level elements of an HTML fragment with balanced nesting of the same tag. */
export function topLevelElements(html) {
  const out = [];
  const open = /<(h[1-6]|p|ul|ol|table)\b[^>]*>/gi;
  let m;
  while ((m = open.exec(html))) {
    const tag = m[1].toLowerCase();
    const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
    re.lastIndex = m.index + m[0].length;
    let depth = 1;
    let t;
    while (depth && (t = re.exec(html))) depth += t[1] ? -1 : 1;
    const end = t ? t.index + t[0].length : html.length;
    out.push({ tag, inner: html.slice(m.index + m[0].length, t ? t.index : html.length) });
    open.lastIndex = end;
  }
  return out;
}

async function docxMetadata(filePath) {
  try {
    const zip = await JSZip.loadAsync(await fs.readFile(filePath));
    const core = (await zip.file('docProps/core.xml')?.async('string')) || '';
    const app = (await zip.file('docProps/app.xml')?.async('string')) || '';
    const tag = (xml, name) =>
      xml.match(new RegExp(`<(?:\\w+:)?${name}[^>]*>([^<]*)</(?:\\w+:)?${name}>`))?.[1] || null;
    return {
      title: tag(core, 'title'),
      author: tag(core, 'creator'),
      lastModifiedBy: tag(core, 'lastModifiedBy'),
      created: tag(core, 'created'),
      modified: tag(core, 'modified'),
      pages: Number(tag(app, 'Pages')) || null,
      words: Number(tag(app, 'Words')) || null,
    };
  } catch {
    return {};
  }
}

async function parseDocx(filePath, warnings) {
  let html;
  try {
    const result = await mammoth.convertToHtml(
      { path: filePath },
      {
        includeDefaultStyleMap: true,
        // Word's built-in list paragraph styles (also used by this app's own DOCX writer).
        styleMap: [
          "p[style-name='List Bullet'] => ul > li:fresh",
          "p[style-name='List Number'] => ol > li:fresh",
        ],
      },
    );
    html = result.value;
    const unknown = result.messages.filter(
      (m) => m.type === 'warning' && /unrecognised|unrecognized/i.test(m.message),
    );
    if (unknown.length)
      warnings.push(
        `${unknown.length} formatting element(s) were not recognised and are shown as plain text.`,
      );
  } catch (error) {
    throw new DocIntelError(
      'CORRUPT_FILE',
      'The Word document could not be read. It may be damaged.',
      { details: { reason: String(error.message).slice(0, 200) } },
    );
  }
  const blocks = [];
  const tables = [];
  for (const el of topLevelElements(html)) {
    const index = blocks.length + 1;
    if (/^h[1-6]$/.test(el.tag))
      blocks.push({ type: 'heading', level: Number(el.tag[1]), text: htmlText(el.inner), index });
    else if (el.tag === 'p') {
      const text = htmlText(el.inner);
      if (text) blocks.push({ type: 'paragraph', text, index });
    } else if (el.tag === 'ul' || el.tag === 'ol') {
      const items = (el.inner.match(/<li\b[^>]*>[\s\S]*?<\/li>/gi) || [])
        .map((li) => htmlText(li))
        .filter(Boolean);
      if (items.length) blocks.push({ type: 'list', ordered: el.tag === 'ol', items, index });
    } else if (el.tag === 'table') {
      const matrix = (el.inner.match(/<tr\b[\s\S]*?<\/tr>/gi) || []).map((tr, i) => ({
        ref: i + 1,
        values: (tr.match(/<t[dh]\b[^>]*>[\s\S]*?<\/t[dh]>/gi) || []).map((c) => {
          const t = htmlText(c);
          return t === '' ? null : t;
        }),
      }));
      const number = tables.length + 1;
      const table = buildTable(`Table ${number}`, matrix, {
        kind: 'docx-table',
        table: number,
        block: index,
      });
      if (table) {
        tables.push(table);
        blocks.push({
          type: 'table',
          table: number,
          columns: table.columns,
          rows: table.rows.map((r) => r.values.map(display)),
          index,
        });
      }
    }
  }
  return { blocks, tables, metadata: await docxMetadata(filePath) };
}

export function sectionsOf(blocks) {
  const sections = [];
  let current = { title: 'Introduction', level: 0, start: 1, end: 0 };
  for (const b of blocks) {
    if (b.type === 'heading') {
      if (current.end >= current.start) sections.push(current);
      current = { title: b.text, level: b.level, start: b.index, end: b.index };
    } else current.end = b.index;
  }
  if (current.end >= current.start) sections.push(current);
  return sections;
}

export function blocksToText(blocks) {
  return blocks
    .map((b) =>
      b.type === 'heading'
        ? `${'#'.repeat(b.level)} ${b.text}`
        : b.type === 'list'
          ? b.items.map((i, n) => (b.ordered ? `${n + 1}. ${i}` : `- ${i}`)).join('\n')
          : b.type === 'table'
            ? [b.columns.join('\t'), ...b.rows.map((r) => r.join('\t'))].join('\n')
            : b.text,
    )
    .join('\n\n');
}

function markdownBlocks(text) {
  const blocks = [];
  for (const part of text.replace(/\r/g, '').split(/\n{2,}/)) {
    const t = part.trim();
    if (!t) continue;
    const h = t.match(/^(#{1,6})\s+(.+)$/);
    if (h && !t.includes('\n'))
      blocks.push({
        type: 'heading',
        level: h[1].length,
        text: h[2].trim(),
        index: blocks.length + 1,
      });
    else if (/^(?:[-*•]|\d+[.)])\s+/.test(t))
      blocks.push({
        type: 'list',
        ordered: /^\d/.test(t),
        items: t
          .split('\n')
          .map((l) => l.replace(/^(?:[-*•]|\d+[.)])\s+/, '').trim())
          .filter(Boolean),
        index: blocks.length + 1,
      });
    else blocks.push({ type: 'paragraph', text: t, index: blocks.length + 1 });
  }
  return blocks;
}

// ------------------------------------------------------------------ JSON

function parseJsonDocument(text, name, warnings) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new DocIntelError(
      'CORRUPT_FILE',
      `The JSON file is not valid: ${String(error.message).slice(0, 120)}`,
    );
  }
  const tables = [];
  const tabulate = (label, arr) => {
    const objects = arr.filter((x) => x && typeof x === 'object' && !Array.isArray(x));
    if (objects.length < arr.length * 0.8 || !objects.length) return;
    const cols = [];
    for (const o of objects)
      for (const k of Object.keys(o))
        if (!cols.includes(k) && cols.length < LIMITS.maxColumns) cols.push(k);
    const matrix = [
      { ref: 0, values: cols },
      ...objects.map((o, i) => ({
        ref: i + 1,
        values: cols.map((c) =>
          o[c] === undefined
            ? null
            : typeof o[c] === 'object' && o[c] !== null
              ? JSON.stringify(o[c])
              : o[c],
        ),
      })),
    ];
    const t = buildTable(label, matrix, { kind: 'json', path: label });
    if (t) tables.push(t);
  };
  if (Array.isArray(data)) tabulate(name, data);
  else if (data && typeof data === 'object')
    for (const [k, v] of Object.entries(data)) if (Array.isArray(v)) tabulate(k, v);
  if (!tables.length && typeof data === 'object')
    warnings.push('No list of records was found in this JSON; it is shown as text.');
  return { tables, text: JSON.stringify(data, null, 2).slice(0, 2_000_000) };
}

// ------------------------------------------------------------------ entry

const withTimeout = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) => {
      const t = setTimeout(
        () =>
          reject(
            new DocIntelError('TIMEOUT', `${label} took too long and was stopped.`, {
              status: 504,
            }),
          ),
        ms,
      );
      t.unref?.();
    }),
  ]);

/**
 * Parse a file on disk. Validates type/signature/size first.
 * @param {string} filePath
 * @param {string} name original file name (decides the format)
 * @param {{ mime?: string, ocr?: Function, soffice?: string|null }} [options]
 */
export async function parseDocument(filePath, name, options = {}) {
  const { ext, format, size, container } = await validateFile(filePath, name, {
    mime: options.mime,
  });
  const warnings = [];
  if (container?.macros)
    warnings.push('This file contains macros. Macros are never run; only cell values are read.');
  if (container?.externalLinks)
    warnings.push(
      'This workbook links to other files. External links are not followed; saved values are used.',
    );
  if (container?.embeddedObjects) warnings.push('Embedded objects (OLE) were ignored.');
  const base = { name, ext, kind: format.kind, size, warnings };

  const work = async () => {
    if (!format.native) {
      // Legacy binary formats: convert with LibreOffice into a private temp file first.
      const converted = await sofficeConvert(filePath, ext, format.via.slice(1), {
        soffice: options.soffice,
        signal: options.signal,
      });
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chanakya-legacy-'));
      try {
        const temp = path.join(dir, `converted${format.via}`);
        await fs.writeFile(temp, converted);
        const parsed = await parseDocument(temp, `${path.basename(name, ext)}${format.via}`, {
          ...options,
          mime: undefined,
        });
        return {
          ...parsed,
          name,
          ext,
          warnings: [
            `Converted from legacy ${ext} with LibreOffice; some formatting may differ.`,
            ...parsed.warnings,
          ],
        };
      } finally {
        fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }
    if (format.kind === 'spreadsheet' && (ext === '.xlsx' || ext === '.xlsm')) {
      const { tables, metadata } = await parseWorkbook(filePath, ext, warnings);
      return { ...base, tables, metadata, text: tablesText(tables) };
    }
    if (format.kind === 'spreadsheet') {
      const text = decodeText(await fs.readFile(filePath), warnings);
      const tables = parseDelimited(text, ext, path.basename(name, ext));
      return {
        ...base,
        tables,
        metadata: {
          sheets: tables.map((t) => ({
            name: t.name,
            rows: t.rows.length,
            columns: t.columns.length,
          })),
        },
        text: tablesText(tables),
      };
    }
    if (format.kind === 'pdf') {
      const { pages, tables, metadata } = await parsePdf(filePath, warnings, {
        ocr: options.ocr,
        signal: options.signal,
      });
      return {
        ...base,
        pages,
        tables,
        metadata,
        text: pages.map((p) => `--- Page ${p.number} ---\n${p.text}`).join('\n\n'),
      };
    }
    if (format.kind === 'word') {
      const { blocks, tables, metadata } = await parseDocx(filePath, warnings);
      return {
        ...base,
        blocks,
        sections: sectionsOf(blocks),
        tables,
        metadata,
        text: blocksToText(blocks),
      };
    }
    const text = decodeText(await fs.readFile(filePath), warnings);
    if (format.kind === 'json') {
      const j = parseJsonDocument(text, path.basename(name, ext), warnings);
      return {
        ...base,
        tables: j.tables,
        metadata: { records: j.tables.reduce((n, t) => n + t.rows.length, 0) },
        text: j.text,
      };
    }
    const blocks = markdownBlocks(text);
    return {
      ...base,
      blocks,
      sections: sectionsOf(blocks),
      tables: [],
      metadata: { lines: text.split('\n').length, characters: text.length },
      text,
    };
  };

  const doc = await withTimeout(
    work(),
    options.timeoutMs || LIMITS.parseTimeoutMs,
    'Reading the document',
  );
  const hasContent = (doc.text || '').trim() || doc.tables.some((t) => t.rows.length);
  if (!hasContent && !(doc.kind === 'pdf' && doc.metadata?.scannedPages?.length))
    throw new DocIntelError('EMPTY_DOCUMENT', 'The document has no readable content.');
  return doc;
}

function tablesText(tables) {
  return tables
    .map((t) =>
      [
        `Sheet: ${t.name}`,
        t.columns.join('\t'),
        ...t.rows.slice(0, 5000).map((r) => r.values.map(display).join('\t')),
      ].join('\n'),
    )
    .join('\n\n');
}

/** Small JSON-safe summary for previews and the inspect endpoint. */
export function describeDocument(doc) {
  return {
    name: doc.name,
    kind: doc.kind,
    ext: doc.ext,
    size: doc.size,
    metadata: doc.metadata,
    pages: doc.pages ? doc.pages.length : undefined,
    sections: doc.sections
      ? doc.sections.map((s) => ({ title: s.title, level: s.level }))
      : undefined,
    tables: doc.tables.map((t) => ({
      name: t.name,
      source: t.source,
      columns: t.columns,
      columnLetters: t.columnLetters,
      headerRow: t.headerRow,
      rows: t.rows.length,
      formulaCells: t.formulaCells,
      merged: t.merged.length,
      warnings: t.warnings,
      types: columnTypes(t),
      preview: t.rows.slice(0, 5).map((r) => ({ ref: r.ref, values: r.values.map(display) })),
    })),
    textPreview: doc.tables.length ? undefined : String(doc.text || '').slice(0, 1500),
    warnings: doc.warnings,
  };
}

/** Per-column dominant type: number | date | text | boolean | empty | mixed. */
export function columnTypes(table) {
  return table.columns.map((_, i) => {
    const counts = { number: 0, date: 0, text: 0, boolean: 0 };
    let filled = 0;
    for (const r of table.rows.slice(0, 2000)) {
      const v = r.values[i];
      if (isBlank(v)) continue;
      filled++;
      if (typeof v === 'number') counts.number++;
      else if (v instanceof Date) counts.date++;
      else if (typeof v === 'boolean') counts.boolean++;
      else if (/^\s*[-+(]?[₹$€£]?\s*[\d,]+(?:\.\d+)?\)?%?\s*$/.test(v)) counts.number++;
      else if (/^\d{4}-\d{2}-\d{2}|^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/.test(String(v).trim()))
        counts.date++;
      else counts.text++;
    }
    if (!filled) return 'empty';
    const [best, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    return n / filled >= 0.8 ? best : 'mixed';
  });
}
