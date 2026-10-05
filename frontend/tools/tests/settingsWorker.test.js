import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { SettingsWorker } from '../services/SettingsWorker.js';
import { SystemSettingsService } from '../services/SystemSettingsService.js';

/** A fake PowerShell child: `onRequest(request, reply, child)` decides what the "helper" does with each request line. */
function fakeSpawn(onRequest) {
  const children = [];
  const spawnFn = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.ended = false;
    child.killed = false;
    child.reply = (message) => child.stdout.write(`${JSON.stringify(message)}\n`);
    child.kill = () => { child.killed = true; child.emit('close', null); };
    child.stdin.on('end', () => { child.ended = true; });
    let buffered = '';
    child.stdin.on('data', (chunk) => {
      buffered += chunk;
      let at;
      while ((at = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, at); buffered = buffered.slice(at + 1);
        onRequest(JSON.parse(line), child.reply, child);
      }
    });
    children.push(child);
    return child;
  };
  return { spawnFn, children };
}
const paths = () => ({ file: 'powershell.exe', script: 'SystemSettings.ps1' });
const worker = (onRequest, options = {}) => { const fake = fakeSpawn(onRequest); return { fake, worker: new SettingsWorker({ spawnFn: fake.spawnFn, paths, idleMs: 60_000, timeoutMs: 1_000, ...options }) }; };
const echo = (request, reply) => reply({ success: true, id: request.id, value: 42, requestId: request.requestId });

test('a request is answered by id and the request id never leaks to the caller', async () => {
  const { worker: w, fake } = worker(echo);
  const result = await w.call({ action: 'get', id: 'volume' });
  assert.deepEqual(result, { success: true, id: 'volume', value: 42 });
  assert.equal(fake.children.length, 1);
  w.close();
});

test('one warm process serves every call', async () => {
  const { worker: w, fake } = worker(echo);
  for (let i = 0; i < 5; i++) await w.call({ action: 'get', id: 'volume' });
  assert.equal(w.started, 1);
  assert.equal(fake.children.length, 1);
  w.close();
});

test('calls are serialised, because they change global system state', async () => {
  let active = 0, peak = 0;
  const { worker: w } = worker((request, reply) => {
    active += 1; peak = Math.max(peak, active);
    setTimeout(() => { active -= 1; echo(request, reply); }, 15);
  });
  await Promise.all([1, 2, 3, 4].map(() => w.call({ action: 'get', id: 'volume' })));
  assert.equal(peak, 1);
  w.close();
});

test('a failure reported by the helper becomes a coded error', async () => {
  const { worker: w } = worker((request, reply) => reply({ success: false, code: 'OUT_OF_RANGE', message: 'Value must be 10-100.', requestId: request.requestId }));
  await assert.rejects(w.call({ action: 'set', id: 'brightness', value: 5 }), (e) => e.code === 'OUT_OF_RANGE' && /10-100/.test(e.message));
  w.close();
});

test('a hung helper is killed, reported as a timeout, and replaced on the next call', async () => {
  let first = true;
  const { worker: w, fake } = worker((request, reply) => { if (first) { first = false; return; } echo(request, reply); }, { timeoutMs: 40 });
  await assert.rejects(w.call({ action: 'get', id: 'volume' }), (e) => e.code === 'SETTINGS_TIMEOUT');
  assert.equal(fake.children[0].killed, true);
  assert.deepEqual(await w.call({ action: 'get', id: 'volume' }), { success: true, id: 'volume', value: 42 });
  assert.equal(w.started, 2);
  w.close();
});

test('a helper that crashes mid-request is reported, then replaced', async () => {
  let first = true;
  const { worker: w } = worker((request, reply, child) => { if (first) { first = false; child.emit('close', 1); return; } echo(request, reply); });
  await assert.rejects(w.call({ action: 'get', id: 'volume' }), (e) => e.code === 'SETTINGS_HELPER_EXITED');
  assert.equal((await w.call({ action: 'get', id: 'volume' })).value, 42);
  assert.equal(w.started, 2);
  w.close();
});

test('a reply that belongs to a different request is ignored', async () => {
  const { worker: w } = worker((request, reply) => {
    reply({ success: true, id: 'stale', value: -1, requestId: request.requestId + 100 }); // late answer to an older request
    echo(request, reply);
  });
  assert.equal((await w.call({ action: 'get', id: 'volume' })).value, 42);
  w.close();
});

test('an idle worker exits by itself so it does not linger in memory', async () => {
  const { worker: w, fake } = worker(echo, { idleMs: 25 });
  await w.call({ action: 'get', id: 'volume' });
  assert.equal(fake.children[0].ended, false);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(fake.children[0].ended, true, 'stdin is closed, which ends the helper loop');
  assert.equal((await w.call({ action: 'get', id: 'volume' })).value, 42, 'and it starts again on demand');
  assert.equal(w.started, 2);
  w.close();
});

test('a missing helper script is reported with its own code and never spawns anything', async () => {
  const fake = fakeSpawn(echo);
  const w = new SettingsWorker({ spawnFn: fake.spawnFn, paths: () => { throw Object.assign(new Error('Desktop helper unavailable.'), { code: 'DESKTOP_HELPER_MISSING' }); } });
  await assert.rejects(w.call({ action: 'list' }), (e) => e.code === 'DESKTOP_HELPER_MISSING');
  assert.equal(fake.children.length, 0);
  // and the service turns that into the explanation the user sees
  const service = new SystemSettingsService({ request: () => ({}) }, null, { worker: w });
  await assert.rejects(service.list(), (e) => e.code === 'SETTINGS_HELPER_MISSING' && /antivirus/i.test(e.message));
});

test('end to end with the real PowerShell helper: read-only, one process, fast once warm', { skip: process.platform !== 'win32' }, async () => {
  const w = new SettingsWorker();
  try {
    const cold = await w.call({ action: 'get', id: 'dark-mode' });
    assert.equal(typeof cold.value, 'boolean');
    const t = performance.now();
    const warm = await w.call({ action: 'get', id: 'dark-mode' });
    const warmMs = performance.now() - t;
    assert.equal(warm.value, cold.value);
    assert.equal(w.started, 1, 'both calls were served by the same process');
    assert.ok(warmMs < 400, `a warm read took ${Math.round(warmMs)} ms`);
    await assert.rejects(w.call({ action: 'get', id: 'not-a-setting' }), (e) => e.code === 'UNKNOWN_SETTING');
    assert.equal((await w.call({ action: 'get', id: 'dark-mode' })).value, cold.value, 'the worker survives a rejected request');
  } finally { w.close(); }
});
