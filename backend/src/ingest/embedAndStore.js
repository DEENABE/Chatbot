import crypto from 'crypto';
import { getDb } from '../db/connection.js';
import { embedText } from '../llm/ollamaClient.js';
import { cleanText } from './cleanText.js';
import { chunkText } from './chunkText.js';

function hashText(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * Cleans, chunks, embeds and upserts a single source record.
 * Skips chunks that already exist (by content hash) so re-running
 * ingest on unchanged data is cheap and safe.
 */
export async function embedAndStoreRecord(record) {
  const db = getDb();
  const cleaned = cleanText(record.text);
  if (!cleaned) return { inserted: 0, skipped: 0 };

  const pieces = chunkText(cleaned);

  const findExisting = db.prepare(`SELECT id FROM chunks WHERE content_hash = ?`);
  const insertChunk = db.prepare(`
    INSERT INTO chunks (source, source_row_id, text, content_hash, metadata)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertVec = db.prepare(`
    INSERT INTO chunks_vec (rowid, embedding) VALUES (?, ?)
  `);

  let inserted = 0;
  let skipped = 0;

  for (const piece of pieces) {
    const hash = hashText(piece);
    const existing = findExisting.get(hash);
    if (existing) {
      skipped++;
      continue;
    }

    const embedding = await embedText(piece);

    const info = insertChunk.run(
      record.source,
      record.sourceRowId,
      piece,
      hash,
      JSON.stringify(record.metadata || {})
    );
    insertVec.run(info.lastInsertRowid, JSON.stringify(embedding));
    inserted++;
  }

  return { inserted, skipped };
}
