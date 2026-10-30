import ExcelJS from 'exceljs';
import { toDocx, htmlToPdf as browserHtmlToPdf, findBrowser } from '../fileagent/documents.js';
import { toCsv } from '../fileagent/writers.js';
import { DocIntelError } from './errors.js';
import { display, exactSum, toNumber } from './values.js';
import { sofficeConvert, findSoffice } from './libreoffice.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * DocumentGenerationEngine: writes XLSX / DOCX / PDF / CSV / JSON / TXT / HTML
 * from validated structured content. Content model ("blocks"):
 *   { type: 'heading', level, text } | { type: 'paragraph', text, italic? }
 *   { type: 'bullets', items } | { type: 'table', columns, rows }
 *   { type: 'chart', title, labels, values, labelTitle?, valueTitle? } | { type: 'pagebreak' }
 * Sheets for XLSX: { name, columns, rows, totals?: string[] (column names to total), types? }
 */

// ----------------------------------------------------------------- XLSX

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E2F3' } };

function excelSheetName(name, used) {
  let base =
    String(name || 'Sheet')
      .replace(/[[\]:*?/\\]/g, ' ')
      .trim()
      .slice(0, 31) || 'Sheet';
  let n = base;
  for (let i = 2; used.has(n.toLowerCase()); i++) n = `${base.slice(0, 27)} (${i})`;
  used.add(n.toLowerCase());
  return n;
}

const cellOut = (v) => {
  if (v === null || v === undefined) return null;
  if (v instanceof Date || typeof v === 'number' || typeof v === 'boolean') return v;
  return String(v).slice(0, 32_767);
};

/**
 * @param {{ sheets: Array<{name, columns, rows: any[][], totals?: string[], notes?: string[]}>, creator?: string }} spec
 * Totals rows use real SUM formulas *and* store the computed result, so the
 * file shows the right value even before Excel recalculates.
 */
export async function writeXlsx(spec) {
  const wb = new ExcelJS.Workbook();
  wb.creator = spec.creator || 'Chanakya AI';
  wb.created = new Date(0); // deterministic output for tests and verification
  wb.modified = new Date(0);
  const used = new Set();
  const totalsInfo = [];
  for (const sheet of spec.sheets) {
    const ws = wb.addWorksheet(excelSheetName(sheet.name, used), {
      views: [{ state: 'frozen', ySplit: 1 }],
    });
    ws.addRow(sheet.columns.map(String));
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).eachCell((c) => (c.fill = HEADER_FILL));
    for (const r of sheet.rows) ws.addRow(sheet.columns.map((_, i) => cellOut(r[i])));
    const last = sheet.rows.length + 1;
    if (sheet.columns.length)
      ws.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: Math.max(1, last), column: sheet.columns.length },
      };
    sheet.columns.forEach((c, i) => {
      const longest = Math.max(
        String(c).length,
        ...sheet.rows.slice(0, 300).map((r) => display(r[i]).length),
      );
      ws.getColumn(i + 1).width = Math.min(60, Math.max(8, longest + 2));
    });
    if (sheet.totals?.length && sheet.rows.length) {
      const totalRow = ws.getRow(last + 1);
      totalRow.getCell(1).value = 'Total';
      totalRow.font = { bold: true };
      for (const name of sheet.totals) {
        const idx = sheet.columns.indexOf(name);
        if (idx < 0) continue;
        const letter = ws.getColumn(idx + 1).letter;
        const nums = sheet.rows.map((r) => toNumber(r[idx])).filter((n) => n !== null);
        const result = exactSum(nums);
        totalRow.getCell(idx + 1).value = { formula: `SUM(${letter}2:${letter}${last})`, result };
        totalsInfo.push({
          sheet: ws.name,
          column: name,
          cell: `${letter}${last + 1}`,
          value: result,
          counted: nums.length,
        });
      }
      totalRow.commit();
    }
    if (sheet.notes?.length) {
      const start = ws.rowCount + 2;
      sheet.notes.forEach((n, i) => (ws.getCell(start + i, 1).value = n));
    }
  }
  if (!spec.sheets.length) wb.addWorksheet('Sheet1');
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  return { buffer, totals: totalsInfo };
}

// ----------------------------------------------------------------- HTML

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
const inline = (t) => esc(t).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');

