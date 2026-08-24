import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

// Phase 9 — AI resource abuse + a couple of small app-boundary decisions
// (stats auth, transcribe rate limit). Real HTTP requests against the live
// Express app, same convention as earlier phases. Does not repeat Phase
// 5/7's file-validation or oversized-message tests (still covered by
// apiSecurity.test.js/documentPipeline.test.js) — this is specifically
// about the resource-exhaustion angle: can one client make the server do
// an unbounded amount of expensive work.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chanakya-resourceabuse-test-'));
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

// ── Agent maxSteps — every edge case, verified live ──────────────────────

test('agent maxSteps: every invalid shape is rejected before any step runs', async () => {
  const user = await registerUser('maxstepsInvalid');
  const invalidCases = [0, -5, 999999999, 'ten', 3.7];
  for (const maxSteps of invalidCases) {
    const res = await fetch(`${base}/agent`, {
      method: 'POST', headers: authHeaders(user.token),
      body: JSON.stringify({ goal: 'diagnose slow wifi', maxSteps })
    });
    assert.equal(res.status, 400, `maxSteps=${JSON.stringify(maxSteps)} should be rejected`);
  }
});

test('agent maxSteps: the documented ceiling (50) is accepted, one above it is not', async () => {
  const user = await registerUser('maxstepsCeiling');
  const atCeiling = await fetch(`${base}/agent`, {
    method: 'POST', headers: authHeaders(user.token),
    body: JSON.stringify({ goal: 'diagnose slow wifi', maxSteps: 50 })
  });
  assert.equal(atCeiling.status, 200);
  atCeiling.body?.cancel?.();

  const aboveCeiling = await fetch(`${base}/agent`, {
    method: 'POST', headers: authHeaders(user.token),
    body: JSON.stringify({ goal: 'diagnose slow wifi', maxSteps: 51 })
  });
  assert.equal(aboveCeiling.status, 400);
});

test('agent maxSteps: absent falls back to the loop\'s own default, not unlimited', async () => {
  const user = await registerUser('maxstepsAbsent');
  const res = await fetch(`${base}/agent`, {
    method: 'POST', headers: authHeaders(user.token),
    body: JSON.stringify({ goal: 'diagnose slow wifi' })
  });
  assert.equal(res.status, 200);
  res.body?.cancel?.();
});

// Same validation function backs /api/repair — confirm it isn't only wired
// up on one of the two routes that share it.
test('repair maxSteps: the same bound applies', async () => {
  const user = await registerUser('repairMaxsteps');
  const res = await fetch(`${base}/repair`, {
    method: 'POST', headers: authHeaders(user.token),
    body: JSON.stringify({ goal: 'diagnose slow wifi', maxSteps: 999999999 })
  });
  assert.equal(res.status, 400);
});

// ── /api/stats — now requires auth ───────────────────────────────────────

test('stats requires authentication', async () => {
  const res = await fetch(`${base}/stats`);
  assert.equal(res.status, 401);
});

test('stats works normally once authenticated', async () => {
  const user = await registerUser('statsAuthed');
  const res = await fetch(`${base}/stats`, { headers: authHeaders(user.token) });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(typeof body.cpu === 'number');
});

// ── /api/transcribe — now rate-limited like chat/agent/repair ───────────

test('transcribe carries the same rate-limit headers chat/agent/repair already have', async () => {
  const user = await registerUser('transcribeRateLimit');
  const form = new FormData();
  form.append('audio', new Blob([new Uint8Array(44)], { type: 'audio/wav' }), 'clip.wav');
  const res = await fetch(`${base}/transcribe`, {
    method: 'POST', headers: { Authorization: `Bearer ${user.token}` }, body: form
  });
  // Whatever the transcription outcome (a 44-byte fixture isn't a real WAV,
  // so this may well fail downstream) — what's under test is that the
  // request passed through askLimiter at all, which stamps these headers
  // on every response, pass or fail.
  assert.ok(res.headers.get('ratelimit-limit') || res.headers.get('x-ratelimit-limit'), 'expected rate-limit headers on the response');
});

// ── /api/usage — legacy dead route ───────────────────────────────────────

test('the legacy /api/usage route is gone, not lingering unauthenticated', async () => {
  const res = await fetch(`${base}/usage/anything`);
  assert.equal(res.status, 404);
});

// ── Concurrency: the shared askLimiter actually bounds a burst ──────────

test('a burst of concurrent chat requests is bounded by the existing rate limiter, not left unlimited', async () => {
  const user = await registerUser('concurrentBurst');
  // askLimiter is 20/min, shared per-IP across chat/agent/repair — send
  // comfortably more than that at once and confirm at least one is
  // throttled rather than the server just accepting an unbounded burst.
  const requests = Array.from({ length: 25 }, () =>
    fetch(`${base}/chat`, {
      method: 'POST', headers: authHeaders(user.token),
      body: JSON.stringify({ message: '', history: [] })
    }).then((r) => { r.body?.cancel?.(); return r.status; })
  );
  const statuses = await Promise.all(requests);
  assert.ok(statuses.includes(429), `expected at least one 429 in a burst of ${statuses.length}, got: ${statuses.join(',')}`);
  assert.ok(statuses.every((s) => s === 200 || s === 429), 'every response must be a clean, handled status — no crash, no hang');
});

test('the server stays responsive immediately after an oversized concurrent burst', async () => {
  // If the burst above had exhausted something (event loop, connection
  // pool, an unbounded queue) a normal follow-up request would hang or
  // fail — it must not.
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
});
