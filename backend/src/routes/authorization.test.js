import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

// Phase 6 — authorization / RBAC / resource-ownership / IDOR-BOLA tests.
// Real HTTP-level tests against the actual Express app (same convention as
// middleware/auth.test.js), isolated per-run SQLite file so this never
// touches real dev/production data.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chanakya-authz-test-'));
process.env.APP_DATA_PATH = tmpDir;
process.env.AUTH_IP_MAX_ATTEMPTS = '100000';
process.env.AUTH_LOGIN_MAX_ATTEMPTS = '100000';
process.env.AUTH_RESET_REQUEST_MAX_ATTEMPTS = '100000';
process.env.AUTH_RESET_CONFIRM_MAX_ATTEMPTS = '100000';
process.env.AUTH_REGISTER_MAX_ATTEMPTS = '100000';

const { app } = await import('../app.js');
const { db } = await import('../services/db.js');
const documentsStore = await import('../services/documentsStore.js');
const historyService = await import('../services/historyService.js');
const RepairLogger = await import('../ai/RepairLogger.js');

const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/api`;

test.after(() => new Promise((resolve) => server.close(resolve)));

function freshUsername(label) {
  return `${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function registerUser(label) {
  const username = freshUsername(label);
  const password = 'correcthorsebatterystaple';
  const res = await fetch(`${base}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, displayName: label, password })
  });
  const body = await res.json();
  assert.equal(res.status, 201, `register should succeed for ${username}`);
  return { username, password, token: body.token, userId: body.user.id };
}

function authHeaders(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

function promoteToAdmin(userId) {
  db.prepare("UPDATE users SET role = 'Admin' WHERE id = ?").run(userId);
}

// ── VERTICAL PRIVILEGE ESCALATION: role mass assignment ────────────────

test('PATCH /auth/profile: role in the body is ignored, not written', async () => {
  const user = await registerUser('massassign');
  assert.equal(user, user); // sanity
  const before = db.prepare('SELECT role FROM users WHERE id = ?').get(user.userId);
  assert.equal(before.role, 'Employee');

  const res = await fetch(`${base}/auth/profile`, {
    method: 'PATCH',
    headers: authHeaders(user.token),
    body: JSON.stringify({ displayName: 'Still Me', role: 'Admin' })
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.user.role, 'Employee', 'response must not reflect the attempted role change');

  const after = db.prepare('SELECT role FROM users WHERE id = ?').get(user.userId);
  assert.equal(after.role, 'Employee', 'DB row must not have been promoted');
});

test('PATCH /auth/profile: isAdmin / permissions in the body are also ignored', async () => {
  const user = await registerUser('massassign2');
  const res = await fetch(`${base}/auth/profile`, {
    method: 'PATCH',
    headers: authHeaders(user.token),
    body: JSON.stringify({ isAdmin: true, permissions: ['admin'], role: 'admin' })
  });
  assert.equal(res.status, 200);
  const row = db.prepare('SELECT role, permissions FROM users WHERE id = ?').get(user.userId);
  assert.equal(row.role, 'Employee');
  assert.deepEqual(JSON.parse(row.permissions), ['read', 'write']);
});

test('PATCH /auth/profile: legitimate fields (displayName/email/department) still update', async () => {
  const user = await registerUser('profileok');
  const res = await fetch(`${base}/auth/profile`, {
    method: 'PATCH',
    headers: authHeaders(user.token),
    body: JSON.stringify({ displayName: 'New Name', email: 'a@b.com', department: 'IT' })
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.user.displayName, 'New Name');
  assert.equal(body.user.email, 'a@b.com');
  assert.equal(body.user.department, 'IT');
});

// ── RBAC: admin-only routes ─────────────────────────────────────────────

test('GET /repair/sessions: normal user -> 403, no admin -> 401, admin -> 200', async () => {
  const user = await registerUser('repairnonadmin');

  let res = await fetch(`${base}/repair/sessions`);
  assert.equal(res.status, 401, 'unauthenticated -> 401');

  res = await fetch(`${base}/repair/sessions`, { headers: authHeaders(user.token) });
  assert.equal(res.status, 403, 'authenticated non-admin -> 403');

  promoteToAdmin(user.userId);
  res = await fetch(`${base}/repair/sessions`, { headers: authHeaders(user.token) });
  assert.equal(res.status, 200, 'admin -> 200');
  const body = await res.json();
  assert.ok(Array.isArray(body.sessions));
});

test('GET /repair/dataset: normal user -> 403, admin -> 200', async () => {
  const user = await registerUser('datasetnonadmin');
  let res = await fetch(`${base}/repair/dataset`, { headers: authHeaders(user.token) });
  assert.equal(res.status, 403);

  promoteToAdmin(user.userId);
  res = await fetch(`${base}/repair/dataset`, { headers: authHeaders(user.token) });
  assert.equal(res.status, 200);
});

test('vertical escalation: role=admin / isAdmin=true / permissions=["admin"] in request bodies never grant admin routes', async () => {
  const user = await registerUser('escalate');
  const attempts = [
    { role: 'admin' },
    { role: 'Admin' },
    { isAdmin: true },
    { permissions: ['admin'] }
  ];
  for (const body of attempts) {
    await fetch(`${base}/auth/profile`, { method: 'PATCH', headers: authHeaders(user.token), body: JSON.stringify(body) });
  }
  const res = await fetch(`${base}/repair/sessions`, { headers: authHeaders(user.token) });
  assert.equal(res.status, 403, 'none of the escalation attempts should have granted admin access');
});

// ── MODEL MANAGEMENT: previously-unauthenticated mutating route ────────

test('POST /models/unload requires authentication', async () => {
  const res = await fetch(`${base}/models/unload`, { method: 'POST' });
  assert.equal(res.status, 401);
});

test('POST /models/unload succeeds for an authenticated user', async () => {
  const user = await registerUser('unloadok');
  const res = await fetch(`${base}/models/unload`, { method: 'POST', headers: authHeaders(user.token) });
  assert.ok(res.status === 200, 'authenticated unload should reach the handler (200 either way it resolves)');
});

// ── IDOR/BOLA: memory ────────────────────────────────────────────────────

test('memory: user A cannot read, delete, or list user B memories', async () => {
  const a = await registerUser('memA');
  const b = await registerUser('memB');

  const createRes = await fetch(`${base}/memory`, {
    method: 'POST',
    headers: authHeaders(a.token),
    body: JSON.stringify({ content: 'A secret only A should see', type: 'pinned' })
  });
  assert.equal(createRes.status, 201);
  const { memory } = await createRes.json();

  // B's list must not contain A's memory.
  const listAsB = await fetch(`${base}/memory`, { headers: authHeaders(b.token) });
  const { memories: bMemories } = await listAsB.json();
  assert.ok(!bMemories.some((m) => m.id === memory.id), 'B must not see A\'s memory in the list');

  // B deleting A's memory by id must not remove it.
  const deleteAsB = await fetch(`${base}/memory/${memory.id}`, { method: 'DELETE', headers: authHeaders(b.token) });
  assert.equal(deleteAsB.status, 200, 'delete is a scoped no-op, not an error, but must not affect another user\'s row');

  const listAsA = await fetch(`${base}/memory`, { headers: authHeaders(a.token) });
  const { memories: aMemories } = await listAsA.json();
  assert.ok(aMemories.some((m) => m.id === memory.id), 'A\'s memory must survive B\'s delete attempt');

  // A deleting their own memory does work.
  const deleteAsA = await fetch(`${base}/memory/${memory.id}`, { method: 'DELETE', headers: authHeaders(a.token) });
  assert.equal(deleteAsA.status, 200);
  const finalListAsA = await fetch(`${base}/memory`, { headers: authHeaders(a.token) });
  const { memories: finalMemories } = await finalListAsA.json();
  assert.ok(!finalMemories.some((m) => m.id === memory.id));
});

test('memory: user B cannot mass-clear user A\'s memories via DELETE /memory', async () => {
  const a = await registerUser('memClearA');
  const b = await registerUser('memClearB');

  await fetch(`${base}/memory`, {
    method: 'POST', headers: authHeaders(a.token), body: JSON.stringify({ content: 'keep me', type: 'session' })
  });

  await fetch(`${base}/memory`, { method: 'DELETE', headers: authHeaders(b.token) });

  const listAsA = await fetch(`${base}/memory`, { headers: authHeaders(a.token) });
  const { memories } = await listAsA.json();
  assert.equal(memories.length, 1, 'B\'s clear-all must only ever affect B\'s own (empty) set');
});

// ── IDOR/BOLA: documents ─────────────────────────────────────────────────
// Seeded directly through the store (bypasses the upload route's embedding
// step, which needs a live Ollama instance) — the ownership logic under
// test lives entirely in documentsStore/the route, not in extraction.

test('documents: list is scoped per-user, and cross-user delete is a no-op', async () => {
  const a = await registerUser('docA');
  const b = await registerUser('docB');

  const doc = { id: crypto.randomUUID(), name: 'secret.txt', size: 10, createdAt: new Date().toISOString() };
  await documentsStore.appendDocuments([doc], a.userId);

  const listAsB = await fetch(`${base}/documents`, { headers: authHeaders(b.token) });
  const { documents: bDocs } = await listAsB.json();
  assert.ok(!bDocs.some((d) => d.id === doc.id), 'B must not see A\'s document');

  const deleteAsB = await fetch(`${base}/documents/${doc.id}`, { method: 'DELETE', headers: authHeaders(b.token) });
  assert.equal(deleteAsB.status, 200);

  const stillThere = db.prepare('SELECT 1 FROM documents WHERE id = ? AND userId = ?').get(doc.id, a.userId);
  assert.ok(stillThere, 'A\'s document row must survive B\'s delete attempt');

  const deleteAsA = await fetch(`${base}/documents/${doc.id}`, { method: 'DELETE', headers: authHeaders(a.token) });
  assert.equal(deleteAsA.status, 200);
  const goneNow = db.prepare('SELECT 1 FROM documents WHERE id = ?').get(doc.id);
  assert.ok(!goneNow, 'A can delete their own document');
});

// ── IDOR/BOLA: history (conversations & folders) ────────────────────────

test('history: user B cannot delete or rename user A\'s conversation', async () => {
  const a = await registerUser('histA');
  const b = await registerUser('histB');

  const conversationId = crypto.randomUUID();
  await historyService.appendHistory({ conversationId, role: 'user', content: 'hello' }, a.userId);

  const patchAsB = await fetch(`${base}/history/${conversationId}`, {
    method: 'PATCH', headers: authHeaders(b.token), body: JSON.stringify({ title: 'hijacked' })
  });
  assert.equal(patchAsB.status, 200);
  const rowAfterB = db.prepare('SELECT title FROM chats WHERE id = ?').get(conversationId);
  assert.notEqual(rowAfterB.title, 'hijacked', 'B\'s rename must not apply to A\'s conversation');

  const deleteAsB = await fetch(`${base}/history/${conversationId}`, { method: 'DELETE', headers: authHeaders(b.token) });
  assert.equal(deleteAsB.status, 200);
  const stillExists = db.prepare('SELECT 1 FROM chats WHERE id = ?').get(conversationId);
  assert.ok(stillExists, 'B\'s delete must not remove A\'s conversation');

  const listAsB = await fetch(`${base}/history`, { headers: authHeaders(b.token) });
  const { conversations } = await listAsB.json();
  assert.ok(!conversations.some((c) => c.id === conversationId), 'B\'s own history list must not include A\'s conversation');
});

test('history: appending to an existing conversation id owned by another user is rejected, not silently merged', async () => {
  const a = await registerUser('collideA');
  const b = await registerUser('collideB');

  const conversationId = crypto.randomUUID();
  await historyService.appendHistory({ conversationId, role: 'user', content: 'A\'s message' }, a.userId);

  await assert.rejects(
    () => historyService.appendHistory({ conversationId, role: 'user', content: 'B trying to inject' }, b.userId),
    /Conversation not found/,
    'must fail closed with a clean error, not a raw SQLite constraint violation'
  );

  const messages = db.prepare('SELECT content FROM messages WHERE chatId = ?').all(conversationId);
  assert.equal(messages.length, 1, 'B\'s message must never have been inserted into A\'s chat');
  assert.equal(messages[0].content, "A's message");
});

test('history: folderId cannot be set to a folder owned by another user', async () => {
  const a = await registerUser('folderA');
  const b = await registerUser('folderB');

  const folderRes = await fetch(`${base}/history/folders`, {
    method: 'POST', headers: authHeaders(a.token), body: JSON.stringify({ name: 'A\'s folder' })
  });
  const { folder } = await folderRes.json();

  const conversationId = crypto.randomUUID();
  await historyService.appendHistory({ conversationId, role: 'user', content: 'hi' }, b.userId);

  const res = await fetch(`${base}/history/${conversationId}`, {
    method: 'PATCH', headers: authHeaders(b.token), body: JSON.stringify({ folderId: folder.id })
  });
  assert.equal(res.status, 400);

  const row = db.prepare('SELECT folderId FROM chats WHERE id = ?').get(conversationId);
  assert.equal(row.folderId, null, 'B\'s conversation must not have been attached to A\'s folder');
});

test('history: user B cannot delete user A\'s folder', async () => {
  const a = await registerUser('delFolderA');
  const b = await registerUser('delFolderB');

  const folderRes = await fetch(`${base}/history/folders`, {
    method: 'POST', headers: authHeaders(a.token), body: JSON.stringify({ name: 'keep me' })
  });
  const { folder } = await folderRes.json();

  await fetch(`${base}/history/folders/${folder.id}`, { method: 'DELETE', headers: authHeaders(b.token) });

  const stillThere = db.prepare('SELECT 1 FROM folders WHERE id = ?').get(folder.id);
  assert.ok(stillThere, 'A\'s folder must survive B\'s delete attempt');
});

// ── IDOR: repair feedback (sessionId ownership) ─────────────────────────

test('repair feedback: user B cannot attach feedback to user A\'s session', async () => {
  const a = await registerUser('feedbackA');
  const b = await registerUser('feedbackB');

  const sessionId = RepairLogger.logSession({
    goal: 'fix wifi', domain: 'network', plan: [], steps: [], resolved: true,
    summary: 'reset the adapter and it came back up, more than forty characters long',
    recommendation: '', userId: a.userId
  });

  const asB = await fetch(`${base}/repair/feedback`, {
    method: 'POST', headers: authHeaders(b.token), body: JSON.stringify({ sessionId, worked: false, note: 'not mine' })
  });
  assert.equal(asB.status, 404, 'a session owned by another user must look not-found to B');

  const asA = await fetch(`${base}/repair/feedback`, {
    method: 'POST', headers: authHeaders(a.token), body: JSON.stringify({ sessionId, worked: true, note: 'confirmed' })
  });
  assert.equal(asA.status, 200, 'the owner can still submit feedback on their own session');
});

test('repair feedback: a legacy session with no recorded owner still accepts feedback', async () => {
  const user = await registerUser('feedbackLegacy');
  const sessionId = RepairLogger.logSession({
    goal: 'legacy goal', domain: 'network', plan: [], steps: [], resolved: true,
    summary: 'a pre-ownership-tracking session with a long enough summary to pass',
    recommendation: ''
    // no userId — simulates data logged before this field existed
  });

  const res = await fetch(`${base}/repair/feedback`, {
    method: 'POST', headers: authHeaders(user.token), body: JSON.stringify({ sessionId, worked: true, note: 'ok' })
  });
  assert.equal(res.status, 200);
});

// ── AUTHENTICATION GATE ON PROTECTED ROUTERS (regression) ───────────────

test('unauthenticated requests to protected routers -> 401', async () => {
  const paths = ['/documents', '/history', '/memory', '/repair/sessions'];
  for (const p of paths) {
    const res = await fetch(`${base}${p}`);
    assert.equal(res.status, 401, `${p} should require authentication`);
  }
});
