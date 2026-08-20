import fs from 'node:fs/promises';
import path from 'node:path';
import pdf from 'pdf-parse';
import mammoth from 'mammoth';
import readXlsxFile from 'read-excel-file/node';
import { ValidationError } from '../lib/validate.js';

const allowed = new Set(['.pdf', '.docx', '.xlsx', '.csv', '.txt', '.md']);

// Client-supplied MIME type and extension are both just labels — this is
// what the bytes on disk actually start with. .docx/.xlsx are ZIP
// containers so they share a signature; a renamed .exe/.dll/etc. cannot
// produce these regardless of what extension it's given (Step 5: don't
// trust the client-provided MIME type / extension alone).
const ZIP_SIGNATURES = [
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from([0x50, 0x4b, 0x05, 0x06]),
  Buffer.from([0x50, 0x4b, 0x07, 0x08])
];
const BINARY_SIGNATURES = {
  '.pdf': [Buffer.from('%PDF-', 'ascii')],
  '.docx': ZIP_SIGNATURES,
  '.xlsx': ZIP_SIGNATURES
};
// .csv/.txt/.md have no magic number — instead reject content that isn't
// plausibly text (a NUL byte in the first few KB is a strong signal of a
// binary file wearing a text extension; real text files never contain one).
const TEXT_EXTENSIONS = new Set(['.csv', '.txt', '.md']);

export function isSupportedDocument(filename) {
  return allowed.has(path.extname(filename).toLowerCase());
}

async function assertFileContentMatchesExtension(filePath, extension) {
  const signatures = BINARY_SIGNATURES[extension];
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const head = buffer.subarray(0, bytesRead);

    if (signatures) {
      const matches = signatures.some((sig) => head.subarray(0, sig.length).equals(sig));
      if (!matches) {
        throw new ValidationError(`File content does not match its ${extension} extension.`);
      }
      return;
    }
    if (TEXT_EXTENSIONS.has(extension) && head.includes(0)) {
      throw new ValidationError(`File content does not look like a text ${extension} file.`);
    }
  } finally {
    await handle.close();
  }
}

export async function extractDocument(file) {
  const extension = path.extname(file.originalname).toLowerCase();
  if (!allowed.has(extension)) {
    throw new ValidationError(`Unsupported file type: ${extension || 'unknown'}`);
  }
  await assertFileContentMatchesExtension(file.path, extension);

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
