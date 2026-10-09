// Turns spreadsheets (XLSX / CSV) and DOCX tables into real tables:
// { name, columns: string[], rows: string[][] }.
//
// Why: the old pipeline flattened a workbook into one CSV string and chunked
// it. Only the first chunk carried the header row, so a chunk like
// "Ravi,Chennai,2023-04-01,TCS" reached the LLM with no idea which value was
// the city or the joining date. Keeping rows + column names lets us (1) look
// up exact rows by keyword, (2) compute counts/filters over ALL rows, and
// (3) embed self-describing "Column: value" row text.
import fs from 'node:fs/promises';
import readXlsxFile from 'read-excel-file/node';
import mammoth from 'mammoth';
import { ValidationError } from '../lib/validate.js';

const MAX_ROWS_PER_TABLE = 200_000;
const MAX_COLUMNS = 200;

export function formatValue(value) {
  if (value == null) return '';
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '';
    const iso = value.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.slice(0, 16).replace('T', ' ');
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    return Number.isInteger(value) ? String(value) : String(Math.round(value * 1e6) / 1e6);
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value).replace(/\s+/g, ' ').trim();
}

const NUMERIC_LIKE = /^[-+]?[\d.,\s:/%₹$-]+$/;

function isHeaderCandidate(row, maxFilled) {
  const filled = row.filter((cell) => cell !== '');
  if (filled.length < Math.max(2, Math.ceil(maxFilled * 0.6))) return false;
  const textual = filled.filter((cell) => !NUMERIC_LIKE.test(cell)).length;
  if (textual / filled.length < 0.8) return false;
  const unique = new Set(filled.map((cell) => cell.toLowerCase()));
  return unique.size === filled.length;
}

/** Builds a table from a raw 2-D matrix (cells may be any type). */
export function buildTable(name, matrix) {
  if ((matrix?.length || 0) > MAX_ROWS_PER_TABLE + 20)
    throw new ValidationError('Spreadsheet contains too many rows to index safely.');
  if ((matrix || []).some((row) => row.length > MAX_COLUMNS))
    throw new ValidationError('Spreadsheet contains too many columns to index safely.');
  const rows = (matrix || [])
    .slice(0, MAX_ROWS_PER_TABLE + 20)
    .map((row) => (row || []).slice(0, MAX_COLUMNS).map(formatValue))
    .filter((row) => row.some((cell) => cell !== ''));
  if (rows.length < 2) return null;

  // Header = first row (within the first 10) that looks like column titles.
  // Skips report titles such as "Employee Master – 2024" in row 1.
  const probe = rows.slice(0, 10);
  const maxFilled = Math.max(...probe.map((row) => row.filter((c) => c !== '').length));
  let headerIndex = probe.findIndex((row) => isHeaderCandidate(row, maxFilled));
  if (headerIndex < 0) headerIndex = 0;

  const header = rows[headerIndex];
  const body = rows.slice(headerIndex + 1);
  let width = body.reduce((max, row) => Math.max(max, row.length), header.length);
  // Drop trailing columns that are empty everywhere.
  while (width > 0 && header[width - 1] === '' && !body.some((r) => (r[width - 1] ?? '') !== ''))
    width -= 1;
  if (width < 1) return null;

  // Drop columns that are empty everywhere (no title and no data), e.g. a spare
  // leading column — otherwise it shows up as an empty "Column 1" in answers.
  const keep = [];
  for (let i = 0; i < width; i++) {
    if ((header[i] ?? '') !== '' || body.some((r) => (r[i] ?? '') !== '')) keep.push(i);
  }
  if (!keep.length) return null;

  const seen = new Map();
  const columns = [];
  for (const i of keep) {
    let title = header[i] || `Column ${i + 1}`;
    const key = title.toLowerCase();
    const count = seen.get(key) || 0;
    seen.set(key, count + 1);
    if (count) title = `${title} ${count + 1}`;
    columns.push(title);
  }

  const headerKey = keep
    .map((i) => header[i] ?? '')
    .join('\u0001')
    .toLowerCase();
  const data = [];
  for (const row of body) {
    const cells = keep.map((i) => row[i] ?? '');
    if (!cells.some((c) => c !== '')) continue;
    if (cells.join('\u0001').toLowerCase() === headerKey) continue; // repeated header
    if (data.length >= MAX_ROWS_PER_TABLE)
      throw new ValidationError('Spreadsheet contains too many rows to index safely.');
    data.push(cells);
  }
  if (!data.length) return null;
  return { name: String(name || 'Sheet1'), columns, rows: data };
}

