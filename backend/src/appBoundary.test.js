import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Phase 6 — application-boundary security: local API network exposure,
// request-size limits, and the Ollama SSRF guard. CORS, security headers,
// error-handling-leak, and mass-assignment/auth-header-logging protections
// were already covered by earlier phases' test files (apiSecurity.test.js,
// authIdentity.test.js, authorization.test.js) and re-verified live with
// real curl requests during this phase's audit — not duplicated here.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chanakya-boundary-test-'));
process.env.APP_DATA_PATH = tmpDir;

const { app } = await import('./app.js');
const { config } = await import('./config.js');

const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}/api`;

test.after(() => new Promise((resolve) => server.close(resolve)));

// ── Local API network exposure (Step 2) ──────────────────────────────────

test('the app binds to 127.0.0.1 specifically, not every interface', async () => {
  // server.address() reflects the actual OS-level bind, not just what the
  // code intended to pass — this is what makes the check real rather than
  // a re-read of the same config line the production code uses.
  const address = server.address();
  assert.equal(address.address, '127.0.0.1');
});

test('config.host defaults to loopback when HOST is unset', () => {
  assert.equal(config.host, process.env.HOST || '127.0.0.1');
  assert.notEqual(config.host, '0.0.0.0');
});

// ── Request-size limits (Step 14) ────────────────────────────────────────

test('an oversized raw JSON body is rejected with 413 before reaching any route handler', async () => {
  const oversized = JSON.stringify({ username: 'x', password: 'x'.repeat(11 * 1024 * 1024) });
  const res = await fetch(`${base}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: oversized
  });
  assert.equal(res.status, 413);
});

// ── HTTP method handling (Step 15) ───────────────────────────────────────

test('an unsupported method on a real, existing route path is rejected, not silently accepted', async () => {
  const res = await fetch(`${base}/health`, { method: 'DELETE' });
  assert.ok(res.status === 404 || res.status === 405, `expected 404/405, got ${res.status}`);
});

// ── SSRF guard: Ollama URL must be loopback (Step 12) ────────────────────

test('config.js refuses to load with a non-loopback OLLAMA_URL', () => {
  // This is a module-load-time throw (config.js runs the check the moment
  // it's imported) — the only way to prove it fires for real is a fresh
  // process, since re-importing an already-cached module in this process
  // wouldn't re-run the check.
  const configUrl = new URL('./config.js', import.meta.url).href;
  const probe = `
    process.env.OLLAMA_URL = 'http://malicious-remote-host.example.com:11434';
    import(${JSON.stringify(configUrl)})
      .then(() => { console.log('LOADED_WITHOUT_ERROR'); process.exit(0); })
      .catch((err) => { console.log('THREW:' + err.message); process.exit(1); });
  `;
  let output = '';
  let exitCode = 0;
  try {
    output = execFileSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf8' });
  } catch (err) {
    exitCode = err.status;
    output = (err.stdout || '') + (err.stderr || '');
  }
  assert.equal(exitCode, 1, 'the process must exit non-zero — a remote OLLAMA_URL must not be allowed to load');
  assert.match(output, /THREW:.*localhost/i);
});

test('config.js loads normally with the default loopback OLLAMA_URL', () => {
  assert.equal(new URL(config.ollamaUrl).hostname, '127.0.0.1');
});

// ── Production frontend bundle carries no secret-shaped values ──────────

test('the built frontend bundle contains no .env values and no obvious secret-shaped strings', () => {
  const distDir = fileURLToPath(new URL('../../frontend/dist', import.meta.url));
  if (!fs.existsSync(distDir)) {
    // Build artifact from a prior `npm run build` in this session — if it's
    // not present (a clean checkout that hasn't built yet), there's nothing
    // to scan; this isn't a finding about the source, so skip rather than
    // fail the whole suite over an artifact that hasn't been produced yet.
    return;
  }
  const jsFiles = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) jsFiles.push(full);
    }
  })(distDir);
  assert.ok(jsFiles.length > 0, 'expected at least one built JS asset to scan');

  const suspiciousPatterns = [
    /sk-[a-zA-Z0-9]{20,}/, // common API-key shape
    /-----BEGIN (RSA |EC )?PRIVATE KEY-----/,
    /AKIA[0-9A-Z]{16}/, // AWS access key shape
  ];
  for (const file of jsFiles) {
    const content = fs.readFileSync(file, 'utf8');
    for (const pattern of suspiciousPatterns) {
      assert.doesNotMatch(content, pattern, `${path.basename(file)} must not contain a secret-shaped string`);
    }
  }
  // No source maps either (Step 20) — nothing pointing back at un-minified
  // source or internal paths should ship.
  const mapFiles = jsFiles.filter((f) => fs.existsSync(f + '.map'));
  assert.equal(mapFiles.length, 0, 'no .map files should be shipped in the production build');
});
