import fs from 'node:fs/promises';
import path from 'node:path';
import { DocIntelError } from './errors.js';

/**
 * Supported formats, their signatures and processing limits. Extension, client
 * MIME type and the bytes on disk must all agree before a file is parsed.
 */

export const LIMITS = Object.freeze({
  maxFileBytes: Number(process.env.DOCINTEL_MAX_FILE_MB || 25) * 1024 * 1024,
  maxExpandedBytes: 150 * 1024 * 1024, // decompressed size of an Office (ZIP) container
  maxArchiveEntries: 10_000,
  maxCompressionRatio: 200, // a single entry expanding more than this is treated as a zip bomb
  maxRows: 200_000,
  maxColumns: 500,
  maxPdfPages: 2_000,
  parseTimeoutMs: 120_000,
  convertTimeoutMs: 180_000,
  pageSize: 50, // rows shown per page in chat; the total is always reported
  maxPageSize: 500,
});

const ZIP = [Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from([0x50, 0x4b, 0x05, 0x06])];
const OLE = [Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])];

/**
 * kind:  spreadsheet | pdf | word | text | json
 * native: parsed in-process. converted: needs LibreOffice first (legacy binary formats).
 */
export const FORMATS = Object.freeze({
  '.pdf': {
    kind: 'pdf',
    mime: 'application/pdf',
    signatures: [Buffer.from('%PDF-')],
    native: true,
  },
  '.docx': {
    kind: 'word',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    signatures: ZIP,
    zipRequired: 'word/document.xml',
    native: true,
  },
  '.doc': {
    kind: 'word',
    mime: 'application/msword',
    signatures: OLE,
    native: false,
    via: '.docx',
  },
  '.xlsx': {
    kind: 'spreadsheet',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    signatures: ZIP,
    zipRequired: 'xl/workbook.xml',
    native: true,
  },
  '.xlsm': {
    kind: 'spreadsheet',
    mime: 'application/vnd.ms-excel.sheet.macroEnabled.12',
    signatures: ZIP,
    zipRequired: 'xl/workbook.xml',
    native: true,
  },
  '.xls': {
    kind: 'spreadsheet',
    mime: 'application/vnd.ms-excel',
    signatures: OLE,
    native: false,
    via: '.xlsx',
  },
  '.csv': { kind: 'spreadsheet', mime: 'text/csv', text: true, native: true },
  '.tsv': { kind: 'spreadsheet', mime: 'text/tab-separated-values', text: true, native: true },
  '.txt': { kind: 'text', mime: 'text/plain', text: true, native: true },
  '.md': { kind: 'text', mime: 'text/markdown', text: true, native: true },
  '.json': { kind: 'json', mime: 'application/json', text: true, native: true },
});

export const OUTPUT_MIME = Object.freeze({
  pdf: 'application/pdf',
  docx: FORMATS['.docx'].mime,
  xlsx: FORMATS['.xlsx'].mime,
  csv: 'text/csv; charset=utf-8',
  tsv: 'text/tab-separated-values; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  html: 'text/html; charset=utf-8',
  json: 'application/json; charset=utf-8',
});

export const extOf = (name) => path.extname(String(name || '')).toLowerCase();
export const formatOf = (name) => FORMATS[extOf(name)] || null;

/** Basename only, no control/reserved characters, no leading dots, Windows reserved names avoided. */
export function safeFileName(name, fallback = 'document') {
  let base = String(name ?? '')
    .split(/[\\/]/)
    .at(-1)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f<>:"|?*]/g, '_')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
    .trim()
    .slice(0, 150);
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(base)) base = `_${base}`;
  return base || fallback;
}

/** Replaces the extension with `ext` (no dot), keeping a safe base name. */
export function withExtension(name, ext) {
  const safe = safeFileName(name);
  const base = safe.slice(0, safe.length - path.extname(safe).length) || 'document';
  return `${base}.${String(ext).replace(/^\./, '')}`;
}

/** `child` must resolve inside `root` (no traversal, no absolute escapes). */
export function assertInside(root, child) {
  const r = path.resolve(root);
  const c = path.resolve(r, child);
  const rel = path.relative(r, c);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel))
    throw new DocIntelError('UNSAFE_PATH', 'The file path is not allowed.', { status: 400 });
  return c;
}

function startsWithAny(head, signatures) {
  return signatures.some((sig) => head.subarray(0, sig.length).equals(sig));
}

/**
 * Inspect an Office ZIP container without decompressing it: entry count,
 * declared expanded size, compression ratio, unsafe entry names, and active
 * content (macros, external links, embedded objects) which is never executed.
 */
