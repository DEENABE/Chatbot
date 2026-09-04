import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

// Deliberately tight TRANSLATE limits — this file exists specifically to
// test translation throttling, in its own file (not inside
// translate.test.js) for the same cross-contamination reason the auth
// limiter tests are split per limiter: every other limiter stays generous
// here so incidental register/login calls can never 429 and fail an
// unrelated assertion.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chanakya-translate-rl-test-'));
process.env.APP_DATA_PATH = tmpDir;
process.env.AUTH_IP_MAX_ATTEMPTS = '100000';
process.env.AUTH_LOGIN_MAX_ATTEMPTS = '100000';
process.env.AUTH_RESET_REQUEST_MAX_ATTEMPTS = '100000';
process.env.AUTH_RESET_CONFIRM_MAX_ATTEMPTS = '100000';
process.env.AUTH_REGISTER_MAX_ATTEMPTS = '100000';
process.env.TRANSLATE_WINDOW_MS = '60000';
process.env.TRANSLATE_MAX_REQUESTS = '3';

// Stub the IndicTrans2 service so a hit that gets past the limiter
// succeeds quickly, speaking its documented {translation} contract.
const stubIndicTrans = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ translation: 'ok' }));
  });
});
await new Promise((resolve) => stubIndicTrans.listen(0, '127.0.0.1', resolve));
process.env.INDICTRANS_SERVICE_URL = `http://127.0.0.1:${stubIndicTrans.address().port}`;

const { app } = await import('../app.js');

const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/api`;

test.after(() => new Promise((resolve) => server.close(resolve)));
test.after(() => new Promise((resolve) => stubIndicTrans.close(resolve)));

async function registerUser(label) {
  const username = `${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const res = await fetch(`${base}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, displayName: label, password: 'correcthorsebatterystaple' })
  });
  const body = await res.json();
  assert.equal(res.status, 201);
  return body.token;
}

function attempt(token) {
  return fetch(`${base}/translate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Hello', sourceLanguage: 'eng_Latn', targetLanguage: 'tam_Taml' })
  });
}

test('translation is rate limited per user, and the budget is per-account not shared', async () => {
  const tokenA = await registerUser('rl_user_a');
  const tokenB = await registerUser('rl_user_b');

  // User A: 3 allowed, 4th blocked.
  for (let i = 1; i <= 3; i++) {
    const res = await attempt(tokenA);
    assert.equal(res.status, 200, `request ${i} within the budget should pass`);
  }
  const blocked = await attempt(tokenA);
  assert.equal(blocked.status, 429);
  const body = await blocked.json();
  assert.equal(body.error, 'Too many translation requests. Wait a minute and try again.');
  assert.ok(blocked.headers.get('ratelimit-limit') || blocked.headers.get('ratelimit'), 'standard RateLimit headers present');

  // User B arrives from the same IP (loopback, like every request in this
  // desktop app) but has their own untouched budget — proving the key is
  // the authenticated userId, not the IP.
  const other = await attempt(tokenB);
  assert.equal(other.status, 200, 'a different user must not inherit another account\'s exhausted budget');
});

test('a rate-limited response reveals nothing about the provider', async () => {
  const token = await registerUser('rl_user_c');
  for (let i = 0; i < 3; i++) await attempt(token);
  const res = await attempt(token);
  assert.equal(res.status, 429);
  const raw = JSON.stringify(await res.json());
  assert.ok(!/ollama|model|127\.0\.0\.1/i.test(raw));
});
