import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { runPowerShell } from '../src/runner.mjs';

function fakeSpawn(onInput) {
  return (file, args, options) => {
    assert.equal(options.shell, false);
    assert.ok(args.includes('-File'));
    assert.equal(args.includes('-Command'), false);
    assert.equal(options.env.AGENT_TOKEN, undefined);
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.kill = () => child.emit('close', 1);
    let input = '';
    child.stdin.on('data', d => { input += d; });
    child.stdin.on('end', () => onInput(child, input));
    return child;
  };
}
test('model arguments go through JSON stdin, never executable arguments', async () => {
  const dangerous = 'x"; Remove-Item C:\\ -Recurse; #';
  const result = await runPowerShell({ operation: 'wifi.connect', parameters: { profile: dangerous } }, {
    spawnImpl: fakeSpawn((child, input) => { assert.equal(JSON.parse(input).parameters.profile, dangerous); child.stdout.end('{"ok":true,"data":{}}'); child.emit('close', 0); })
  });
  assert.equal(result.ok, true);
});
test('invalid worker output is an unknown outcome, not success', async () => {
  const result = await runPowerShell({}, { spawnImpl: fakeSpawn(child => { child.stdout.end('not json'); child.emit('close', 0); }) });
  assert.equal(result.error.code, 'TOOL_PROTOCOL_ERROR'); assert.equal(result.error.outcomeUnknown, true);
});
test('hung worker terminates at its deadline', async () => {
  const result = await runPowerShell({}, { timeout: 20, spawnImpl: fakeSpawn(() => {}) });
  assert.equal(result.error.code, 'TIMEOUT'); assert.equal(result.error.outcomeUnknown, true);
});
test('cancelled requests never spawn', async () => {
  const controller = new AbortController(); controller.abort();
  const result = await runPowerShell({}, { signal: controller.signal, spawnImpl: () => assert.fail('must not spawn') });
  assert.equal(result.error.code, 'CANCELLED');
  assert.equal(result.error.outcomeUnknown, false);
});
test('Unicode device names survive UTF-8 chunk boundaries', async () => {
  const name = 'தமிழ் 音声';
  const bytes = Buffer.from(JSON.stringify({ ok: true, data: { name } }));
  const result = await runPowerShell({}, { spawnImpl: fakeSpawn(child => {
    for (const byte of bytes) child.stdout.write(Buffer.from([byte]));
    child.stdout.end(); child.emit('close', 0);
  }) });
  assert.equal(result.data.name, name);
});
