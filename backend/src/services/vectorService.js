import * as lancedb from '@lancedb/lancedb';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { embed } from './ollamaService.js';
import { isValidUuid } from '../lib/validateUuid.js';

const TABLE_NAME = 'document_chunks';
const connections = new Map();

async function db(userId) {
  // userId reaches a filesystem path below — every real caller is already
  // behind requireAuth, which only ever sets a UUID here, but this is the
  // actual point where a bad value (e.g. `..\..\AppData\evil`) would reach
  // path.join/fs.mkdir, so it's checked again right here rather than trusted
  // on the strength of callers upstream (RAG-04 in the security audit).
  if (!isValidUuid(userId)) {
    throw new Error('A valid userId is required to open the per-user vector store.');
  }

  let database = connections.get(userId);
  if (!database) {
    const storageDir = path.dirname(config.dbFile);
    const userVectorDir = path.join(storageDir, 'users', userId, 'lancedb');
    await fs.mkdir(userVectorDir, { recursive: true });
    database = await lancedb.connect(userVectorDir);
    connections.set(userId, database);
  }
  return database;
}

export async function indexChunks({ documentId, filename, chunks }, userId) {
  if (!chunks.length) return 0;
  const vectors = [];
  for (let i = 0; i < chunks.length; i += 16) {
    vectors.push(...await embed(chunks.slice(i, i + 16)));
  }
  const rows = chunks.map((text, index) => ({
    id: randomUUID(),
    documentId,
    filename,
    chunkIndex: index,
    text,
    vector: vectors[index]
  }));
  
  const connection = await db(userId);
  const names = await connection.tableNames();
  if (names.includes(TABLE_NAME)) {
    const table = await connection.openTable(TABLE_NAME);
    await table.add(rows);
  } else {
    await connection.createTable(TABLE_NAME, rows);
  }
  return rows.length;
}

export async function searchChunks(query, limit = config.ragTopK, userId) {
  const connection = await db(userId);
  if (!(await connection.tableNames()).includes(TABLE_NAME)) return [];
  const [queryVector] = await embed(query);
  const table = await connection.openTable(TABLE_NAME);
  return table.vectorSearch(queryVector).limit(limit).toArray();
}

export async function listIndexedDocuments(userId) {
  const connection = await db(userId);
  if (!(await connection.tableNames()).includes(TABLE_NAME)) return [];
  const table = await connection.openTable(TABLE_NAME);
  const rows = await table.query().select(['documentId', 'filename']).limit(10000).toArray();
  const documents = new Map();
  for (const row of rows) {
    const existing = documents.get(row.documentId);
    if (existing) {
      existing.chunks += 1;
    } else {
      documents.set(row.documentId, { id: row.documentId, name: row.filename, chunks: 1 });
    }
  }
  return [...documents.values()];
}

export async function deleteChunks(documentId, userId) {
  // documentId is string-interpolated into a LanceDB filter expression below
  // (LanceDB's delete() takes a filter string, not a parameterized query) —
  // same shape check as userId above, so a malformed id can't break out of
  // the intended `documentId = '...'` filter instead of just matching nothing.
  if (!isValidUuid(documentId)) {
    console.error(`[vector] Refusing to delete chunks for non-UUID documentId: ${documentId}`);
    return;
  }
  try {
    const connection = await db(userId);
    if (!(await connection.tableNames()).includes(TABLE_NAME)) return;
    const table = await connection.openTable(TABLE_NAME);
    await table.delete(`documentId = '${documentId}'`);
    console.log(`[vector] Deleted vector chunks for document: ${documentId}`);
  } catch (err) {
    console.error(`[vector] Failed to delete chunks for document ${documentId}:`, err.message);
  }
}
