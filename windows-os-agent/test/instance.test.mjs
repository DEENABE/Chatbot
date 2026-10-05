import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { acquireInstance } from '../src/instance.mjs';

test('server and recovery cannot own the same directory simultaneously', async () => {
  const directory = path.join(os.tmpdir(), `os-instance-test-${randomUUID()}`);
  const release = await acquireInstance(directory);
  try { await assert.rejects(acquireInstance(directory), /Another server or recovery process/); }
  finally { await release(); }
  const releaseAgain = await acquireInstance(directory);
  await releaseAgain();
});
