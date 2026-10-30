// SQLite side of document Q&A:
//   doc_tables / doc_rows (+ doc_rows_fts)  — every spreadsheet row, with columns
//   doc_chunks (+ doc_chunks_fts)           — every text chunk, for keyword search
// LanceDB still holds the embeddings; this adds exact keyword lookup (names,
// IDs, emails) that vector search is bad at, and full-table access for the
// query planner.
import { randomUUID } from 'node:crypto';
import { getDb } from '../db/connection.js';
import { rowToText } from './tableParser.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS doc_tables (
  id TEXT PRIMARY KEY,
  documentId TEXT NOT NULL,
  userId TEXT NOT NULL,
  filename TEXT NOT NULL,
  sheet TEXT NOT NULL,
  columns TEXT NOT NULL,
  rowCount INTEGER NOT NULL,
  createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_doc_tables_user ON doc_tables(userId);
CREATE INDEX IF NOT EXISTS idx_doc_tables_doc ON doc_tables(documentId);
CREATE TABLE IF NOT EXISTS doc_rows (
  id INTEGER PRIMARY KEY,
  tableId TEXT NOT NULL,
  documentId TEXT NOT NULL,
  userId TEXT NOT NULL,
  rowIndex INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_doc_rows_table ON doc_rows(tableId, rowIndex);
CREATE INDEX IF NOT EXISTS idx_doc_rows_doc ON doc_rows(documentId);
CREATE VIRTUAL TABLE IF NOT EXISTS doc_rows_fts USING fts5(
  text, tokenize = 'unicode61 remove_diacritics 0'
);
CREATE TABLE IF NOT EXISTS doc_chunks (
  id INTEGER PRIMARY KEY,
  documentId TEXT NOT NULL,
  userId TEXT NOT NULL,
  filename TEXT NOT NULL,
  chunkIndex INTEGER NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_doc_chunks_doc ON doc_chunks(documentId, chunkIndex);
CREATE INDEX IF NOT EXISTS idx_doc_chunks_user ON doc_chunks(userId);
CREATE VIRTUAL TABLE IF NOT EXISTS doc_chunks_fts USING fts5(
  text, tokenize = 'unicode61 remove_diacritics 0'
);
`;

let database = null;
/** Tests can inject an in-memory better-sqlite3 database. */
export function setStructuredDb(customDb) {
  database = customDb;
  database.exec(SCHEMA);
}
function db() {
  if (!database) setStructuredDb(getDb());
  return database;
}

// Question words (English + Tamil/Tanglish) that never identify a row.
const STOP_WORDS = new Set(
  `a an the is are was were be been am of in on at to for from by with and or not no
  what who whom whose where when which why how many much does do did done give me show
  tell list all any some details detail info information about person people please can
  could would you your i my mine his her hers their them he she they it its this that these
  those there here have has had get got find search data record records row rows sheet sheets
  excel file files document documents tell me us our we let lets also just only than then
  enna ena yenna enga engae engu irukaru irukkaru irukar iruka irukka irukanga irukkanga
  epa eppa eppo eppadi epdi vandharu vandhaaru vanthaaru vandhar vandhanga vanthanga entha
  endha yaaru yaru yar oda ooda la le ku kku kitta pathi patthi sollu sollunga kaattu kattu
  kudu kodu venum vendum iruku irukku ellam ellaam avar avaru avanga ivar ivaru naa na nu um
  oru panni pannu pannunga panunga ah aa pa da ethana ethanai evlo evalo evvalavu mothama
  motham mottham per peru name naame panaru pannaru panna pannanga panranga panraru join
  joined joining company companies work working works irundhu iruntha vandha vanthu
  vandhu sonna current currently now today please pls`
    .split(/\s+/)
    .filter(Boolean),
);

export function keywordTokens(text) {
  const tokens = String(text || '')
    .toLowerCase()
    .match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}._@-]*/gu);
  if (!tokens) return [];
  const unique = [];
  for (const raw of tokens) {
    const token = raw.replace(/[._@-]+$/, '');
    if (token.length < 2 || STOP_WORDS.has(token)) continue;
    if (!unique.includes(token)) unique.push(token);
    if (unique.length >= 12) break;
  }
  return unique;
}

export function buildFtsQuery(text) {
  const tokens = keywordTokens(text);
  if (!tokens.length) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' OR ');
}

export function saveDocumentStructure({ documentId, userId, filename, tables = [], chunks = [] }) {
  const d = db();
  const insertTable = d.prepare(
    `INSERT INTO doc_tables (id, documentId, userId, filename, sheet, columns, rowCount)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertRow = d.prepare(
    `INSERT INTO doc_rows (tableId, documentId, userId, rowIndex, data) VALUES (?, ?, ?, ?, ?)`,
  );
  const insertRowFts = d.prepare(`INSERT INTO doc_rows_fts (rowid, text) VALUES (?, ?)`);
  const insertChunk = d.prepare(
    `INSERT INTO doc_chunks (documentId, userId, filename, chunkIndex, text) VALUES (?, ?, ?, ?, ?)`,
  );
  const insertChunkFts = d.prepare(`INSERT INTO doc_chunks_fts (rowid, text) VALUES (?, ?)`);

  let rowTotal = 0;
  d.transaction(() => {
    for (const table of tables) {
      const tableId = randomUUID();
      insertTable.run(
        tableId,
        documentId,
        userId,
        filename,
        table.name,
        JSON.stringify(table.columns),
        table.rows.length,
      );
      table.rows.forEach((row, index) => {
        const { lastInsertRowid } = insertRow.run(
          tableId,
          documentId,
          userId,
          index,
          JSON.stringify(row),
        );
        insertRowFts.run(lastInsertRowid, `${table.name} ${row.join(' ')}`);
      });
      rowTotal += table.rows.length;
    }
    chunks.forEach((text, index) => {
      const { lastInsertRowid } = insertChunk.run(documentId, userId, filename, index, text);
      insertChunkFts.run(lastInsertRowid, text);
    });
  })();
  return { tables: tables.length, rows: rowTotal };
}

export function deleteDocumentStructure(documentId, userId) {
  const d = db();
  d.transaction(() => {
    d.prepare(
      `DELETE FROM doc_rows_fts WHERE rowid IN (SELECT id FROM doc_rows WHERE documentId = ? AND userId = ?)`,
    ).run(documentId, userId);
    d.prepare(`DELETE FROM doc_rows WHERE documentId = ? AND userId = ?`).run(documentId, userId);
    d.prepare(`DELETE FROM doc_tables WHERE documentId = ? AND userId = ?`).run(documentId, userId);
    d.prepare(
      `DELETE FROM doc_chunks_fts WHERE rowid IN (SELECT id FROM doc_chunks WHERE documentId = ? AND userId = ?)`,
    ).run(documentId, userId);
    d.prepare(`DELETE FROM doc_chunks WHERE documentId = ? AND userId = ?`).run(documentId, userId);
  })();
}

function parseTable(row) {
  return { ...row, columns: JSON.parse(row.columns) };
}

function scopeSql(documentIds, alias = '') {
  if (!Array.isArray(documentIds)) return { sql: '', values: [] };
  if (!documentIds.length) return { sql: ' AND 0', values: [] };
  return {
    sql: ` AND ${alias}documentId IN (${documentIds.map(() => '?').join(',')})`,
    values: documentIds,
  };
}

export function listTables(userId, documentIds) {
  const scope = scopeSql(documentIds);
  return db()
    .prepare(`SELECT * FROM doc_tables WHERE userId = ?${scope.sql} ORDER BY createdAt DESC`)
    .all(userId, ...scope.values)
    .map(parseTable);
}

export function getTableRows(tableId, userId) {
  return db()
    .prepare(`SELECT data FROM doc_rows WHERE tableId = ? AND userId = ? ORDER BY rowIndex`)
    .all(tableId, userId)
    .map((r) => JSON.parse(r.data));
}

/** Per-document {tables, rows} for the knowledge-base list. */
export function documentStructureStats(userId) {
  const stats = new Map();
  for (const row of db()
    .prepare(
      `SELECT documentId, COUNT(*) AS tables, SUM(rowCount) AS rows FROM doc_tables WHERE userId = ? GROUP BY documentId`,
    )
    .all(userId))
    stats.set(row.documentId, { tables: row.tables, rows: row.rows });
  return stats;
}

/** Keyword (BM25) search over every spreadsheet / docx-table row. */
export function searchRows(query, userId, limit = 20, documentIds) {
  const match = buildFtsQuery(query);
  if (!match) return [];
  try {
    const scope = scopeSql(documentIds, 'r.');
    return db()
      .prepare(
        `SELECT r.tableId, r.documentId, r.rowIndex, r.data, t.filename, t.sheet, t.columns, t.rowCount,
                bm25(doc_rows_fts) AS score
         FROM doc_rows_fts JOIN doc_rows r ON r.id = doc_rows_fts.rowid
         JOIN doc_tables t ON t.id = r.tableId
         WHERE doc_rows_fts MATCH ? AND r.userId = ?${scope.sql}
         ORDER BY score LIMIT ?`,
      )
      .all(match, userId, ...scope.values, limit)
      .map((row) => ({
        ...row,
        data: JSON.parse(row.data),
        columns: JSON.parse(row.columns),
      }));
  } catch (error) {
    console.error('[docqa] row search failed:', error.message);
    return [];
  }
}

/** Keyword (BM25) search over text chunks of every document. */
export function searchTextChunks(query, userId, limit = 8, documentIds) {
  const match = buildFtsQuery(query);
  if (!match) return [];
  try {
    const scope = scopeSql(documentIds, 'c.');
    return db()
      .prepare(
        `SELECT c.documentId, c.filename, c.chunkIndex, c.text, bm25(doc_chunks_fts) AS score
         FROM doc_chunks_fts JOIN doc_chunks c ON c.id = doc_chunks_fts.rowid
         WHERE doc_chunks_fts MATCH ? AND c.userId = ?${scope.sql}
         ORDER BY score LIMIT ?`,
      )
      .all(match, userId, ...scope.values, limit);
  } catch (error) {
    console.error('[docqa] chunk search failed:', error.message);
    return [];
  }
}

/** Bounded evidence for generic summaries when embeddings are unavailable. */
export function getDocumentChunks(documentIds, userId, limit = 6) {
  if (!documentIds?.length) return [];
  const hits = [];
  const perDocument = Math.max(1, Math.floor(limit / documentIds.length));
  for (const id of documentIds.slice(0, limit)) {
    const count = db()
      .prepare('SELECT COUNT(*) AS n FROM doc_chunks WHERE documentId=? AND userId=?')
      .get(id, userId).n;
    for (let i = 0; i < Math.min(perDocument, count); i++) {
      const offset = Math.floor((i * count) / perDocument);
      const chunk = db()
        .prepare(
          'SELECT documentId,filename,chunkIndex,text FROM doc_chunks WHERE documentId=? AND userId=? ORDER BY chunkIndex LIMIT 1 OFFSET ?',
        )
        .get(id, userId, offset);
      if (chunk) hits.push(chunk);
    }
  }
  return hits;
}

/** Every chunk of one document in order (file agent: summaries, conversion, extraction). */
export function getAllDocumentChunks(documentId, userId, limit = 2000) {
  return db()
    .prepare(
      'SELECT text FROM doc_chunks WHERE documentId=? AND userId=? ORDER BY chunkIndex LIMIT ?',
    )
    .all(documentId, userId, limit)
    .map((row) => row.text);
}

export { rowToText };
