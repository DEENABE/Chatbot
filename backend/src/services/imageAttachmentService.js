import fs from 'node:fs/promises';
import path from 'node:path';
import { db } from './db.js';
import { config } from '../config.js';
import { ValidationError } from '../lib/validate.js';

const TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const isSupportedChatImage = (name) =>
  Object.hasOwn(TYPES, path.extname(name).toLowerCase());

export async function prepareImageAttachment(file) {
  const mimeType = TYPES[path.extname(file.originalname).toLowerCase()];
  if (!mimeType) throw new ValidationError('Use PNG, JPEG or WebP for image attachments.');
  const supplied = String(file.mimetype || '').toLowerCase();
  if (supplied && supplied !== 'application/octet-stream' && supplied !== mimeType)
    throw new ValidationError('Image type does not match its filename.');
  const stat = await fs.stat(file.path);
  if (!stat.isFile() || stat.size > Math.min(config.maxFileSize, MAX_IMAGE_BYTES))
    throw new ValidationError('Image attachments must be 10 MB or smaller.');
  const bytes = await fs.readFile(file.path);
  let width = 0,
    height = 0;
  if (mimeType === 'image/png') {
    if (
      bytes.length < 45 ||
      !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      bytes.toString('ascii', 12, 16) !== 'IHDR'
    )
      throw new ValidationError('Image content does not match PNG.');
    width = bytes.readUInt32BE(16);
    height = bytes.readUInt32BE(20);
    if (!bytes.subarray(-8, -4).equals(Buffer.from('IEND')))
      throw new ValidationError('PNG image is damaged or incomplete.');
  } else if (mimeType === 'image/jpeg') {
    if (
      bytes.length < 12 ||
      bytes[0] !== 255 ||
      bytes[1] !== 216 ||
      bytes[2] !== 255 ||
      bytes.readUInt16BE(bytes.length - 2) !== 0xffd9
    )
      throw new ValidationError('Image content does not match JPEG.');
    let cursor = 2;
    while (cursor + 4 < bytes.length) {
      if (bytes[cursor++] !== 255) break;
      while (bytes[cursor] === 255) cursor++;
      const marker = bytes[cursor++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker >= 0xd0 && marker <= 0xd7) continue;
      const length = bytes.readUInt16BE(cursor);
      if (length < 2 || cursor + length > bytes.length)
        throw new ValidationError('JPEG image is damaged.');
      if (
        [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
          marker,
        ) &&
        length >= 8
      ) {
        height = bytes.readUInt16BE(cursor + 3);
        width = bytes.readUInt16BE(cursor + 5);
        break;
      }
      cursor += length;
    }
  } else {
    if (
      bytes.length < 30 ||
      bytes.toString('ascii', 0, 4) !== 'RIFF' ||
      bytes.toString('ascii', 8, 12) !== 'WEBP' ||
      bytes.readUInt32LE(4) + 8 !== bytes.length
    )
      throw new ValidationError('Image content does not match WebP.');
    for (let cursor = 12; cursor + 8 < bytes.length;) {
      const kind = bytes.toString('ascii', cursor, cursor + 4),
        length = bytes.readUInt32LE(cursor + 4),
        start = cursor + 8;
      if (start + length > bytes.length) throw new ValidationError('WebP image is damaged.');
      if (kind === 'VP8X' && length >= 10) {
        width = 1 + bytes.readUIntLE(start + 4, 3);
        height = 1 + bytes.readUIntLE(start + 7, 3);
        break;
      }
      if (kind === 'VP8L' && length >= 5 && bytes[start] === 47) {
        const bits = bytes.readUInt32LE(start + 1);
        width = (bits & 16383) + 1;
        height = ((bits >>> 14) & 16383) + 1;
        break;
      }
      if (
        kind === 'VP8 ' &&
        length >= 10 &&
        bytes.subarray(start + 3, start + 6).equals(Buffer.from([157, 1, 42]))
      ) {
        width = bytes.readUInt16LE(start + 6) & 16383;
        height = bytes.readUInt16LE(start + 8) & 16383;
        break;
      }
      cursor = start + length + (length % 2);
    }
  }
  if (!width || !height || width * height > 20_000_000)
    throw new ValidationError('Image dimensions are invalid or exceed 20 megapixels.');
  return { bytes, mimeType, width, height };
}

export function saveImageAttachment(documentId, image) {
  db.prepare('INSERT INTO document_images(documentId,mimeType,bytes) VALUES(?,?,?)').run(
    documentId,
    image.mimeType,
    image.bytes,
  );
}

export function getAttachmentImages(ids, userId, conversationId) {
  const rows = ids
    .map((id) =>
      db
        .prepare(
          `SELECT i.documentId,LENGTH(i.bytes) AS size FROM document_images i JOIN documents d ON d.id=i.documentId
    WHERE i.documentId=? AND d.userId=? AND d.purpose='attachment' AND d.conversationId=?`,
        )
        .get(id, userId, conversationId),
    )
    .filter(Boolean);
  if (rows.reduce((n, row) => n + row.size, 0) > 25 * 1024 * 1024)
    throw new ValidationError('Image attachments in one message must total 25 MB or less.');
  return rows.map((row) =>
    db
      .prepare('SELECT bytes FROM document_images WHERE documentId=?')
      .get(row.documentId)
      .bytes.toString('base64'),
  );
}
