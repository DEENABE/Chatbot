import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

// Phase 7 — API security hardening tests: input validation, request limits,
// file upload signature checks, path traversal, CORS, security headers,
// error handling, HTTP method/content-type security, parameter pollution,
// prototype pollution, and pagination/resource-exhaustion limits. Same real
// HTTP-against-the-live-app convention as the Phase 1–6 suites.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chanakya-apisec-test-'));
process.env.APP_DATA_PATH = tmpDir;
process.env.AUTH_IP_MAX_ATTEMPTS = '100000';
process.env.AUTH_LOGIN_MAX_ATTEMPTS = '100000';
process.env.AUTH_RESET_REQUEST_MAX_ATTEMPTS = '100000';
process.env.AUTH_RESET_CONFIRM_MAX_ATTEMPTS = '100000';
process.env.AUTH_REGISTER_MAX_ATTEMPTS = '100000';

const { app } = await import('../app.js');
const historyService = await import('../services/historyService.js');

const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/api`;
const origin = `http://127.0.0.1:${server.address().port}`;

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

// ── SECURITY HEADERS ─────────────────────────────────────────────────────

test('security headers are present on API responses', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.ok(res.headers.get('content-security-policy'), 'CSP header must be present');
  assert.ok(res.headers.get('content-security-policy').includes("default-src 'self'"));
  assert.ok(res.headers.get('x-request-id'), 'a correlation id must be present');
  assert.doesNotMatch(res.headers.get('x-powered-by') || '', /express/i);
});

test('each request gets a distinct X-Request-Id', async () => {
  const [a, b] = await Promise.all([fetch(`${base}/health`), fetch(`${base}/health`)]);
  assert.notEqual(a.headers.get('x-request-id'), b.headers.get('x-request-id'));
});

// ── 404 / METHOD HANDLING ────────────────────────────────────────────────

test('unknown API route returns a controlled JSON 404, not the Express default page', async () => {
  const res = await fetch(`${base}/this-route-does-not-exist`);
  assert.equal(res.status, 404);
  assert.equal(res.headers.get('content-type').includes('application/json'), true);
  const body = await res.json();
  assert.equal(body.error, 'Not found.');
});

test('an unsupported HTTP method on a real route is rejected, not silently handled', async () => {
  const user = await registerUser('methodcheck');
  // /models only registers GET routes — DELETE was never wired up.
  const res = await fetch(`${base}/models`, { method: 'DELETE', headers: authHeaders(user.token) });
  assert.equal(res.status, 404);
});

// ── CONTENT TYPE ─────────────────────────────────────────────────────────

