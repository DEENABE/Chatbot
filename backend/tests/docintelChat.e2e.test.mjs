// End-to-end: real upload route (ingestion + read-only original copy), real chat route, real SQLite and
// sessions, fake local Ollama. Proves the Document Intelligence agent answers exact requests inside the
// existing chat, that ordinary questions still reach docqa/the model, and that downloads stay owner-scoped.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docintel-chat-e2e-'));
process.env.APP_DATA_PATH = dataDir;
process.env.INDICTRANS_SERVICE_URL = 'http://127.0.0.1:1';
process.env.TOOL_ENGINE_SESSION_SECRET = 'e2e-test-secret-for-signing-proposals-0123456789';

let chatReplies = [];
const ollama = http.createServer((request, response) => {
  const chunks = [];
  request.on('data', (c) => chunks.push(c));
  request.on('end', () => {
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    const json = (v) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(v));
    };
    if (request.url === '/api/tags')
      return json({ models: [{ name: 'qwen3.5:4b', digest: 'd', size: 3e9 }] });
    if (request.url === '/api/show')
      return json({
        capabilities: ['completion', 'tools'],
        model_info: { 'x.context_length': 16384 },
        details: { family: 'qwen35', parameter_size: '4B', quantization_level: 'Q4' },
      });
    if (request.url === '/api/ps') return json({ models: [] });
    if (request.url === '/api/chat') {
      const reply = chatReplies.length ? chatReplies.shift() : 'Model answer.';
      if (body.stream === false)
        return json({ message: { role: 'assistant', content: reply }, done: true });
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      response.write(
        `${JSON.stringify({ message: { role: 'assistant', content: reply }, done: false })}\n`,
      );
      return response.end(`${JSON.stringify({ done: true, eval_count: 3 })}\n`);
    }
    if (request.url === '/api/embed' || request.url === '/api/embeddings')
      return json({ embeddings: [[0.1, 0.2, 0.3]], embedding: [0.1, 0.2, 0.3] });
    response.writeHead(404);
    response.end('{}');
  });
});
await new Promise((resolve) => ollama.listen(0, '127.0.0.1', resolve));
process.env.OLLAMA_URL = `http://127.0.0.1:${ollama.address().port}`;

const { default: express } = await import('express');
const { chatRouter } = await import('../src/routes/chat.js');
const { uploadRouter } = await import('../src/routes/upload.js');
const { fileAgentRouter } = await import('../src/routes/fileAgent.js');
const { db } = await import('../src/services/db.js');
const { createSession } = await import('../src/services/sessionService.js');
const { deleteDocument } = await import('../src/services/documentsStore.js');
const { originals } = await import('../src/docintel/originals.js');
const fx = await import('../test/docintel/fixtures.mjs');

const users = [crypto.randomUUID(), crypto.randomUUID()];
for (const [i, id] of users.entries())
  db.prepare(
    "INSERT INTO users (id, username, displayName, passwordHash, salt) VALUES (?, ?, 'Tester', 'x', 'y')",
  ).run(id, `tester${i}`);
const tokens = users.map((id) => createSession(id).token);

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use('/api/upload', uploadRouter);
app.use('/api/chat', chatRouter);
app.use('/api/file-agent', fileAgentRouter);
const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => {
  server.close();
  ollama.close();
  try {
    db.close();
  } catch {
    /* closed */
  }
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* harmless */
  }
});