/** Horizontal bar chart as inline SVG (no scripts, prints exactly). */
export function barChartSvg({ title, labels, values }) {
  const nums = values.map((v) => toNumber(v) ?? 0);
  const max = Math.max(1, ...nums.map(Math.abs));
  const rowH = 22;
  const labelW = 170;
  const barW = 380;
  const h = labels.length * rowH + 30;
  const bars = labels
    .map((l, i) => {
      const w = Math.round((Math.abs(nums[i]) / max) * barW);
      const y = 24 + i * rowH;
      return `<text x="${labelW - 6}" y="${y + 14}" text-anchor="end" font-size="11">${esc(String(l).slice(0, 28))}</text><rect x="${labelW}" y="${y + 3}" width="${w}" height="${rowH - 8}" fill="#2f5496"/><text x="${labelW + w + 5}" y="${y + 14}" font-size="10" fill="#333">${esc(display(values[i]))}</text>`;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${labelW + barW + 90}" height="${h}" role="img" aria-label="${esc(title || 'chart')}"><text x="0" y="14" font-size="12" font-weight="bold">${esc(title || '')}</text>${bars}</svg>`;
}

export function blocksToHtml({ title, blocks, header, footer = true }) {
  const body = [];
  if (title) body.push(`<h1 class="title">${esc(title)}</h1>`);
  for (const b of blocks) {
    if (b.type === 'heading')
      body.push(
        `<h${Math.min(6, (b.level || 1) + 1)}>${inline(b.text)}</h${Math.min(6, (b.level || 1) + 1)}>`,
      );
    else if (b.type === 'paragraph')
      body.push(`<p${b.italic ? ' class="note"' : ''}>${inline(b.text)}</p>`);
    else if (b.type === 'bullets')
      body.push(`<ul>${b.items.map((i) => `<li>${inline(i)}</li>`).join('')}</ul>`);
    else if (b.type === 'table')
      body.push(
        `<table><thead><tr>${b.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${b.rows.map((r) => `<tr>${b.columns.map((_, i) => `<td>${esc(display(r[i]))}</td>`).join('')}</tr>`).join('')}</tbody></table>`,
      );
    else if (b.type === 'chart') body.push(`<figure>${barChartSvg(b)}</figure>`);
    else if (b.type === 'pagebreak') body.push('<div class="pb"></div>');
  }
  const headerCss = header
    ? `@top-right { content: "${String(header)
        .replace(/["\\\n]/g, ' ')
        .slice(0, 80)}"; font-size: 8pt; color: #666; }`
    : '';
  const footerCss = footer
    ? '@bottom-center { content: "Page " counter(page) " of " counter(pages); font-size: 8pt; color: #666; }'
    : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title || 'Document')}</title><style>
@page { size: A4; margin: 18mm 16mm 20mm; ${headerCss} ${footerCss} }
body { font-family: "Segoe UI", "Nirmala UI", "Latha", "Noto Sans Tamil", Arial, sans-serif; font-size: 10.5pt; line-height: 1.5; color: #1f2328; }
h1.title { font-size: 21pt; color: #1f3864; margin: 0 0 12pt; border-bottom: 2px solid #2f5496; padding-bottom: 6pt; }
h2 { font-size: 15pt; color: #2f5496; margin: 16pt 0 6pt; } h3 { font-size: 12.5pt; color: #2f5496; margin: 12pt 0 4pt; } h4,h5,h6 { font-size: 11pt; color: #1f3864; margin: 10pt 0 4pt; }
p { margin: 0 0 7pt; } p.note { color: #57606a; font-style: italic; } ul { margin: 0 0 8pt 18pt; padding: 0; } li { margin: 0 0 3pt; }
table { border-collapse: collapse; width: 100%; margin: 6pt 0 12pt; font-size: 8.5pt; } thead { display: table-header-group; } tr { page-break-inside: avoid; }
th { background: #d9e2f3; text-align: left; } th, td { border: 1px solid #a6a6a6; padding: 3pt 5pt; vertical-align: top; }
tbody tr:nth-child(even) td { background: #f6f8fa; } figure { margin: 8pt 0 12pt; page-break-inside: avoid; } .pb { page-break-after: always; }
</style></head><body>${body.join('\n')}</body></html>`;
}

/** Plain text / Markdown rendering of blocks. */
export function blocksToText({ title, blocks }, { markdown = false } = {}) {
  const out = title ? [markdown ? `# ${title}` : title.toUpperCase()] : [];
  for (const b of blocks) {
    if (b.type === 'heading')
      out.push(
        markdown
          ? `${'#'.repeat(Math.min(6, (b.level || 1) + 1))} ${b.text}`
          : `\n${b.text}\n${'-'.repeat(Math.min(60, b.text.length))}`,
      );
    else if (b.type === 'paragraph') out.push(b.text);
    else if (b.type === 'bullets') out.push(b.items.map((i) => `- ${i}`).join('\n'));
    else if (b.type === 'table')
      out.push(
        [
          b.columns.join(markdown ? ' | ' : '\t'),
          ...(markdown ? [b.columns.map(() => '---').join(' | ')] : []),
          ...b.rows.map((r) =>
            b.columns
              .map((_, i) => display(r[i]).replace(/\|/g, '\\|'))
              .join(markdown ? ' | ' : '\t'),
          ),
        ]
          .map((l) => (markdown ? `| ${l} |` : l))
          .join('\n'),
      );
    else if (b.type === 'chart')
      out.push(
        `${b.title || 'Chart'}:\n${b.labels.map((l, i) => `  ${l}: ${display(b.values[i])}`).join('\n')}`,
      );
  }
  return `${out.join('\n\n')}\n`;
}

// ------------------------------------------------------------------ PDF

/**
 * HTML → PDF with the local Edge/Chrome engine (correct Tamil shaping), else
 * LibreOffice. Throws CONVERTER_MISSING when neither is installed — the
 * caller decides whether to offer HTML instead; nothing is renamed to .pdf.
 */
export async function htmlToPdfLocal(
  html,
  { signal, browser = findBrowser(), soffice = findSoffice(), pdfFromHtml = browserHtmlToPdf } = {},
) {
  if (browser) {
    const pdf = await pdfFromHtml(html, { browser });
    if (pdf) return { buffer: pdf, engine: 'browser' };
  }
  if (soffice) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chanakya-html-'));
    try {
      const file = path.join(dir, 'doc.html');
      await fs.writeFile(file, html, 'utf8');
      return {
        buffer: await sofficeConvert(file, '.html', 'pdf', { soffice, signal }),
        engine: 'libreoffice',
      };
    } finally {
      fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
  throw new DocIntelError(
    'CONVERTER_MISSING',
    'Creating a PDF needs Microsoft Edge, Google Chrome or LibreOffice on this PC. None was found.',
    { status: 503 },
  );
}

// --------------------------------------------------------------- facade

/**
 * Render a document spec in `format`. Returns { buffer, ext, notes[] }.
 * @param {'docx'|'pdf'|'html'|'txt'|'md'|'json'|'xlsx'|'csv'} format
 */
export async function renderDocument(
  format,
  { title, blocks = [], sheets, header, data },
  options = {},
) {
  const notes = [];
  switch (format) {
    case 'docx':
      if (blocks.some((b) => b.type === 'chart'))
        notes.push('Charts are written as data tables in Word files.');
      return { buffer: toDocx({ title, blocks, header, pageNumbers: true }), ext: 'docx', notes };
    case 'pdf': {
      const { buffer, engine } = await htmlToPdfLocal(
        blocksToHtml({ title, blocks, header }),
        options,
      );
      if (engine === 'libreoffice')
        notes.push('PDF created with LibreOffice; page numbers may not appear.');
      return { buffer, ext: 'pdf', notes };
    }
    case 'html':
      return {
        buffer: Buffer.from(blocksToHtml({ title, blocks, header, footer: false }), 'utf8'),
        ext: 'html',
        notes,
      };
    case 'txt':
      return { buffer: Buffer.from(blocksToText({ title, blocks }), 'utf8'), ext: 'txt', notes };
    case 'md':
      return {
        buffer: Buffer.from(blocksToText({ title, blocks }, { markdown: true }), 'utf8'),
        ext: 'md',
        notes,
      };
    case 'json':
      return {
        buffer: Buffer.from(JSON.stringify(data ?? { title, blocks }, null, 2), 'utf8'),
        ext: 'json',
        notes,
      };
    case 'xlsx': {
      const sheetsSpec =
        sheets ||
        blocks
          .filter((b) => b.type === 'table')
          .map((b, i) => ({ name: b.name || `Table ${i + 1}`, columns: b.columns, rows: b.rows }));
      if (!sheetsSpec.length)
        throw new DocIntelError('NO_TABLES', 'There is no table data to put in a spreadsheet.');
      const { buffer, totals } = await writeXlsx({ sheets: sheetsSpec });
      if (blocks.some((b) => b.type === 'chart'))
        notes.push('Charts are not added to Excel files; the chart data is in the sheet.');
      return { buffer, ext: 'xlsx', notes, totals };
    }
    case 'csv': {
      const sheet = sheets?.[0] || blocks.find((b) => b.type === 'table');
      if (!sheet)
        throw new DocIntelError('NO_TABLES', 'There is no table data to put in a CSV file.');
      if ((sheets?.length || 0) > 1) notes.push('CSV holds one table; only the first was written.');
      return {
        buffer: toCsv({ columns: sheet.columns, rows: sheet.rows.map((r) => r.map(display)) }),
        ext: 'csv',
        notes,
      };
    }
    default:
      throw new DocIntelError(
        'UNSUPPORTED_FORMAT',
        `Cannot create ${String(format).toUpperCase()} files.`,
      );
  }
}