export function inspectZipContainer(buffer, { required } = {}) {
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65_557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0)
    throw new DocIntelError('CORRUPT_FILE', 'The file is damaged (its ZIP directory is missing).');
  const entries = buffer.readUInt16LE(end + 10);
  if (entries === 0xffff || entries > LIMITS.maxArchiveEntries)
    throw new DocIntelError(
      'UNSAFE_ARCHIVE',
      'The document has too many internal parts to process safely.',
    );
  let cursor = buffer.readUInt32LE(end + 16);
  let expanded = 0;
  const names = [];
  for (let i = 0; i < entries; i++) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50)
      throw new DocIntelError('CORRUPT_FILE', 'The file is damaged (bad ZIP entry).');
    if (buffer.readUInt16LE(cursor + 8) & 1)
      throw new DocIntelError(
        'ENCRYPTED',
        'Password-protected documents are not supported. Remove the password and upload again.',
      );
    const compressed = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    expanded += size;
    if (expanded > LIMITS.maxExpandedBytes)
      throw new DocIntelError(
        'UNSAFE_ARCHIVE',
        'The document expands beyond the safe processing limit.',
      );
    if (size > 1024 * 1024 && compressed > 0 && size / compressed > LIMITS.maxCompressionRatio)
      throw new DocIntelError(
        'UNSAFE_ARCHIVE',
        'The document looks like a compression bomb and was not opened.',
      );
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extra = buffer.readUInt16LE(cursor + 30);
    const comment = buffer.readUInt16LE(cursor + 32);
    if (cursor + 46 + nameLength + extra + comment > buffer.length)
      throw new DocIntelError('CORRUPT_FILE', 'The file is damaged (truncated ZIP directory).');
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    if (name.includes('..') || name.startsWith('/') || /^[a-z]:/i.test(name) || name.includes('\\'))
      throw new DocIntelError('UNSAFE_ARCHIVE', 'The document contains an unsafe internal path.');
    names.push(name);
    cursor += 46 + nameLength + extra + comment;
  }
  if (!names.includes('[Content_Types].xml') || (required && !names.includes(required)))
    throw new DocIntelError('TYPE_MISMATCH', 'The file content does not match its extension.');
  return {
    entries: names.length,
    expandedBytes: expanded,
    macros: names.some((n) => /vbaProject\.bin$/i.test(n)),
    externalLinks: names.some((n) => /externalLinks\//i.test(n)),
    embeddedObjects: names.some((n) => /\/embeddings\//i.test(n) || /oleObject/i.test(n)),
  };
}

/**
 * Validates a file on disk: allowed extension, size, MIME label, signature and
 * container safety. Returns { ext, format, size, container? }.
 */
export async function validateFile(filePath, originalName, { mime } = {}) {
  const ext = extOf(originalName);
  const format = FORMATS[ext];
  if (!format)
    throw new DocIntelError(
      'UNSUPPORTED_FORMAT',
      `"${ext || 'no extension'}" files are not supported. Supported: ${Object.keys(FORMATS).join(', ')}.`,
    );
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    throw new DocIntelError('NOT_FOUND', 'The file is no longer available. Upload it again.', {
      status: 404,
    });
  }
  if (!stat.isFile())
    throw new DocIntelError('NOT_FOUND', 'The file is no longer available.', { status: 404 });
  if (stat.size === 0) throw new DocIntelError('EMPTY_FILE', 'The file is empty.');
  if (stat.size > LIMITS.maxFileBytes)
    throw new DocIntelError(
      'TOO_LARGE',
      `The file is larger than ${Math.round(LIMITS.maxFileBytes / 1048576)} MB.`,
      { status: 413 },
    );
  const label = String(mime || '')
    .toLowerCase()
    .split(';', 1)[0];
  if (
    label &&
    label !== 'application/octet-stream' &&
    !label.startsWith('text/') &&
    format.text === undefined
  ) {
    const okLabels = [
      format.mime,
      'application/zip',
      'application/x-zip-compressed',
      'application/x-ole-storage',
      'application/vnd.ms-office',
    ];
    if (!okLabels.includes(label))
      throw new DocIntelError('TYPE_MISMATCH', 'The file type does not match its filename.');
  }
  const handle = await fs.open(filePath, 'r');
  let head;
  try {
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    head = buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  if (format.signatures && !startsWithAny(head, format.signatures))
    throw new DocIntelError(
      'TYPE_MISMATCH',
      `The file content does not match its ${ext} extension (the file may be damaged or renamed).`,
    );
  if (format.text && head.includes(0))
    throw new DocIntelError('TYPE_MISMATCH', `The file does not look like a text ${ext} file.`);
  let container;
  if (format.zipRequired)
    container = inspectZipContainer(await fs.readFile(filePath), { required: format.zipRequired });
  return { ext, format, size: stat.size, container };
}
