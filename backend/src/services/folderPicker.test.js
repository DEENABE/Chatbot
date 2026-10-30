import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chooseFolderNative } from './folderPicker.js';

const fakeSpawn = (stdout, { stderr = '', calls = [] } = {}) => (cmd, args, opts) => {
  calls.push({ cmd, args, opts });
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => child.emit('close', null);
  setImmediate(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout, 'utf8'));
    if (stderr) child.stderr.emit('data', Buffer.from(stderr, 'utf8'));
    child.emit('close', 0);
  });
  return child;
};

test('returns the picked folder (unicode-safe) and uses the fixed system PowerShell without a shell', async () => {
  const calls = [];
  const r = await chooseFolderNative({ platform: 'win32', spawnImpl: fakeSpawn('OK:D:\\திட்டம்\\my app', { calls }) });
  assert.deepEqual(r, { cancelled: false, root: 'D:\\திட்டம்\\my app' });
  assert.match(calls[0].cmd, /System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i);
  assert.ok(calls[0].args.includes('-STA'));
  assert.equal(calls[0].opts.shell, false);
});

test('cancel, failure and non-Windows are reported without a path', async () => {
  assert.deepEqual(await chooseFolderNative({ platform: 'win32', spawnImpl: fakeSpawn('CANCEL') }), {
    cancelled: true,
    root: null,
  });
  const failed = await chooseFolderNative({ platform: 'win32', spawnImpl: fakeSpawn('', { stderr: 'boom\nmore' }) });
  assert.equal(failed.cancelled, true);
  assert.match(failed.error, /boom/);
  assert.equal((await chooseFolderNative({ platform: 'linux' })).unsupported, true);
});

test('two clicks share one dialog', async () => {
  const calls = [];
  const spawnImpl = fakeSpawn('OK:C:\\a', { calls });
  const [a, b] = await Promise.all([
    chooseFolderNative({ platform: 'win32', spawnImpl }),
    chooseFolderNative({ platform: 'win32', spawnImpl }),
  ]);
  assert.equal(calls.length, 1);
  assert.deepEqual(a, b);
});
