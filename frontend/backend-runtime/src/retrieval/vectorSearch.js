import { getDb } from '../db/connection.js';
import { config } from '../config/index.js';

/**
 * Returns the top-K closest chunks to the query embedding.
 * `distance` is smaller = more similar.
 */
export function vectorSearch(queryEmbedding, topK = config.vectorTopK, filter = {}) {
  const db = getDb();

  // optional metadata filter, e.g. { source: 'invoices' }
  let whereClause = '';
  const params = [JSON.stringify(queryEmbedding), topK];

  if (filter.source) {
    whereClause = 'AND chunks.source = ?';
    params.push(filter.source);
  }

  const rows = db.prepare(`
    SELECT chunks.id, chunks.text, chunks.source, chunks.metadata, chunks_vec.distance
    FROM chunks_vec
    JOIN chunks ON chunks.id = chunks_vec.rowid
    WHERE embedding MATCH ? AND k = ? ${whereClause}
    ORDER BY distance
  `).all(...params);

  return rows.map(r => ({
    ...r,
    metadata: JSON.parse(r.metadata || '{}')
  }));
}
