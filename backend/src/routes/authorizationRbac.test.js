import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

// Phase 3 — authorization/RBAC/ownership regression additions. The bulk of
// this ground (documents/history/memory IDOR, admin gating, role/permission
// mass-assignment) is already covered by routes/authorization.test.js and
// routes/authIdentity.test.js — this file adds only what wasn't already
// there: an explicit "modify another user's profile" case, and one combined
// end-to-end cross-user scenario across document + memory + conversation
// that asserts on response DATA, not just status codes.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chanakya-rbac-test-'));
process.env.APP_DATA_PATH = tmpDir;
process.env.AUTH_IP_MAX_ATTEMPTS = '100000';
process.env.AUTH_LOGIN_MAX_ATTEMPTS = '100000';
process.env.AUTH_REGISTER_MAX_ATTEMPTS = '100000';

const { app } = await import('../app.js');
const { db } = await import('../services/db.js');
const documentsStore = await import('../services/documentsStore.js');
const historyService = await import('../services/historyService.js');

const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/api`;

test.after(() => new Promise((resolve) => server.close(resolve)));

function freshUsername(label) {
  return `${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function registerUser(label) {
  const username = freshUsername(label);
  const res = await fetch(`${base}/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, displayName: label, password: 'correcthorsebatterystaple' })
  });
  const body = await res.json();
  assert.equal(res.status, 201, `register should succeed for ${username}`);
  return { username, token: body.token, userId: body.user.id };
}

function authHeaders(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

// ── Self-profile authorization: cannot target another user's account ────

test('an Employee cannot modify another user\'s profile — a foreign target id in the body is inert', async () => {
  const a = await registerUser('profileTargetA');
  const b = await registerUser('profileTargetB');

  const before = db.prepare('SELECT displayName FROM users WHERE id = ?').get(b.userId);

  // A's own valid token, but the body tries every plausible way to name B
  // as the target instead of the caller.
  const res = await fetch(`${base}/auth/profile`, {
    method: 'PATCH',
    headers: authHeaders(a.token),
    body: JSON.stringify({
      displayName: 'Hijacked by A',
      id: b.userId,
      userId: b.userId,
      targetUserId: b.userId,
      accountId: b.userId
    })
  });
  assert.equal(res.status, 200);
  const body = await res.json();

  // The update must have landed on A (the authenticated caller), never B.
  assert.equal(body.user.id, a.userId);
  assert.equal(body.user.displayName, 'Hijacked by A');

  const after = db.prepare('SELECT displayName FROM users WHERE id = ?').get(b.userId);
  assert.equal(after.displayName, before.displayName, 'B\'s own profile must be completely untouched by A\'s request');
});

// ── End-to-end cross-user isolation, verified against response DATA ─────

test('cross-user isolation end-to-end: document + memory + conversation, verified by response data not just status codes', async () => {
  const a = await registerUser('e2eA');
  const b = await registerUser('e2eB');

  // User A creates a private document (seeded at the store layer — the
  // upload route itself needs Ollama for embedding, ownership enforcement
  // lives in documentsStore/route code either way), a memory, and a
  // conversation.
  const doc = { id: crypto.randomUUID(), name: 'A-private-plan.txt', size: 42, createdAt: new Date().toISOString() };
  await documentsStore.appendDocuments([doc], a.userId);

  const memRes = await fetch(`${base}/memory`, {
    method: 'POST', headers: authHeaders(a.token),
    body: JSON.stringify({ content: 'A\'s private fact: the launch date is secret', type: 'pinned' })
  });
  const { memory } = await memRes.json();

  const conversationId = crypto.randomUUID();
  await historyService.appendHistory({ conversationId, role: 'user', content: 'A\'s private conversation content' }, a.userId);

  // ── User B: direct-ID attempts ──
  const docDeleteAsB = await fetch(`${base}/documents/${doc.id}`, { method: 'DELETE', headers: authHeaders(b.token) });
  assert.equal(docDeleteAsB.status, 200); // scoped no-op per the app's convention

  const memDeleteAsB = await fetch(`${base}/memory/${memory.id}`, { method: 'DELETE', headers: authHeaders(b.token) });
  assert.equal(memDeleteAsB.status, 200);

  const convPatchAsB = await fetch(`${base}/history/${conversationId}`, {
    method: 'PATCH', headers: authHeaders(b.token), body: JSON.stringify({ title: 'renamed by B' })
  });
  assert.equal(convPatchAsB.status, 200);

  const convDeleteAsB = await fetch(`${base}/history/${conversationId}`, { method: 'DELETE', headers: authHeaders(b.token) });
  assert.equal(convDeleteAsB.status, 200);

  // ── User B: manipulated userId/ownerId in a create request ──
  const spoofedMemRes = await fetch(`${base}/memory`, {
    method: 'POST', headers: authHeaders(b.token),
    body: JSON.stringify({ content: 'B trying to write as A', type: 'pinned', userId: a.userId, ownerId: a.userId })
  });
  assert.equal(spoofedMemRes.status, 201);
  const { memory: spoofedMemory } = await spoofedMemRes.json();

  // ── Verify by DATA, not just status: B's own lists never contain A's resources ──
  const bDocs = await (await fetch(`${base}/documents`, { headers: authHeaders(b.token) })).json();
  assert.ok(!bDocs.documents.some((d) => d.id === doc.id), 'B\'s document list must not contain A\'s document');

  const bMemories = await (await fetch(`${base}/memory`, { headers: authHeaders(b.token) })).json();
  assert.ok(!bMemories.memories.some((m) => m.id === memory.id), 'B\'s memory list must not contain A\'s memory');
  // The spoofed-owner memory landed in B's own list (attributed to B, the
  // real caller), not silently vanished or attributed to A.
  assert.ok(bMemories.memories.some((m) => m.id === spoofedMemory.id), 'the memory B just created (with a spoofed ownerId) must still appear in B\'s own list');

  const bHistory = await (await fetch(`${base}/history`, { headers: authHeaders(b.token) })).json();
  assert.ok(!bHistory.conversations.some((c) => c.id === conversationId), 'B\'s conversation list must not contain A\'s conversation');

  // ── Verify by DATA: A's resources are fully intact, unrenamed, undeleted ──
  const aDocs = await (await fetch(`${base}/documents`, { headers: authHeaders(a.token) })).json();
  assert.ok(aDocs.documents.some((d) => d.id === doc.id && d.name === 'A-private-plan.txt'));

  const aMemories = await (await fetch(`${base}/memory`, { headers: authHeaders(a.token) })).json();
  const aMemory = aMemories.memories.find((m) => m.id === memory.id);
  assert.ok(aMemory);
  assert.equal(aMemory.content, 'A\'s private fact: the launch date is secret');

  const aHistory = await (await fetch(`${base}/history`, { headers: authHeaders(a.token) })).json();
  const aConversation = aHistory.conversations.find((c) => c.id === conversationId);
  assert.ok(aConversation, 'A\'s conversation must survive every one of B\'s attempts');
  assert.notEqual(aConversation.title, 'renamed by B');
  assert.equal(aConversation.messages[0].content, 'A\'s private conversation content');

  // Spoofed-owner memory must never actually belong to A in the DB either.
  const spoofedRow = db.prepare('SELECT userId FROM memories WHERE id = ?').get(spoofedMemory.id);
  assert.equal(spoofedRow.userId, b.userId, 'ownerId spoofing in the create body must never attribute the row to A');
});
