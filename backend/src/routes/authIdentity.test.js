import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

// Phase 2 (auth-unification) — regression lock: the authenticated identity
// must come exclusively from the verified session (request.userId, set by
// requireAuth), never from a client-supplied x-user-id header or a userId
// field in the request body/query. An audit of the current codebase found
// no live x-user-id trust anywhere (the only occurrences left in
// backend/src are in code comments documenting that this was already fixed
// before this repo's Phase 6) — these tests exist to prove that state and
// keep it that way, not to fix a live vulnerability.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chanakya-authid-test-'));
process.env.APP_DATA_PATH = tmpDir;
process.env.AUTH_IP_MAX_ATTEMPTS = '100000';
process.env.AUTH_LOGIN_MAX_ATTEMPTS = '100000';
process.env.AUTH_REGISTER_MAX_ATTEMPTS = '100000';

const { app } = await import('../app.js');

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
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, displayName: label, password: 'correcthorsebatterystaple' })
  });
  const body = await res.json();
  assert.equal(res.status, 201, `register should succeed for ${username}`);
  return { username, token: body.token, userId: body.user.id };
}

// ── F: x-user-id header spoofing ────────────────────────────────────────

test('x-user-id spoofing: an authenticated request executes as the Bearer token\'s user, not the header', async () => {
  const a = await registerUser('spoofHeaderA');
  const b = await registerUser('spoofHeaderB');

  // A's valid token, but an x-user-id header claiming to be B.
  const res = await fetch(`${base}/auth/me`, {
    headers: { Authorization: `Bearer ${a.token}`, 'x-user-id': b.userId }
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.user.id, a.userId, 'identity must come from the session, not the spoofed header');
  assert.notEqual(body.user.id, b.userId);
});

test('x-user-id spoofing: memory created under a spoofed header still belongs to the real (Bearer) user', async () => {
  const a = await registerUser('spoofHeaderMemA');
  const b = await registerUser('spoofHeaderMemB');

  const create = await fetch(`${base}/memory`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${a.token}`, 'x-user-id': b.userId, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'should belong to A, not B', type: 'pinned' })
  });
  assert.equal(create.status, 201);

  // B's own list (real token, no spoofing) must not contain it.
  const listAsB = await fetch(`${base}/memory`, { headers: { Authorization: `Bearer ${b.token}` } });
  const { memories: bMemories } = await listAsB.json();
  assert.equal(bMemories.length, 0, 'the spoofed header must not have attributed the memory to B');

  const listAsA = await fetch(`${base}/memory`, { headers: { Authorization: `Bearer ${a.token}` } });
  const { memories: aMemories } = await listAsA.json();
  assert.equal(aMemories.length, 1, 'the memory must be attributed to the real session owner, A');
});

// ── G: body.userId spoofing ─────────────────────────────────────────────

test('body.userId spoofing: a userId field in the request body cannot override the session identity', async () => {
  const a = await registerUser('spoofBodyA');
  const b = await registerUser('spoofBodyB');

  const create = await fetch(`${base}/memory`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${a.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'body-spoofed', type: 'pinned', userId: b.userId, ownerId: b.userId })
  });
  assert.equal(create.status, 201);
  const { memory } = await create.json();
  assert.notEqual(memory.userId, b.userId);

  const listAsB = await fetch(`${base}/memory`, { headers: { Authorization: `Bearer ${b.token}` } });
  const { memories: bMemories } = await listAsB.json();
  assert.equal(bMemories.length, 0, 'a userId in the request body must never attribute data to another account');
});

test('body.userId spoofing on chat: appended history is attributed to the session owner regardless of a userId in the body', async () => {
  const a = await registerUser('spoofBodyChatA');
  const b = await registerUser('spoofBodyChatB');

  // Chat needs a live model to fully complete, so this only asserts on the
  // part that matters for identity — the request is accepted as A's
  // request (not rejected/misrouted) regardless of the extra userId field;
  // full generation is exercised elsewhere and requires a running LLM.
  const res = await fetch(`${base}/chat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${a.token}`, 'x-user-id': b.userId, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: '', history: [], userId: b.userId })
  });
  // An empty message with no history is accepted (nothing to persist) —
  // what matters here is it never 403/misattributes based on the spoofed
  // fields; it must behave exactly as an ordinary authenticated request.
  assert.equal(res.status, 200);
  res.body?.cancel?.();
});

// ── I: cross-user isolation cannot be defeated by any client-supplied id ──

test('cross-user isolation holds even when every spoofable field points at another user', async () => {
  const a = await registerUser('spoofAllA');
  const b = await registerUser('spoofAllB');

  const create = await fetch(`${base}/memory`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${a.token}`, 'x-user-id': b.userId, 'X-User-Id': b.userId, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'isolation check', type: 'session', userId: b.userId, ownerId: b.userId })
  });
  assert.equal(create.status, 201);
  const { memory } = await create.json();

  // B, using B's own real token, must not be able to read or delete it.
  const deleteAsB = await fetch(`${base}/memory/${memory.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${b.token}` } });
  assert.equal(deleteAsB.status, 200); // scoped no-op, per the existing ownership pattern

  const listAsA = await fetch(`${base}/memory`, { headers: { Authorization: `Bearer ${a.token}` } });
  const { memories } = await listAsA.json();
  assert.ok(memories.some((m) => m.id === memory.id), 'the record must survive every spoofing attempt and remain A\'s');
});

// ── H: no-auth access to a protected route ───────────────────────────────

test('no Authorization header at all -> 401, even with a spoofed x-user-id present', async () => {
  const b = await registerUser('noAuthSpoof');
  const res = await fetch(`${base}/memory`, { headers: { 'x-user-id': b.userId } });
  assert.equal(res.status, 401);
});