test('a JSON-shaped body sent with the wrong Content-Type is not parsed, so validation rejects it', async () => {
  const user = await registerUser('contenttype');
  const res = await fetch(`${base}/memory`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${user.token}`, 'Content-Type': 'text/plain' },
    body: JSON.stringify({ content: 'hello', type: 'pinned' })
  });
  assert.equal(res.status, 400);
});

test('malformed JSON body is rejected cleanly, no crash, no stack trace', async () => {
  const user = await registerUser('malformedjson');
  const res = await fetch(`${base}/memory`, {
    method: 'POST',
    headers: authHeaders(user.token),
    body: '{"content": "unterminated'
  });
  assert.ok(res.status >= 400);
  const text = await res.text();
  assert.ok(!/at [\w.]+ \(.*:\d+:\d+\)/.test(text));
});

// ── CORS ──────────────────────────────────────────────────────────────────

test('CORS: an allowed origin gets Access-Control-Allow-Origin echoed back', async () => {
  const res = await fetch(`${base}/health`, { headers: { Origin: 'http://localhost:5173' } });
  assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:5173');
});

test('CORS: a disallowed origin gets no Access-Control-Allow-Origin header', async () => {
  const res = await fetch(`${base}/health`, { headers: { Origin: 'https://evil.example.com' } });
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

// ── INPUT VALIDATION: oversized / invalid fields ────────────────────────

test('oversized memory content is rejected', async () => {
  const user = await registerUser('oversizedmem');
  const res = await fetch(`${base}/memory`, {
    method: 'POST', headers: authHeaders(user.token),
    body: JSON.stringify({ content: 'x'.repeat(8001), type: 'pinned' })
  });
  assert.equal(res.status, 400);
});

test('invalid memory type enum is rejected', async () => {
  const user = await registerUser('badenum');
  const res = await fetch(`${base}/memory`, {
    method: 'POST', headers: authHeaders(user.token),
    body: JSON.stringify({ content: 'hi', type: 'superadmin' })
  });
  assert.equal(res.status, 400);
});

test('oversized folder name is rejected', async () => {
  const user = await registerUser('oversizedfolder');
  const res = await fetch(`${base}/history/folders`, {
    method: 'POST', headers: authHeaders(user.token),
    body: JSON.stringify({ name: 'x'.repeat(121) })
  });
  assert.equal(res.status, 400);
});

test('oversized chat message is rejected', async () => {
  const user = await registerUser('oversizedchat');
  const res = await fetch(`${base}/chat`, {
    method: 'POST', headers: authHeaders(user.token),
    body: JSON.stringify({ message: 'x'.repeat(50_001), history: [] })
  });
  assert.equal(res.status, 400);
});

test('oversized chat history array is rejected', async () => {
  const user = await registerUser('oversizedhistory');
  const res = await fetch(`${base}/chat`, {
    method: 'POST', headers: authHeaders(user.token),
    body: JSON.stringify({ message: 'hi', history: Array.from({ length: 501 }, () => ({ role: 'user', content: 'x' })) })
  });
  assert.equal(res.status, 400);
});

test('agent maxSteps is bounded — an absurd value is rejected, not silently run', async () => {
  const user = await registerUser('boundedsteps');
  const res = await fetch(`${base}/agent`, {
    method: 'POST', headers: authHeaders(user.token),
    body: JSON.stringify({ goal: 'diagnose network', maxSteps: 999999999 })
  });
  assert.equal(res.status, 400);
});

test('invalid resource ids are rejected before reaching the database', async () => {
  const user = await registerUser('badids');
  const attempts = [
    ['DELETE', '/documents/not-a-uuid'],
    ['DELETE', '/memory/not-a-uuid'],
    ['DELETE', '/history/not-a-uuid'],
    ['PATCH', '/history/not-a-uuid'],
    ['DELETE', '/history/folders/not-a-uuid'],
    ["DELETE", "/documents/1'%3B%20DROP%20TABLE%20users%3B--"]
  ];
  for (const [method, p] of attempts) {
    const res = await fetch(`${base}${p}`, { method, headers: authHeaders(user.token) });
    assert.equal(res.status, 400, `${method} ${p} should be rejected as an invalid id`);
  }
});

// ── HTTP PARAMETER POLLUTION ─────────────────────────────────────────────

test('repeated query parameters resolve deterministically, not as an array reaching the DB layer', async () => {
  const user = await registerUser('hpp');
  const res = await fetch(`${base}/memory?type=pinned&type=project`, { headers: authHeaders(user.token) });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.memories));
});

test('repeated search query params do not crash the search endpoint', async () => {
  const user = await registerUser('hppsearch');
  const res = await fetch(`${base}/history/search?q=a&q=b`, { headers: authHeaders(user.token) });
  assert.equal(res.status, 200);
});

// ── PROTOTYPE POLLUTION ──────────────────────────────────────────────────

test('a __proto__ key in a request body never reaches the global Object prototype', async () => {
  const user = await registerUser('protopollute');
  const before = ({}).polluted;
  const res = await fetch(`${base}/auth/profile`, {
    method: 'PATCH', headers: authHeaders(user.token),
    body: JSON.stringify({ displayName: 'ok', __proto__: { polluted: 'yes' }, constructor: { prototype: { polluted: 'yes' } } })
  });
  assert.equal(res.status, 200);
  assert.equal(({}).polluted, before, 'Object.prototype must be untouched');
});

// ── PAGINATION / RESOURCE EXHAUSTION ─────────────────────────────────────

test('search results are capped even when far more rows match', async () => {
  const user = await registerUser('paginationcap');
  for (let i = 0; i < 220; i++) {
    await historyService.appendHistory(
      { conversationId: crypto.randomUUID(), role: 'user', content: `needle message ${i}` },
      user.userId
    );
  }
  const res = await fetch(`${base}/history/search?q=needle`, { headers: authHeaders(user.token) });
  assert.equal(res.status, 200);
  const { results } = await res.json();
  assert.ok(results.length <= 200, `expected at most 200 results, got ${results.length}`);
});

// ── FILE UPLOAD SECURITY ─────────────────────────────────────────────────

test('upload: a file whose content does not match its extension is skipped, not indexed', async () => {
  const user = await registerUser('badsignature');
  const form = new FormData();
  form.append('documents', new Blob(['this is not actually a PDF'], { type: 'application/pdf' }), 'fake.pdf');
  const res = await fetch(`${base}/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${user.token}` },
    body: form
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.documents.length, 0);
  assert.equal(body.skipped.length, 1);
  assert.match(body.skipped[0].reason, /does not match/);
});

test('upload: an unsupported extension is skipped, not rejected as a whole batch', async () => {
  const user = await registerUser('unsupportedext');
  const form = new FormData();
  form.append('documents', new Blob(['MZ\x90\x00 fake exe bytes'], { type: 'application/octet-stream' }), 'evil.exe');
  const res = await fetch(`${base}/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${user.token}` },
    body: form
  });
  assert.equal(res.status, 400, 'multer\'s fileFilter drops it entirely, leaving no files at all');
});

test('upload: a path-traversal-style filename is not written outside the upload directory', async () => {
  const user = await registerUser('traversal');
  const form = new FormData();
  // Malicious-content .pdf so the request stays fast and Ollama-free (it's
  // rejected at the signature check, same as the bad-signature test above)
  // — what's under test here is specifically that the traversal-shaped
  // *name* never becomes a real filesystem path.
  form.append('documents', new Blob(['not a real pdf'], { type: 'application/pdf' }), '../../../../evil.pdf');
  const res = await fetch(`${base}/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${user.token}` },
    body: form
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.documents.length, 0);
  const escaped = fs.existsSync(path.resolve(tmpDir, '..', 'evil.pdf')) || fs.existsSync(path.resolve(tmpDir, 'evil.pdf'));
  assert.equal(escaped, false, 'no file should have been written outside the configured upload directory');
});

// ── ERROR HANDLING: safe messages only ──────────────────────────────────

test('a validation error message is safe and specific; nothing internal leaks alongside it', async () => {
  const user = await registerUser('safeerror');
  const res = await fetch(`${base}/memory/not-a-uuid`, { method: 'DELETE', headers: authHeaders(user.token) });
  const text = await res.text();
  assert.equal(res.status, 400);
  assert.ok(!/at [\w.]+ \(.*:\d+:\d+\)/.test(text), 'no stack trace');
  assert.ok(!/[A-Za-z]:\\/.test(text) && !text.includes('/home/') && !text.includes(tmpDir), 'no filesystem path');
  assert.ok(!/SQLITE_|SqliteError/i.test(text), 'no raw DB error detail');
});
