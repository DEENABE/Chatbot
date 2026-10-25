import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
process.env.APP_DATA_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'vector-tests-'));
const { indexChunks, listIndexedDocuments, deleteChunks, searchChunks } =
  await import('./vectorService.js');
const { embed, validateEmbeddings } = await import('./ollamaService.js');
const { selectModelRoute, validateModelPreferences, discoverModels } =
  await import('./modelRouter.js');

test('malformed embeddings never enter a vector index', () => {
  for (const value of [[], [[1, 2]], [[1], [1, 2]], [[NaN], [1]], [[Infinity], [1]], [null, [1]]])
    assert.throws(() => validateEmbeddings(value, 2), /invalid or incomplete embeddings/);
});
test('model preferences preserve reasoning and cloud proxies are never eligible', async () => {
  const local = { id: 'local:4b', capabilities: ['completion', 'tools', 'thinking'], size: 1 };
  const cloud = { ...local, id: 'huge:cloud', size: 0 };
  assert.equal(
    selectModelRoute({ models: [cloud, local], requestedModel: cloud.id }).model,
    local.id,
  );
  assert.equal(selectModelRoute({ models: [local] }).thinking, true);
  assert.equal(
    selectModelRoute({ models: [local], preferences: { thinking: false } }).thinking,
    false,
  );
  assert.equal(validateModelPreferences({ thinking: false }, [local]).thinking, false);
  assert.throws(() => validateModelPreferences({ thinking: 'yes' }, [local]), /Thinking/);
  assert.throws(() => validateModelPreferences({ generalModel: cloud.id }, [cloud, local]));
  const found = await discoverModels({
    refresh: true,
    list: async () => [{ name: 'proxy:latest' }, { name: local.id }],
    show: async (id) =>
      id === 'proxy:latest'
        ? { remote_host: 'https://cloud.example', capabilities: ['completion'] }
        : { capabilities: local.capabilities },
  });
  assert.deepEqual(
    found.map((m) => m.id),
    [local.id],
  );
});
test('parallel first uploads serialize vector creation, retain both files and delete only the requested file', async () => {
  const original = globalThis.fetch;
  process.env.EMBED_BATCH_SIZE = '0'; // A bad environment value must never produce an infinite loop.
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body);
    return Response.json({
      embeddings: (Array.isArray(body.input) ? body.input : [body.input]).map(() => [
        0.1, 0.2, 0.3,
      ]),
    });
  };
  try {
    const user = randomUUID(),
      first = randomUUID(),
      second = randomUUID();
    await Promise.all([
      indexChunks({ documentId: first, filename: 'one.txt', chunks: ['first document'] }, user),
      indexChunks({ documentId: second, filename: 'two.txt', chunks: ['second document'] }, user),
    ]);
    assert.equal((await listIndexedDocuments(user)).length, 2);
    assert.deepEqual(
      (await searchChunks('second', 5, user, { documentIds: [second] })).map((r) => r.documentId),
      [second],
    );
    await deleteChunks(first, user);
    assert.deepEqual(
      (await listIndexedDocuments(user)).map((d) => d.id),
      [second],
    );
  } finally {
    globalThis.fetch = original;
    delete process.env.EMBED_BATCH_SIZE;
  }
});
test('invalid embedding output is surfaced and never retried through a second API', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ embeddings: [[1, 2]] });
  };
  try {
    await assert.rejects(embed(['one', 'two']), /invalid or incomplete embeddings/);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
  }
});
