import fs from 'node:fs/promises';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { DocIntelError } from './errors.js';
import { aggregate, resolveColumn } from './operations.js';
import { columnTypes } from './parser.js';
import { display, exactSum, toNumber } from './values.js';

/**
 * Safe edits. The original upload is never modified: every edit reads the
 * stored read-only copy and writes a NEW file, which the user downloads after
 * reviewing the change preview. Spreadsheet edits keep styles, formulas,
 * merged cells and column widths that ExcelJS supports; Word edits change only
 * the matched text runs and leave every other XML part byte-for-byte intact.
 */

// --------------------------------------------------------------- formulas

const SAFE_FUNCTIONS = new Set(
  'SUM SUMIF SUMIFS SUMPRODUCT AVERAGE AVERAGEIF AVERAGEIFS COUNT COUNTA COUNTBLANK COUNTIF COUNTIFS MIN MAX MINIFS MAXIFS MEDIAN ROUND ROUNDUP ROUNDDOWN INT ABS MOD POWER SQRT IF IFS IFERROR IFNA AND OR NOT TRUE FALSE ISBLANK ISNUMBER ISTEXT LEN LEFT RIGHT MID UPPER LOWER PROPER TRIM CONCAT CONCATENATE TEXT VALUE DATE YEAR MONTH DAY TODAY EDATE EOMONTH DATEDIF NETWORKDAYS VLOOKUP HLOOKUP XLOOKUP INDEX MATCH SUBTOTAL PRODUCT'.split(
    ' ',
  ),
);

/**
 * True when every formula only uses the arithmetic/lookup functions above and
 * no external workbook references. Formulas like WEBSERVICE, HYPERLINK,
 * INDIRECT, DDE/RTD or [book.xlsx] links are never evaluated.
 */
