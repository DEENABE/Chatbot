// Pure helpers for showing GitHub-style markdown tables as real data tables.
//
// The chat renderer (react-markdown without the GFM plugin) does not know
// tables: a "| a | b |" block collapses into one run-on paragraph. Instead of
// adding a dependency, the message text is split into plain-text segments and
// table segments; text still goes through react-markdown, tables go to the
// DataTable component.

const SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const FENCE = /^\s*(```|~~~)/;

function splitRow(line) {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
  return text.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

function alignOf(cell) {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return null;
}

function fit(cells, width) {
  const row = cells.slice(0, width);
  while (row.length < width) row.push('');
  return row;
}

/**
 * Splits markdown into [{type:"text", text}] and
 * [{type:"table", header, aligns, rows}] segments, in order.
 * Tables inside fenced code blocks are left alone.
 */
export function splitMarkdownTables(content) {
  const lines = String(content ?? '')
    .split('\n')
    .map((line) => line.replace(/\r$/, ''));
  const segments = [];
  let buffer = [];
  let fenced = false;

  const flush = () => {
    if (buffer.length) segments.push({ type: 'text', text: buffer.join('\n') });
    buffer = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE.test(line)) {
      fenced = !fenced;
      buffer.push(line);
      continue;
    }
    if (
      !fenced &&
      line.includes('|') &&
      i + 1 < lines.length &&
      SEPARATOR.test(lines[i + 1]) &&
      splitRow(line).length >= 2 &&
      // GFM: the delimiter row must have as many cells as the header row.
      splitRow(lines[i + 1]).length === splitRow(line).length
    ) {
      const header = splitRow(line);
      const aligns = fit(splitRow(lines[i + 1]).map(alignOf), header.length);
      const rows = [];
      let j = i + 2;
      while (j < lines.length && lines[j].trim() && lines[j].includes('|')) {
        rows.push(fit(splitRow(lines[j]), header.length));
        j++;
      }
      flush();
      segments.push({ type: 'table', header, aligns, rows });
      i = j - 1;
      continue;
    }
    buffer.push(line);
  }
  flush();
  return segments;
}

export function hasMarkdownTable(content) {
  return splitMarkdownTables(content).some((segment) => segment.type === 'table');
}

// ---------- cell helpers used by the table component ----------
const NUMBER = /^[-+]?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?%?$/;

export function isNumericCell(value) {
  const text = String(value ?? '').replace(/[₹$€£\s]/g, '');
  return NUMBER.test(text);
}

export function toComparableNumber(value) {
  return Number(String(value ?? '').replace(/[₹$€£,%\s]/g, ''));
}

// Columns that look like identifiers must never get thousands separators.
const IDENTIFIER_HEADER =
  /phone|mobile|contact|\bid\b|code|\bpin\b|zip|year|aadhaar|account|number|\bno\.?\b|#/i;

/** Display form of a cell: groups big plain numbers (72000 → 72,000). */
export function formatCell(header, value, numericColumn) {
  const text = String(value ?? '');
  if (!numericColumn || IDENTIFIER_HEADER.test(header || '')) return text;
  if (!/^[-+]?\d+(\.\d+)?$/.test(text) || /^[-+]?0\d/.test(text)) return text;
  const number = Number(text);
  if (!Number.isFinite(number) || Math.abs(number) < 1000) return text;
  const decimals = text.includes('.') ? text.split('.')[1].length : 0;
  return number.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function compareCells(a, b) {
  const aText = String(a ?? '');
  const bText = String(b ?? '');
  if (aText === '' && bText !== '') return 1; // blanks always last
  if (bText === '' && aText !== '') return -1;
  if (isNumericCell(aText) && isNumericCell(bText)) {
    return toComparableNumber(aText) - toComparableNumber(bText);
  }
  return aText.localeCompare(bText, undefined, { numeric: true, sensitivity: 'base' });
}

function csvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

/** CSV with a BOM so Excel opens Tamil / ₹ text correctly. */
export function tableToCsv(header, rows) {
  return '﻿' + [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
}

/** Tab-separated text: pastes straight into Excel / Sheets cells. */
export function tableToTsv(header, rows) {
  const clean = (value) => String(value ?? '').replace(/[\t\r\n]+/g, ' ');
  return [header, ...rows].map((row) => row.map(clean).join('\t')).join('\n');
}
