/**
 * Pulls raw records from YOUR existing big database so they can be
 * cleaned, chunked, embedded and indexed.
 *
 * This file is intentionally an adapter layer - edit `loadFromSourceDb`
 * to match your actual database (Postgres/MySQL/Mongo/files/etc).
 * Everything downstream (chunking, embedding) does not care where
 * the text came from as long as you return this shape:
 *
 *   { sourceRowId: string, source: string, text: string, metadata: object }
 */

// ---- Example: Postgres source (npm install pg) ----
// import pg from 'pg';
// const pool = new pg.Pool({ connectionString: process.env.SOURCE_DB_URL });
//
// export async function loadFromSourceDb({ batchSize = 500, offset = 0 } = {}) {
//   const { rows } = await pool.query(
//     `SELECT id, title, body, updated_at FROM articles ORDER BY id LIMIT $1 OFFSET $2`,
//     [batchSize, offset]
//   );
//   return rows.map(r => ({
//     sourceRowId: String(r.id),
//     source: 'articles',
//     text: `${r.title}\n\n${r.body}`,
//     metadata: { updatedAt: r.updated_at }
//   }));
// }

// ---- Example: MySQL source (npm install mysql2) ----
// import mysql from 'mysql2/promise';
// const conn = await mysql.createConnection(process.env.SOURCE_DB_URL);
//
// export async function loadFromSourceDb({ batchSize = 500, offset = 0 } = {}) {
//   const [rows] = await conn.execute(
//     'SELECT id, content FROM documents LIMIT ? OFFSET ?',
//     [batchSize, offset]
//   );
//   return rows.map(r => ({
//     sourceRowId: String(r.id),
//     source: 'documents',
//     text: r.content,
//     metadata: {}
//   }));
// }

// ---- Placeholder / demo implementation ----
// Replace this with one of the adapters above (or your own) once you
// wire up your real database. This lets the rest of the pipeline run
// end-to-end out of the box for testing.
export async function loadFromSourceDb({ batchSize = 500, offset = 0 } = {}) {
  const demoRows = [
    {
      sourceRowId: '1',
      source: 'demo',
      text: 'The quarterly revenue report shows a 12% increase in Q3 compared to Q2, driven mainly by growth in the enterprise segment.',
      metadata: { category: 'finance' }
    },
    {
      sourceRowId: '2',
      source: 'demo',
      text: 'Employees are entitled to 18 days of paid leave per year, plus public holidays as per the regional calendar.',
      metadata: { category: 'hr' }
    }
  ];

  if (offset >= demoRows.length) return [];
  return demoRows.slice(offset, offset + batchSize);
}

/**
 * Returns total row count for progress reporting during ingest.
 * Replace with a real COUNT(*) query against your source DB.
 */
export async function countSourceRows() {
  return 2; // demo value - replace with real count
}