export function formulasAreSafe(formulas) {
  for (const f of formulas) {
    const text = String(f || '');
    if (/\[|\b(?:https?|file):|'[^']*\.(?:xls|xlsx|xlsm)/i.test(text)) return false;
    for (const m of text.matchAll(/([A-Z][A-Z0-9.]*)\s*\(/gi))
      if (!SAFE_FUNCTIONS.has(m[1].toUpperCase().replace(/^_XLFN\./, ''))) return false;
  }
  return true;
}

export function collectFormulas(doc) {
  const out = [];
  for (const t of doc.tables || [])
    for (const r of t.rows) if (r.formulas) out.push(...Object.values(r.formulas));
  return out;
}

// ------------------------------------------------------------ spreadsheets

/** The number Excel itself would use for a cell in SUM / arithmetic: real numbers and numeric formula results only. */
function excelNumber(cell) {
  const value = cell.value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  // Formula cell: ExcelJS's .value drops a result of 0, so read cell.result.
  if (value && typeof value === 'object' && ('formula' in value || 'sharedFormula' in value))
    return typeof cell.result === 'number' ? cell.result : null;
  return null;
}

async function openWorkbook(doc) {
  const wb = new ExcelJS.Workbook();
  if (doc.original && (doc.ext === '.xlsx' || doc.ext === '.xlsm')) {
    await wb.xlsx.readFile(doc.original.path);
    return { wb, rebuilt: false };
  }
  // CSV / TSV / JSON / converted .xls / index-only copies: rebuild a workbook from the parsed table.
  for (const t of doc.tables) {
    const ws = wb.addWorksheet(
      String(t.name)
        .slice(0, 31)
        .replace(/[[\]:*?/\\]/g, ' '),
    );
    ws.addRow(t.columns);
    ws.getRow(1).font = { bold: true };
    for (const r of t.rows)
      ws.addRow(
        r.values.map((v) =>
          typeof v === 'string' && toNumber(v) !== null && !/^0\d/.test(v.trim()) ? toNumber(v) : v,
        ),
      );
    t.headerRow = 1;
    t.columnLetters = t.columns.map((_, i) => ws.getColumn(i + 1).letter);
    t.rows = t.rows.map((r, i) => ({ ...r, ref: i + 2 }));
  }
  return { wb, rebuilt: true };
}

/**
 * @param {object} doc parsed spreadsheet with `original`
 * @param {object} table table to edit (from doc.tables)
 * @param {{kind: 'total_row', columns?: string[]} | {kind: 'formula_column', name, left, op, right}} edit
 * @returns {Promise<{buffer, ext: 'xlsx', preview: string[], formulas: Array<{cell, formula, value}>, notes: string[]}>}
 */
export async function editSpreadsheet(doc, tableName, edit) {
  const { wb, rebuilt } = await openWorkbook(doc);
  const table = doc.tables.find((t) => t.name === tableName) || doc.tables[0];
  if (!table) throw new DocIntelError('NO_TABLES', 'There is no table to edit.');
  const ws = rebuilt
    ? wb.worksheets[doc.tables.indexOf(table)]
    : wb.getWorksheet(table.source?.sheet || table.name);
  if (!ws) throw new DocIntelError('SHEET_NOT_FOUND', `Sheet "${table.name}" was not found.`);
  const letters = table.columnLetters || table.columns.map((_, i) => ws.getColumn(i + 1).letter);
  const firstRef = Math.min(...table.rows.map((r) => r.ref));
  const lastRef = Math.max(...table.rows.map((r) => r.ref));
  const notes = [];
  const preview = [];
  const formulas = [];
  if (rebuilt)
    notes.push(
      `"${doc.name}" is not an .xlsx workbook, so a new workbook was built from its values.`,
    );
  if (doc.ext === '.xlsm')
    notes.push(
      'The macro-enabled workbook is saved as .xlsx: macros are not copied (they are never run).',
    );

  if (edit.kind === 'total_row') {
    const types = columnTypes(table);
    let cols = edit.columns?.length
      ? edit.columns.map((c) => resolveColumn(table, c))
      : types.map((t, i) => (t === 'number' ? i : -1)).filter((i) => i >= 0);
    cols = [...new Set(cols)];
    if (!cols.length)
      throw new DocIntelError(
        'COLUMN_REQUIRED',
        `Which column should be totalled? Columns: ${table.columns.join(', ')}.`,
        { details: { columns: table.columns } },
      );
    const target = lastRef + 1;
    const row = ws.getRow(target);
    if (row.values.some((v) => v !== null && v !== undefined && v !== '')) {
      ws.spliceRows(target, 0, []);
    }
    const labelCol = letters.findIndex((_, i) => !cols.includes(i));
    if (labelCol >= 0) {
      ws.getCell(`${letters[labelCol]}${target}`).value = 'Total';
      ws.getCell(`${letters[labelCol]}${target}`).font = { bold: true };
    }
    for (const c of cols) {
      const agg = aggregate(table, table.rows, { fn: 'SUM', column: c });
      const cell = `${letters[c]}${target}`;
      const formula = `SUM(${letters[c]}${firstRef}:${letters[c]}${lastRef})`;
      // Saved result = what Excel's SUM computes from the actual cells (text numbers are ignored by Excel).
      const nums = [];
      for (let r = firstRef; r <= lastRef; r++) {
        const n = excelNumber(ws.getCell(`${letters[c]}${r}`));
        if (n !== null) nums.push(n);
      }
      const excelTotal = Math.round(exactSum(nums) * 1e10) / 1e10;
      if (agg.textNumbers)
        notes.push(
          `${table.columns[c]}: ${agg.textNumbers} number(s) stored as text are ignored by Excel's SUM (total ${display(excelTotal)}); convert them to numbers in Excel if they should count (then the total is ${display(agg.value)}).`,
        );
      ws.getCell(cell).value = { formula, result: excelTotal };
      ws.getCell(cell).font = { bold: true };
      const above = ws.getCell(`${letters[c]}${lastRef}`);
      if (above.numFmt) ws.getCell(cell).numFmt = above.numFmt;
      formulas.push({ cell, formula: `=${formula}`, value: excelTotal, column: table.columns[c] });
      preview.push(
        `${cell}: =${formula} → ${display(excelTotal)} (${nums.length} numeric cell(s)${agg.invalid.length ? `, ${agg.invalid.length} non-numeric cell(s) ignored` : ''}${agg.blanks.length ? `, ${agg.blanks.length} blank` : ''})`,
      );
      if (agg.invalid.length)
        notes.push(
          `${table.columns[c]}: the non-numeric cell(s) in ${table.refKind === 'record' ? 'records' : 'rows'} ${agg.invalid
            .slice(0, 8)
            .map((x) => x.row)
            .join(', ')} are not part of the total.`,
        );
    }
  } else if (edit.kind === 'formula_column') {
    const li = resolveColumn(table, edit.left);
    const ri = resolveColumn(table, edit.right);
    const op = { '*': '*', '+': '+', '-': '-', '/': '/' }[edit.op];
    if (!op)
      throw new DocIntelError(
        'BAD_FORMULA',
        'Only +, -, * and / formulas between two columns are supported.',
      );
    let used = 0;
    ws.eachRow({ includeEmpty: false }, (r) =>
      r.eachCell({ includeEmpty: false }, (c) => (used = Math.max(used, c.col))),
    );
    const newCol = Math.max(used, letters.length) + 1;
    const letter = ws.getColumn(newCol).letter;
    const headerRow = table.headerRow || firstRef - 1;
    if (headerRow >= 1) {
      ws.getCell(`${letter}${headerRow}`).value = String(edit.name).slice(0, 80);
      const headerStyle = ws.getCell(`${letters[letters.length - 1]}${headerRow}`);
      ws.getCell(`${letter}${headerRow}`).font = headerStyle.font || { bold: true };
      if (headerStyle.fill) ws.getCell(`${letter}${headerRow}`).fill = headerStyle.fill;
    }
    let skipped = 0;
    for (const r of table.rows) {
      // Only cells Excel itself treats as numbers get a saved result; others are left for Excel to compute.
      const a = excelNumber(ws.getCell(`${letters[li]}${r.ref}`));
      const b = excelNumber(ws.getCell(`${letters[ri]}${r.ref}`));
      let value = null;
      if (a !== null && b !== null && !(op === '/' && b === 0))
        value =
          op === '*'
            ? a * b
            : op === '+'
              ? exactSum([a, b])
              : op === '-'
                ? exactSum([a, -b])
                : a / b;
      else skipped++;
      const formula = `${letters[li]}${r.ref}${op}${letters[ri]}${r.ref}`;
      ws.getCell(`${letter}${r.ref}`).value =
        value === null ? { formula } : { formula, result: Math.round(value * 1e10) / 1e10 };
      formulas.push({
        cell: `${letter}${r.ref}`,
        formula: `=${formula}`,
        value: value === null ? null : Math.round(value * 1e10) / 1e10,
      });
    }
    ws.getColumn(newCol).width = Math.max(10, String(edit.name).length + 2);
    preview.push(
      `New column ${letter} "${edit.name}" = ${table.columns[li]} ${op} ${table.columns[ri]} for ${table.rows.length} row(s) (${letter}${firstRef}:${letter}${lastRef}).`,
    );
    if (skipped)
      notes.push(
        `${skipped} row(s) have a non-numeric, text or blank input (or divide by zero); their formula is written without a saved result and Excel computes it when the file opens.`,
      );
  } else
    throw new DocIntelError(
      'UNSUPPORTED_EDIT',
      'This kind of spreadsheet edit is not supported yet.',
    );

  notes.push(
    'Saved as a new file; the original is unchanged. Charts, pivot tables and images in the original workbook may not be preserved by the editor.',
  );
  wb.calcProperties = { ...(wb.calcProperties || {}), fullCalcOnLoad: true }; // Excel recalculates every formula when the file opens
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  return { buffer, ext: 'xlsx', preview, formulas, notes, sheet: ws.name };
}

// ------------------------------------------------------------------- Word

const xmlEscape = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const xmlUnescape = (s) =>
  String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

/**
 * Replace text inside one Word XML part. Matches may span several runs: the
 * replacement goes into the first run (keeping its formatting) and the rest
 * of the matched text is removed from the following runs.
 * @returns {{ xml, count, samples: Array<{before, after}> }}
 */
export function replaceInWordXml(xml, find, replacement, { section, matchCase = false } = {}) {
  if (!find) throw new DocIntelError('BAD_EDIT', 'What text should be replaced?');
  let count = 0;
  const samples = [];
  let currentSection = null;
  const norm = (s) => (matchCase ? s : s.toLowerCase());
  const needle = norm(find);
  const out = xml.replace(/<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (para) => {
    const style = para.match(/<w:pStyle w:val="([^"]+)"/)?.[1] || '';
    const texts = [...para.matchAll(/(<w:t(?:\s[^>]*)?>)([^<]*)(<\/w:t>)/g)];
    const plain = texts.map((t) => xmlUnescape(t[2])).join('');
    if (/^(Heading\d|Title)$/i.test(style)) currentSection = plain.trim();
    if (section && (currentSection || '').toLowerCase() !== section.toLowerCase()) return para;
    if (!texts.length || !norm(plain).includes(needle)) return para;
    // character offsets of each run inside the paragraph text
    const pieces = texts.map((t) => xmlUnescape(t[2]));
    const starts = [];
    let pos = 0;
    for (const p of pieces) {
      starts.push(pos);
      pos += p.length;
    }
    const hits = [];
    let i = norm(plain).indexOf(needle);
    while (i >= 0) {
      hits.push(i);
      i = norm(plain).indexOf(needle, i + needle.length);
    }
    const newPieces = [...pieces];
    // apply from the last hit backwards so earlier offsets stay valid
    for (const h of hits.reverse()) {
      const end = h + find.length;
      let first = true;
      for (let k = 0; k < pieces.length; k++) {
        const a = starts[k];
        const b = a + pieces[k].length;
        if (b <= h || a >= end) continue;
        const from = Math.max(h, a) - a;
        const to = Math.min(end, b) - a;
        const cur = newPieces[k];
        newPieces[k] = cur.slice(0, from) + (first ? replacement : '') + cur.slice(to);
        first = false;
      }
    }
    count += hits.length;
    const after = newPieces.join('');
    if (samples.length < 10)
      samples.push({
        before: plain.slice(0, 300),
        after: after.slice(0, 300),
        section: currentSection,
      });
    let k = 0;
    return para.replace(
      /(<w:t)((?:\s[^>]*)?>)([^<]*)(<\/w:t>)/g,
      (m, open, attrs, _text, close) => {
        const text = newPieces[k++] ?? '';
        const keepSpace = /xml:space=/.test(attrs)
          ? attrs
          : attrs.replace(/>$/, ' xml:space="preserve">');
        return `${open}${keepSpace}${xmlEscape(text)}${close}`;
      },
    );
  });
  return { xml: out, count, samples };
}