/** RFC-4180-ish CSV parser with delimiter auto-detection (, ; tab |). */
export function parseCsv(text) {
  const source = String(text || '').replace(/^\uFEFF/, '');
  const firstLine = source.split(/\r?\n/, 1)[0] || '';
  const [bestDelimiter, bestCount] = [',', ';', '\t', '|']
    .map((d) => [d, firstLine.split(d).length - 1])
    .sort((a, b) => b[1] - a[1])[0];
  const delimiter = bestCount > 0 ? bestDelimiter : ',';

  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell === '') quoted = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export async function parseSpreadsheet(filePath, extension) {
  if (extension === '.csv') {
    const table = buildTable('CSV', parseCsv(await fs.readFile(filePath, 'utf8')));
    return table ? [table] : [];
  }
  const sheets = await readXlsxFile(filePath, { getSheets: true });
  const tables = [];
  for (const sheet of sheets) {
    const matrix = await readXlsxFile(filePath, { sheet: sheet.name });
    const table = buildTable(sheet.name, matrix);
    if (table) tables.push(table);
  }
  return tables;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function htmlToText(html) {
  return html
    .replace(/<br\s*\/?>|<\/p>|<\/li>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (match, entity) => {
      if (entity[0] === '#') {
        const code =
          entity[1].toLowerCase() === 'x'
            ? parseInt(entity.slice(2), 16)
            : parseInt(entity.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      return ENTITIES[entity.toLowerCase()] ?? match;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

/** Extracts tables (>= 2 rows and >= 2 columns) from a .docx file. */
export async function parseDocxTables(filePath) {
  const { value: html } = await mammoth.convertToHtml({ path: filePath });
  const tables = [];
  const tableMatches = html.match(/<table[\s\S]*?<\/table>/gi) || [];
  tableMatches.forEach((tableHtml, index) => {
    const matrix = (tableHtml.match(/<tr[\s\S]*?<\/tr>/gi) || []).map((tr) =>
      (tr.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) || []).map(htmlToText),
    );
    if (matrix.length < 2 || Math.max(...matrix.map((r) => r.length)) < 2) return;
    const table = buildTable(`Table ${index + 1}`, matrix);
    if (table) tables.push(table);
  });
  return tables;
}

export function rowToText(columns, row) {
  return columns
    .map((column, i) => (row[i] ? `${column}: ${row[i]}` : null))
    .filter(Boolean)
    .join(' | ');
}

/**
 * Self-describing chunks for embedding: every chunk repeats the file, sheet
 * and column names, and each row is written as "Column: value" pairs.
 * Rows-per-chunk grows with sheet size so even 50k-row sheets stay well under
 * MAX_CHUNKS (keyword search + the query planner still see every row).
 */
export function tableToChunks(filename, table, { maxChars = 2400 } = {}) {
  const perChunk = Math.max(5, Math.ceil(table.rows.length / 400));
  const head = `File: ${filename} | Sheet: ${table.name}\nColumns: ${table.columns.join(', ')}`;
  const chunks = [];
  let lines = [];
  let size = head.length;
  const flush = () => {
    if (lines.length) chunks.push(`${head}\n${lines.join('\n')}`);
    lines = [];
    size = head.length;
  };
  table.rows.forEach((row, index) => {
    const line = `Row ${index + 1} | ${rowToText(table.columns, row)}`;
    if (lines.length >= perChunk || (lines.length && size + line.length > maxChars)) flush();
    lines.push(line.length > maxChars ? line.slice(0, maxChars) : line);
    size += line.length + 1;
  });
  flush();
  return chunks;
}
