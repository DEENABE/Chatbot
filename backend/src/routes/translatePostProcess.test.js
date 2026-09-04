import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

// Isolated in its own file/process because TRANSLATION_POST_PROCESSING must
// be 'true' for these tests, and config.js reads env once at import time —
// the same reason rateLimiter.test.js/rateLimiterRegister.test.js are
// already split. translate.test.js covers the (default) disabled path.

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chanakya-translate-postproc-test-'));
process.env.APP_DATA_PATH = tmpDir;
process.env.AUTH_IP_MAX_ATTEMPTS = '100000';
process.env.AUTH_LOGIN_MAX_ATTEMPTS = '100000';
process.env.AUTH_RESET_REQUEST_MAX_ATTEMPTS = '100000';
process.env.AUTH_RESET_CONFIRM_MAX_ATTEMPTS = '100000';
process.env.AUTH_REGISTER_MAX_ATTEMPTS = '100000';
process.env.TRANSLATE_MAX_REQUESTS = '100000';
process.env.TRANSLATION_POST_PROCESSING = 'true';
process.env.TRANSLATION_POST_PROCESSING_TIMEOUT_MS = '300';

// ── Stub IndicTrans2 (primary engine — always succeeds here) ─────────────
const stubIndicTrans = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', models_loaded: {}, device: 'cpu' }));
      return;
    }
    const body = JSON.parse(raw || '{}');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ translation: `RAW(${body.text})` }));
  });
});
await new Promise((resolve) => stubIndicTrans.listen(0, '127.0.0.1', resolve));
process.env.INDICTRANS_SERVICE_URL = `http://127.0.0.1:${stubIndicTrans.address().port}`;

// ── Stub Ollama (post-processing) — behavior driven by markers in the text
// IT RECEIVES (i.e. the raw IndicTrans2 output, "RAW(...)") ──────────────
let ollamaCalls = 0;
let lastOllamaBody = null;
const stubOllama = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    ollamaCalls += 1;
    const body = JSON.parse(raw || '{}');
    lastOllamaBody = body;
    const userText = body.messages.find((m) => m.role === 'user')?.content || '';

    if (userText.includes('FAIL_POSTPROCESS')) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('post-process provider failure');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: { role: 'assistant', content: `POLISHED(${userText})` } }));
  });
});
await new Promise((resolve) => stubOllama.listen(0, '127.0.0.1', resolve));
process.env.OLLAMA_URL = `http://127.0.0.1:${stubOllama.address().port}`;

const { app } = await import('../app.js');

const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/api`;

test.after(() => new Promise((resolve) => server.close(resolve)));
test.after(() => new Promise((resolve) => stubIndicTrans.close(resolve)));
test.after(() => new Promise((resolve) => stubOllama.close(resolve)));

async function registerUser() {
  const username = `postproc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const res = await fetch(`${base}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, displayName: 'x', password: 'correcthorsebatterystaple' })
  });
  const body = await res.json();
  assert.equal(res.status, 201);
  return body.token;
}

const token = await registerUser();

async function translate(text) {
  const res = await fetch(`${base}/translate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, sourceLanguage: 'eng_Latn', targetLanguage: 'tam_Taml' })
  });
  return { res, body: await res.json() };
}

test('when enabled, the final response is Qwen3-polished, and Ollama was actually called', async () => {
  const before = ollamaCalls;
  const { res, body } = await translate('Hello');
  assert.equal(res.status, 200);
  // IndicTrans2 stub returns RAW(Hello); post-processing wraps it again.
  assert.equal(body.translation, 'POLISHED(RAW(Hello))');
  assert.equal(ollamaCalls, before + 1, 'Ollama must actually have been called');
});

test('the post-processing call is a system+user split, IndicTrans2 output only as the user message', async () => {
  await translate('Isolation check');
  assert.equal(lastOllamaBody.messages.length, 2);
  assert.equal(lastOllamaBody.messages[0].role, 'system');
  assert.equal(lastOllamaBody.messages[1].role, 'user');
  assert.equal(lastOllamaBody.messages[1].content, 'RAW(Isolation check)');
  assert.ok(/already been translated|do not re-translate/i.test(lastOllamaBody.messages[0].content));
});

test('post-processing failure is non-fatal: falls back to the unpolished IndicTrans2 output, still 200', async () => {
  const { res, body } = await translate('FAIL_POSTPROCESS trigger');
  assert.equal(res.status, 200);
  assert.equal(body.translation, 'RAW(FAIL_POSTPROCESS trigger)', 'must fall back to the raw translation, not error out');
});
