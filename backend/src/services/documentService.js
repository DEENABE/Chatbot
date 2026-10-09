import fs from 'node:fs/promises';
import path from 'node:path';
import pdf from 'pdf-parse';
import mammoth from 'mammoth';
import readXlsxFile from 'read-excel-file/node';
import { ValidationError } from '../lib/validate.js';

const allowed = new Set(['.pdf', '.docx', '.xlsx', '.csv', '.txt', '.md']);
const MIME_TYPES = {
  '.pdf': ['application/pdf'],
  '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  '.xlsx': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  '.csv': ['text/csv', 'application/csv', 'application/vnd.ms-excel', 'text/plain'],
  '.txt': ['text/plain'],
  '.md': ['text/markdown', 'text/x-markdown', 'text/plain'],
};

export function sanitizeDocumentName(filename) {
  const name = String(filename || '')
    .split(/[\\/]/)
    .at(-1)
    .replace(/[\x00-\x1f\x7f<>:"|?*]/g, '_')
    .trim();
  if (!name || name === '.' || name === '..' || name.length > 255)
    throw new ValidationError('Filename is invalid or too long.');
  return name;
}

export function validateDocumentMime(filename, mimeType) {
  const extension = path.extname(filename).toLowerCase();
  const mime = String(mimeType || '')
    .toLowerCase()
    .split(';', 1)[0];
  if (
    mime &&
    mime !== 'application/octet-stream' &&
    !(MIME_TYPES[extension] || []).includes(mime)
  ) {
    throw new ValidationError('File type does not match its filename.');
  }
  return (MIME_TYPES[extension] || ['application/octet-stream'])[0];
}

// Client-supplied MIME type and extension are both just labels — this is
// what the bytes on disk actually start with. .docx/.xlsx are ZIP
// containers so they share a signature; a renamed .exe/.dll/etc. cannot
// produce these regardless of what extension it's given (Step 5: don't
// trust the client-provided MIME type / extension alone).
const ZIP_SIGNATURES = [
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from([0x50, 0x4b, 0x05, 0x06]),
  Buffer.from([0x50, 0x4b, 0x07, 0x08]),
];
const BINARY_SIGNATURES = {
  '.pdf': [Buffer.from('%PDF-', 'ascii')],
  '.docx': ZIP_SIGNATURES,
  '.xlsx': ZIP_SIGNATURES,
};
// .csv/.txt/.md have no magic number — instead reject content that isn't
// plausibly text (a NUL byte in the first few KB is a strong signal of a
// binary file wearing a text extension; real text files never contain one).
const TEXT_EXTENSIONS = new Set(['.csv', '.txt', '.md']);

export function isSupportedDocument(filename) {
  return allowed.has(path.extname(filename).toLowerCase());
}

export async function assertFileContentMatchesExtension(filePath, extension) {
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
      if (extension === '.docx' || extension === '.xlsx')
        await assertOfficeContainer(filePath, extension);
      return;
    }
    if (TEXT_EXTENSIONS.has(extension) && head.includes(0)) {
      throw new ValidationError(`File content does not look like a text ${extension} file.`);
    }
  } finally {
    await handle.close();
  }
}

// Read central-directory sizes without decompressing the archive. This keeps
// a small compressed Office upload from expanding without a resource bound.
async function assertOfficeContainer(filePath, extension) {
  const archive = await fs.readFile(filePath);
  let end = -1;
  for (let i = archive.length - 22; i >= Math.max(0, archive.length - 65557); i--) {
    if (archive.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new ValidationError('Office document archive is damaged.');
  const entries = archive.readUInt16LE(end + 10);
  let cursor = archive.readUInt32LE(end + 16),
    expanded = 0;
  const names = new Set();
  if (entries === 65535 || entries > 10000)
    throw new ValidationError('Office document has too many archive entries.');
  for (let i = 0; i < entries; i++) {
    if (cursor + 46 > archive.length || archive.readUInt32LE(cursor) !== 0x02014b50)
      throw new ValidationError('Office document archive is damaged.');
    if (archive.readUInt16LE(cursor + 8) & 1)
      throw new ValidationError('Encrypted Office documents are unsupported.');
    expanded += archive.readUInt32LE(cursor + 24);
    if (expanded > 100 * 1024 * 1024)
      throw new ValidationError('Office document expands beyond the safe processing limit.');
    const length = archive.readUInt16LE(cursor + 28),
      extra = archive.readUInt16LE(cursor + 30),
      comment = archive.readUInt16LE(cursor + 32);
    if (cursor + 46 + length + extra + comment > archive.length)
      throw new ValidationError('Office document archive is damaged.');
    names.add(archive.subarray(cursor + 46, cursor + 46 + length).toString('utf8'));
    cursor += 46 + length + extra + comment;
  }
  const required = extension === '.docx' ? 'word/document.xml' : 'xl/workbook.xml';
  if (!names.has('[Content_Types].xml') || !names.has(required))
    throw new ValidationError(`File content does not match its ${extension} extension.`);
}

export async function extractDocument(file) {
  const extension = path.extname(file.originalname).toLowerCase();
  if (!allowed.has(extension)) {
    throw new ValidationError(`Unsupported file type: ${extension || 'unknown'}`);
  }
  await assertFileContentMatchesExtension(file.path, extension);

  if (extension === '.pdf') {
    const result = await pdf(Uint8Array.from(await fs.readFile(file.path)));
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
      output.push(
        `Sheet: ${sheet.name}\n${rows.map((row) => row.map(formatCell).join(',')).join('\n')}`,
      );
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
