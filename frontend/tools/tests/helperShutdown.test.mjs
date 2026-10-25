import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn, stopOwnedHelpers } from '../ExecutionContext.js';
test('desktop shutdown stops only helper processes created by this runtime', async () => {
  const child = spawn(
    process.execPath,
    ['-e', "console.log('fixture-ready');setTimeout(()=>{},60000)"],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  await once(child.stdout, 'data');
  const closed = once(child, 'close');
  const start = Date.now();
  stopOwnedHelpers();
  await closed;
  assert.ok(Date.now() - start < 5000);
  assert.notEqual(child.exitCode, 0);
});
