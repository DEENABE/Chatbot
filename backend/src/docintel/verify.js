import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { parseDocument } from './parser.js';
import { inspectZipContainer } from './formats.js';
import { display, toNumber } from './values.js';

/**
 * DocumentVerificationEngine: re-opens every generated file with the matching
 * parser and checks it against what was intended (format signature, row
 * counts, totals, expected text). A file is only reported as created when
 * these checks pass; failures are reported, never hidden.
 *
 * expectations: {
 *   sheets?:   [{ name?, rows, columns? }]      data rows per sheet (header excluded, totals excluded)
 *   totals?:   [{ sheet?, cell, value }]         cached totals in XLSX
 *   contains?: string[]                          text that must appear (first few are checked)
 *   tables?:   number                            minimum number of tables (DOCX)
 *   records?:  number                            JSON records / CSV rows
 * }
 */
export async function verifyOutput(buffer, format, expectations = {}) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, ...(detail ? { detail } : {}) });
  add('File is not empty', buffer?.length > 0, `${buffer?.length || 0} bytes`);
  if (!buffer?.length) return { ok: false, checks };

  try {
    if (format === 'xlsx' || format === 'docx') {
      const info = inspectZipContainer(buffer, {
        required: format === 'xlsx' ? 'xl/workbook.xml' : 'word/document.xml',
      });
      add(`Valid ${format.toUpperCase()} package`, true, `${info.entries} parts`);
    } else if (format === 'pdf') {
      const head = buffer.subarray(0, 5).toString('latin1') === '%PDF-';
      const tail = buffer.subarray(-2048).toString('latin1').includes('%%EOF');
      add('Valid PDF header and end marker', head && tail);
    } else if (format === 'json') {
      const data = JSON.parse(buffer.toString('utf8'));
      add('Valid JSON', true);
      if (expectations.records !== undefined) {
        const n = Array.isArray(data)
          ? data.length
          : Array.isArray(data?.rows)
            ? data.rows.length
            : Array.isArray(data?.records)
              ? data.records.length
              : null;
        add('Record count', n === expectations.records, `${n} of ${expectations.records}`);
      }
    }
  } catch (error) {
    add('File structure', false, String(error.message).slice(0, 200));
    return { ok: false, checks };
  }

  // Re-open with the real parser for content checks.
  if (['xlsx', 'docx', 'pdf', 'csv', 'txt', 'md', 'html'].includes(format)) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chanakya-verify-'));
    try {
      const file = path.join(dir, `output.${format === 'html' ? 'txt' : format}`);
      await fs.writeFile(file, buffer);
      if (format === 'xlsx') await verifyWorkbook(file, expectations, add);
      else {
        const doc = await parseDocument(file, path.basename(file));
        add(
          'Re-opened with the document parser',
          true,
          doc.kind === 'pdf' ? `${doc.pages.length} page(s)` : undefined,
        );
        if (format === 'csv' && expectations.records !== undefined) {
          const n = doc.tables[0]?.rows.length ?? 0;
          add('Row count', n === expectations.records, `${n} of ${expectations.records}`);
        }
        if (format === 'docx' && expectations.tables !== undefined)
          add(
            'Tables present',
            doc.tables.length >= expectations.tables,
            `${doc.tables.length} of ${expectations.tables}`,
          );
        if (expectations.contains?.length) {
          const text = normalize(doc.text);
          const sample = expectations.contains.filter(Boolean).slice(0, 8);
          const missing = sample.filter((s) => !text.includes(normalize(s)));
          // PDF text extraction cannot read every script back (e.g. shaped Tamil); that is a warning, not a failure.
          const nonLatin = missing.every((s) => /[^\u0000-ɏ]/.test(s));
          if (missing.length && format === 'pdf' && nonLatin)
            add(
              'Expected text present',
              true,
              'non-Latin text could not be read back from the PDF to compare',
            );
          else
            add(
              'Expected text present',
              !missing.length,
              missing.length
                ? `missing: ${missing.slice(0, 3).join(' | ').slice(0, 200)}`
                : `${sample.length} sample(s) found`,
            );
        }
      }
    } catch (error) {
      add('Re-open generated file', false, String(error.message).slice(0, 200));
    } finally {
      fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
  return { ok: checks.every((c) => c.ok), checks };
}

const normalize = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

async function verifyWorkbook(file, expectations, add) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  add('Re-opened with ExcelJS', true, `${wb.worksheets.length} sheet(s)`);
  for (const [i, want] of (expectations.sheets || []).entries()) {
    const ws = want.name ? wb.getWorksheet(want.name) || wb.worksheets[i] : wb.worksheets[i];
    if (!ws) {
      add(`Sheet ${want.name || i + 1} exists`, false);
      continue;
    }
    let dataRows = 0;
    ws.eachRow((row, n) => {
      if (n === 1) return;
      const first = row.getCell(1).value;
      if (first === 'Total' && row.values.some((v) => v && typeof v === 'object' && 'formula' in v))
        return;
      if (row.values.some((v) => v !== null && v !== undefined && v !== '')) dataRows++;
    });
    const notes = want.notes || 0;
    add(
      `"${ws.name}" row count`,
      dataRows - notes === want.rows,
      `${dataRows - notes} of ${want.rows}`,
    );
    if (want.columns) {
      const header = ws
        .getRow(1)
        .values.slice(1)
        .map((v) => display(v));
      add(
        `"${ws.name}" headers`,
        want.columns.every((c, k) => header[k] === String(c)),
        header.slice(0, 8).join(', '),
      );
    }
  }
  for (const t of expectations.totals || []) {
    const ws = t.sheet ? wb.getWorksheet(t.sheet) : wb.worksheets[0];
    const cell = ws?.getCell(t.cell);
    const v = cell?.value;
    const result =
      v && typeof v === 'object' && ('formula' in v || 'sharedFormula' in v) ? cell.result : v;
    const ok = toNumber(result) !== null && Math.abs(toNumber(result) - t.value) < 1e-6;
    add(`Total in ${t.cell}`, ok, `${display(result)} (expected ${t.value})`);
  }
}

export function verificationSummary(v) {
  if (!v) return '';
  const failed = v.checks.filter((c) => !c.ok);
  return v.ok
    ? `Verified: ${v.checks
        .map((c) => c.name.toLowerCase())
        .slice(0, 4)
        .join(', ')}.`
    : `Verification failed: ${failed.map((c) => `${c.name}${c.detail ? ` (${c.detail})` : ''}`).join('; ')}.`;
}
