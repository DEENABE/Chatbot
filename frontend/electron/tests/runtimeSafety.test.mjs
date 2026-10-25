import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { prepareRuntimeStorage } from '../utils/runtimeStorage.js';
import { getBackendApiBaseUrl, setBackendEndpoint } from '../utils/runtimeEndpoint.js';
import { redactDiagnostics } from '../utils/redactDiagnostics.js';
import { waitForBackend } from '../services/BackendHealth.js';
import { reclaimStalePort, clearOwnPid } from '../../../backend/src/lib/portGuard.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { resolveReleaseOutput } = require('../../scripts/release-output.cjs');

test('legacy data copied once, sources and existing destination are preserved', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'chanakya-storage-test-'));
  try {
    const legacy = path.join(temp, 'legacy');
    await fs.mkdir(legacy);
    await fs.writeFile(path.join(legacy, 'db.sqlite'), 'original-fixture');
    const userData = path.join(temp, 'user');
    const result = await prepareRuntimeStorage(userData, [legacy]);
    assert.equal(result.migrated, true);
    assert.equal(
      await fs.readFile(path.join(result.dataRoot, 'storage', 'db.sqlite'), 'utf8'),
      'original-fixture',
    );
    assert.equal(await fs.readFile(path.join(legacy, 'db.sqlite'), 'utf8'), 'original-fixture');
    await fs.writeFile(path.join(result.dataRoot, 'storage', 'db.sqlite'), 'current-fixture');
    assert.equal((await prepareRuntimeStorage(userData, [legacy])).migrated, false);
    assert.equal(
      await fs.readFile(path.join(result.dataRoot, 'storage', 'db.sqlite'), 'utf8'),
      'current-fixture',
    );
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('migration into an empty storage directory and missing legacy source', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'chanakya-empty-storage-test-'));
  try {
    const user = path.join(temp, 'user');
    await fs.mkdir(path.join(user, 'backend-data', 'storage'), { recursive: true });
    const legacy = path.join(temp, 'legacy');
    await fs.mkdir(legacy);
    await fs.writeFile(path.join(legacy, 'history.json'), '[]');
    assert.equal(
      (await prepareRuntimeStorage(user, [path.join(temp, 'missing'), legacy])).migrated,
      true,
    );
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('endpoint validates a real local port and diagnostics redact credentials', () => {
  for (const port of [0, -1, 65536, '3001', 1.5]) assert.throws(() => setBackendEndpoint(port));
  assert.equal(setBackendEndpoint(13001), 'http://127.0.0.1:13001/api');
  assert.equal(getBackendApiBaseUrl(), 'http://127.0.0.1:13001/api');
  assert.equal(
    redactDiagnostics('password=abc token:xyz Authorization=Bearer secretvalue bridge-secret', [
      'bridge-secret',
    ]).includes('secretvalue'),
    false,
  );
});

test('a port/PID file never authorizes killing another live server', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'chanakya-port-test-'));
  const server = http.createServer((_req, res) => res.end('alive'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const pidFile = path.join(temp, 'pid');
    await fs.writeFile(pidFile, '12345');
    reclaimStalePort(pidFile, server.address().port);
    clearOwnPid(pidFile);
    assert.equal(await fs.readFile(pidFile, 'utf8'), '12345');
    assert.equal(await (await fetch(`http://127.0.0.1:${server.address().port}`)).text(), 'alive');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('health readiness handles success and a stalled local endpoint within its budget', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/ok') res.end('ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    await waitForBackend(`${url}/ok`, 500);
    const start = Date.now();
    await assert.rejects(waitForBackend(`${url}/stall`, 100), /did not respond/);
    assert.ok(Date.now() - start < 1500);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('release directories cannot traverse or select the workspace root', () => {
  for (const name of ['..', 'release-../data', 'C:\\users', 'release-a/b', 'release-a\\b'])
    assert.throws(() => resolveReleaseOutput('E:\\chatbot\\frontend', [`--output-dir=${name}`]));
  assert.match(resolveReleaseOutput('E:\\chatbot\\frontend').name, /^release-desktop-\d{14}$/);
});