/** Find/replace in a DOCX copy (body, headers and footers). */
export async function editDocx(doc, { find, replace, section, matchCase } = {}) {
  if (!doc.original || doc.ext !== '.docx')
    throw new DocIntelError(
      'ORIGINAL_MISSING',
      'Editing needs the original .docx file. Upload it again (legacy .doc: convert it to DOCX first).',
      { status: 410 },
    );
  const zip = await JSZip.loadAsync(await fs.readFile(doc.original.path));
  const parts = Object.keys(zip.files).filter((n) =>
    /^word\/(?:document|header\d*|footer\d*)\.xml$/.test(n),
  );
  let count = 0;
  const samples = [];
  for (const name of parts) {
    const xml = await zip.file(name).async('string');
    const r = replaceInWordXml(xml, find, replace, {
      section: name === 'word/document.xml' ? section : null,
      matchCase,
    });
    if (section && name !== 'word/document.xml') continue;
    if (r.count) {
      zip.file(name, r.xml);
      count += r.count;
      samples.push(...r.samples);
    }
  }
  if (!count)
    throw new DocIntelError(
      'NOT_FOUND_TEXT',
      `"${find}" was not found${section ? ` in the "${section}" section` : ''}. Nothing was changed.`,
      { status: 404 },
    );
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return {
    buffer,
    ext: 'docx',
    count,
    preview: samples
      .slice(0, 10)
      .map((s) => `${s.section ? `[${s.section}] ` : ''}"${s.before}" → "${s.after}"`),
    notes: [
      'Saved as a new file; the original is unchanged. Only the matched text was changed; other formatting, images and sections are kept.',
    ],
  };
}

/** `replace "old" with "new" [in (the) "Section" section]` — quotes are required so nothing is guessed. */
export function parseReplace(text) {
  const t = String(text);
  const q = String.raw`["“'‘]([^"”'’]{1,200})["”'’]`;
  const m = t.match(
    new RegExp(
      String.raw`\b(?:replace|change|substitute)\s+(?:all\s+)?(?:the\s+)?(?:word\s+|text\s+|phrase\s+)?${q}\s+(?:with|to|by|into|as)\s+${q}`,
      'i',
    ),
  );
  if (!m) return null;
  const s = t.match(
    new RegExp(
      String.raw`\bin\s+(?:the\s+)?${q}\s+section\b|\bin\s+(?:the\s+)?section\s+${q}`,
      'i',
    ),
  );
  return {
    find: m[1],
    replace: m[2],
    section: s ? s[1] || s[2] : null,
    matchCase: /\bmatch case\b|\bcase[- ]sensitive\b/i.test(t),
  };
}
