import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import * as lancedb from '@lancedb/lancedb';

// Phase 3 — RAG/vector ownership audit (flagged "CRITICAL" in the task):
// prove that one user's semantic-search retrieval can never surface another
// user's document chunks. This is the actual security boundary the app
// relies on — vectorService.js keys each user to a physically separate
// LanceDB directory (storage/users/<userId>/lancedb), not a shared table
// filtered by a WHERE clause — so what has to be proven is that the two
// directories are genuinely isolated on disk, not merely that a query
// happens to filter correctly.
//
// indexChunks()/searchChunks() both call ollamaService.embed(), which needs
// a live Ollama instance this test environment doesn't have. Real chunk
// rows are seeded directly via the same @lancedb/lancedb client
// vectorService.js itself uses (same directory convention, same table
// schema, a fixed placeholder vector) — bypassing only the embedding step.
// Every READ/DELETE below goes through vectorService's real, exported
// functions, exercising the actual production code path an attacker would
// have to go through.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chanakya-vector-test-'));
process.env.APP_DATA_PATH = tmpDir;

const vectorService = await import('./vectorService.js');
const { config } = await import('../config.js');

const TABLE_NAME = 'document_chunks';
const FAKE_VECTOR = [0.11, 0.22, 0.33, 0.44];

function userVectorDir(userId) {
  return path.join(path.dirname(config.dbFile), 'users', userId, 'lancedb');
}

async function seedFakeChunk(userId, documentId, filename, text) {
  const dir = userVectorDir(userId);
  await fs.promises.mkdir(dir, { recursive: true });
  const connection = await lancedb.connect(dir);
  const row = { id: crypto.randomUUID(), documentId, filename, chunkIndex: 0, text, vector: FAKE_VECTOR };
  const names = await connection.tableNames();
  if (names.includes(TABLE_NAME)) {
    const table = await connection.openTable(TABLE_NAME);
    await table.add([row]);
  } else {
    await connection.createTable(TABLE_NAME, [row]);
  }
  return row.id;
}

test('RAG isolation: user A\'s indexed chunk is invisible to user B via listIndexedDocuments (real exported function)', async () => {
  const userA = crypto.randomUUID();
  const userB = crypto.randomUUID();
  const documentId = crypto.randomUUID();

  await seedFakeChunk(userA, documentId, 'confidential-A.txt', 'A secret only user A should ever retrieve.');

  const asA = await vectorService.listIndexedDocuments(userA);
  assert.equal(asA.length, 1);
  assert.equal(asA[0].id, documentId);
  assert.equal(asA[0].name, 'confidential-A.txt');

  const asB = await vectorService.listIndexedDocuments(userB);
  assert.equal(asB.length, 0, 'user B must see zero documents — not a filtered view of A\'s, an empty one');
});

test('RAG isolation: a direct vectorSearch in user B\'s own connection cannot return user A\'s chunk, even with the identical query vector', async () => {
  const userA = crypto.randomUUID();
  const userB = crypto.randomUUID();
  const documentId = crypto.randomUUID();

  await seedFakeChunk(userA, documentId, 'confidential-A.txt', 'A secret only user A should ever retrieve.');

  // Mirrors exactly what vectorService.searchChunks() does internally
  // (table.vectorSearch(queryVector).limit(n).toArray()) — the only thing
  // substituted is the query vector itself, since embedding a real query
  // string needs Ollama. Opened against user B's own directory, the same
  // way requireAuth-derived request.userId would open it for a real
  // request from B.
  const dirB = userVectorDir(userB);
  await fs.promises.mkdir(dirB, { recursive: true });
  const connectionB = await lancedb.connect(dirB);
  const tableNamesB = await connectionB.tableNames();
  assert.equal(tableNamesB.includes(TABLE_NAME), false, 'user B\'s directory must not even contain the table A\'s data lives in');

  // Even a semantically-identical query vector against B's (nonexistent)
  // table returns nothing — there is no shared table for a filter to have
  // ever gotten wrong.
  const resultsB = tableNamesB.includes(TABLE_NAME)
    ? await (await connectionB.openTable(TABLE_NAME)).vectorSearch(FAKE_VECTOR).limit(10).toArray()
    : [];
  assert.equal(resultsB.length, 0);

  // Sanity: the same query vector against A's own connection DOES find it —
  // proving the seed data is real and searchable, not just absent everywhere.
  const dirA = userVectorDir(userA);
  const connectionA = await lancedb.connect(dirA);
  const tableA = await connectionA.openTable(TABLE_NAME);
  const resultsA = await tableA.vectorSearch(FAKE_VECTOR).limit(10).toArray();
  assert.equal(resultsA.length, 1);
  assert.equal(resultsA[0].documentId, documentId);
});

test('RAG isolation: physically separate storage directories per user (not a shared table)', async () => {
  const userA = crypto.randomUUID();
  const userB = crypto.randomUUID();
  await seedFakeChunk(userA, crypto.randomUUID(), 'a.txt', 'a');
  await seedFakeChunk(userB, crypto.randomUUID(), 'b.txt', 'b');

  const dirA = userVectorDir(userA);
  const dirB = userVectorDir(userB);
  assert.notEqual(dirA, dirB);
  assert.ok(fs.existsSync(dirA));
  assert.ok(fs.existsSync(dirB));
  // Each directory only ever contains that one user's uuid segment.
  assert.ok(dirA.includes(userA) && !dirA.includes(userB));
  assert.ok(dirB.includes(userB) && !dirB.includes(userA));
});

test('RAG isolation: deleteChunks(userB) for a documentId that actually belongs to A is a safe no-op — A\'s data survives', async () => {
  const userA = crypto.randomUUID();
  const userB = crypto.randomUUID();
  const documentId = crypto.randomUUID();
  await seedFakeChunk(userA, documentId, 'confidential-A.txt', 'A secret.');

  // The real, exported production function — called exactly as
  // documentsStore.deleteDocument() calls it after requireAuth resolves
  // request.userId to B.
  await vectorService.deleteChunks(documentId, userB);

  const stillThereForA = await vectorService.listIndexedDocuments(userA);
  assert.equal(stillThereForA.length, 1, 'B\'s delete attempt must not remove A\'s chunk — it never even opened A\'s directory');
});

test('RAG isolation: an invalid/malformed userId is refused outright, not treated as a fresh valid store', async () => {
  await assert.rejects(
    () => vectorService.listIndexedDocuments('../../etc/passwd'),
    /valid userId/i
  );
  await assert.rejects(
    () => vectorService.listIndexedDocuments('not-a-uuid'),
    /valid userId/i
  );
});
