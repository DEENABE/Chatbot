import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runFixtureBenchmark,
  runLiveReadBenchmark,
  runLiveCancellationBenchmark,
} from './benchmark.js';
import { fileVersion, relativeWorkspacePath } from './WorkspaceFiles.js';

// Test-only transport. Production benchmark defaults to the native Windows guard.
async function fixtureGuard(request) {
  const relative = relativeWorkspacePath(request.path || '', {
    allowEmpty: ['list', 'inspect'].includes(request.operation),
  });
  const target = path.join(request.root, relative);
  if (request.operation === 'mkdir') {
    await fs.mkdir(target, { recursive: true });
    return { changed: true, path: relative };
  }
  if (request.operation === 'read') {
    const bytes = await fs.readFile(target);
    return {
      contentBase64: bytes.toString('base64'),
      version: fileVersion(bytes),
      size: bytes.length,
    };
  }
  if (request.operation === 'write') {
    let before = null;
    try {
      before = await fs.readFile(target);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (
      (request.expectedVersion === 'new' && before) ||
      (request.expectedVersion !== 'new' &&
        (!before || fileVersion(before) !== request.expectedVersion))
    )
      throw new Error('Fixture version conflict');
    const bytes = Buffer.from(request.content);
    await fs.writeFile(target, bytes, { flag: request.expectedVersion === 'new' ? 'wx' : 'w' });
    return {
      beforeContentBase64: before?.toString('base64') || null,
      beforeVersion: before ? fileVersion(before) : 'new',
      version: fileVersion(bytes),
      size: bytes.length,
      changed: true,
    };
  }
  if (request.operation === 'list') {
    const entries = [];
    const walk = async (directory) => {
      for (const item of await fs.readdir(directory, { withFileTypes: true })) {
        const full = path.join(directory, item.name);
        entries.push({
          path: path.relative(request.root, full).replaceAll(path.sep, '/'),
          type: item.isDirectory() ? 'directory' : 'file',
          size: item.isDirectory() ? 0 : (await fs.stat(full)).size,
        });
        if (item.isDirectory() && request.recursive) await walk(full);
      }
    };
    await walk(target);
    return { entries, errors: [], truncated: false };
  }
  throw new Error('Fixture guard does not implement this operation');
}

test('repeatable fixture benchmark reports actual file checks separately from unexecuted validation', async () => {
  const result = await runFixtureBenchmark({ guard: fixtureGuard });
  assert.equal(result.mode, 'fixture');
  assert.equal(result.cases.length, 3);
  assert.deepEqual(
    result.cases.map((item) => item.status),
    ['passed', 'passed', 'passed'],
  );
  assert.equal(result.fileWorkflowPassRate, 1);
  assert.equal(result.testPassRate, null);
  assert.equal(result.buildSuccessRate, null);
  assert.ok(
    result.cases.every(
      (item) =>
        item.tests === 'not_run' && item.build === 'not_run' && item.modelTokenUsage === null,
    ),
  );
  assert.ok(
    result.cases.every(
      (item) => !item.toolCalls.some((call) => ['exec.run', 'tests.run'].includes(call.tool)),
    ),
  );
});

test('live benchmark and cancellation require explicit model selection', async () => {
  await assert.rejects(runLiveReadBenchmark(), /explicitly selected/);
  await assert.rejects(runLiveCancellationBenchmark(), /selected local model/);
});