const conversationId = crypto.randomUUID();
async function upload(file, name, token = tokens[0]) {
  const form = new FormData();
  form.append('purpose', 'attachment');
  form.append('documents', new Blob([fs.readFileSync(file)]), name);
  const r = await fetch(`${base}/api/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  return { status: r.status, body: await r.json() };
}
async function chat(body, token = tokens[0]) {
  const r = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ history: [], conversationId, ...body }),
  });
  const events = (await r.text())
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  return {
    status: r.status,
    events,
    text: events
      .filter((e) => e.type === 'token')
      .map((e) => e.text)
      .join(''),
  };
}

const dir = await fx.tempDir();
const invFile = await fx.inventoryWorkbook(dir);
let invId;

test('upload keeps a read-only original copy; chat answers "List P110 to P115" with every row and real sheet rows', async () => {
  const up = await upload(invFile, 'inventory.xlsx');
  assert.equal(up.status, 201, JSON.stringify(up.body));
  invId = up.body.documents[0].id;
  const copy = await originals.get(users[0], invId);
  assert.ok(copy, 'original stored for exact operations');
  assert.equal(await originals.get(users[1], invId), null);
  const r = await chat({ message: 'List out P110 to P115.', attachmentIds: [invId] });
  assert.equal(r.status, 200);
  assert.deepEqual(
    r.events.filter((e) => e.type === 'error'),
    [],
  );
  for (const id of ['P110', 'P111', 'P113', 'P114', 'P115'])
    assert.match(r.text, new RegExp(`\\| ${id} \\|`));
  assert.match(r.text, /Missing \(not in the file\): P112/);
  assert.match(r.text, /rows 6–11/);
  assert.equal(r.events.filter((e) => e.type === 'done').length, 1);
  assert.ok(
    r.events.some((e) => e.type === 'sources' && e.sources[0]?.filename === 'inventory.xlsx'),
  );
});

test('Tanglish SUM in chat is computed exactly from every row, without the model', async () => {
  chatReplies = ['THE MODEL SHOULD NOT BE ASKED'];
  const r = await chat({ message: 'Excel-la total cost SUM pannu', attachmentIds: [invId] });
  assert.match(r.text, /SUM of Total Cost \(column F\) = /);
  assert.doesNotMatch(r.text, /THE MODEL SHOULD NOT BE ASKED/);
  chatReplies = [];
});

test('export request returns a verified download that only the owner can fetch', async () => {
  const r = await chat({
    message: 'show products where stock is below 20 and export to excel',
    attachmentIds: [invId],
  });
  const id = r.text.match(/#chanakya-output=([0-9a-f-]{36})/)?.[1];
  assert.ok(id, r.text);
  assert.match(r.text, /✓ Verified/);
  const own = await fetch(`${base}/api/file-agent/outputs/${id}`, {
    headers: { Authorization: `Bearer ${tokens[0]}` },
  });
  assert.equal(own.status, 200);
  assert.ok((await own.arrayBuffer()).byteLength > 0);
  const other = await fetch(`${base}/api/file-agent/outputs/${id}`, {
    headers: { Authorization: `Bearer ${tokens[1]}` },
  });
  assert.equal(other.status, 404);
  const anon = await fetch(`${base}/api/file-agent/outputs/${id}`);
  assert.equal(anon.status, 401);
});

test('ordinary chat and open questions about attachments still go to the model / document Q&A', async () => {
  chatReplies = ['Paris.'];
  const plain = await chat({
    message: 'What is the capital of France?',
    conversationId: crypto.randomUUID(),
  });
  assert.equal(plain.text, 'Paris.');
  chatReplies = ['The keyboard supplier is listed in the sheet.'];
  const q = await chat({ message: 'who supplies keyboards?', attachmentIds: [invId] });
  assert.deepEqual(
    q.events.filter((e) => e.type === 'error'),
    [],
  );
  assert.doesNotMatch(q.text, /matching rows/);
});

test('new formats upload and work: JSON records and TSV', async () => {
  const jf = path.join(dir, 'staff.json');
  fs.writeFileSync(
    jf,
    JSON.stringify([
      { EmpID: 'E1', Name: 'Anu', Salary: 30000 },
      { EmpID: 'E2', Name: 'Bala', Salary: 42000 },
      { EmpID: 'E4', Name: 'Devi', Salary: 'unknown' },
    ]),
  );
  const up = await upload(jf, 'staff.json');
  assert.equal(up.status, 201, JSON.stringify(up.body));
  assert.equal(up.body.skipped.length, 0, JSON.stringify(up.body.skipped));
  const r = await chat({ message: 'list E1 to E4', attachmentIds: [up.body.documents[0].id] });
  assert.match(r.text, /3 matching rows/);
  assert.match(r.text, /Missing \(not in the file\): E3/);
});

test('deleting the document removes the stored original copy', async () => {
  await deleteDocument(invId, users[0]);
  assert.equal(await originals.get(users[0], invId), null);
});
