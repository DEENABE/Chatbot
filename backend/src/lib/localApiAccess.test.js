import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
process.env.APP_DATA_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'local-api-test-'));
process.env.CHANAKYA_DESKTOP_CHILD = '1';
process.env.CHANAKYA_CLIENT_SECRET = 'a'.repeat(64);
const { app } = await import('../app.js');
const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => {
  server.closeAllConnections();
  server.close();
});

test('sandboxed websites cannot use an opaque origin to register or call the desktop API', async () => {
  for (const route of ['/api/health', '/api/auth/register']) {
    const response = await fetch(base + route, {
      method: route.endsWith('register') ? 'POST' : 'GET',
      headers: { Origin: 'null' },
    });
    assert.equal(response.status, 403);
    assert.match((await response.json()).error, /client authentication/);
  }
  const wrong = await fetch(base + '/api/health', {
    headers: { Origin: 'null', 'X-Chanakya-Client': 'b'.repeat(64) },
  });
  assert.equal(wrong.status, 403);
});
test('the genuine desktop client, configured development UI and native health probes remain usable', async () => {
  for (const headers of [
    {},
    { Origin: 'http://localhost:5173' },
    { Origin: 'null', 'X-Chanakya-Client': process.env.CHANAKYA_CLIENT_SECRET },
  ]) {
    const response = await fetch(base + '/api/health', { headers });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).localOnly, true);
  }
  const preflight = await fetch(base + '/api/health', {
    method: 'OPTIONS',
    headers: {
      Origin: 'null',
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'X-Chanakya-Client',
    },
  });
  assert.equal(preflight.status, 204);
});
test('unrelated local web servers and DNS rebinding hosts are rejected before route execution', async () => {
  for (const headers of [
    { Origin: 'https://attacker.example' },
    { Origin: 'http://localhost:9999' },
  ]) {
    const response = await fetch(base + '/api/health', { headers });
    assert.equal(response.status, 403);
  }
  // Fetch normalizes Host on this Node runtime; use an actual raw HTTP Host header for the rebinding test.
  const status = await new Promise((resolve, reject) => {
    http
      .get(base + '/api/health', { headers: { Host: 'attacker.example:3001' } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      })
      .on('error', reject);
  });
  assert.equal(status, 403);
});
