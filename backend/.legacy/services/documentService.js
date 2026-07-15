import fs from 'node:fs/promises';
import path from 'node:path';
import pdf from 'pdf-parse';
import mammoth from 'mammoth';
import readXlsxFile from 'read-excel-file/node';

const allowed = new Set(['.pdf', '.docx', '.xlsx', '.csv', '.txt', '.md']);

export function isSupportedDocument(filename) {
  return allowed.has(path.extname(filename).toLowerCase());
}

export async function extractDocument(file) {
  const extension = path.extname(file.originalname).toLowerCase();
  if (!allowed.has(extension)) {
    throw new Error(`Unsupported file type: ${extension || 'unknown'}`);
  }

  if (extension === '.pdf') {
    const result = await pdf(await fs.readFile(file.path));
    return result.text;
  }
  if (extension === '.docx') {
    const result = await mammoth.extractRawText({ path: file.path });
    return result.value;
  }
  if (extension === '.xlsx') {
    const sheets = await readXlsxFile(file.path, { getSheets: true });
    const output = [];
    for (const sheet of sheets) {
      const rows = await readXlsxFile(file.path, { sheet: sheet.name });
      output.push(`Sheet: ${sheet.name}\n${rows.map((row) => row.map(formatCell).join(',')).join('\n')}`);
    }
    return output.join('\n\n');
  }
  if (extension === '.csv') {
    return fs.readFile(file.path, 'utf8');
  }
  return fs.readFile(file.path, 'utf8');
}

function formatCell(value) {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
