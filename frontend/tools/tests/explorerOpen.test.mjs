import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExplorerToolService } from '../fileexplorer/ExplorerToolService.js';
import { executionContext } from '../ExecutionContext.js';
import { createToolRegistry } from '../security/ToolRegistry.js';
import { modelPolicy } from '../repair/contract.js';

const run = (fn) => executionContext.run({ scope: 'renderer:user-1' }, fn);

async function service(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-open-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.mkdir(path.join(base, 'Desktop'));
  await fs.writeFile(path.join(base, 'note.txt'), 'x');
  const opened = [];
  const explorer = new ExplorerToolService(null, {
    knownFolder: (name) => path.join(base, name === 'desktop' ? 'Desktop' : 'Missing'),
    openFolder: async (target) => opened.push(target),
  });
  return { base, explorer, opened };
}

test('openLocation opens drives/folders and named locations without reading them', async (t) => {
  const { base, explorer, opened } = await service(t);
  const folder = await run(() => explorer.execute('openLocation', { path: base }));
  assert.equal(folder.success, true);
  assert.equal(folder.data.path, base);
  const desktop = await run(() => explorer.execute('openLocation', { location: 'desktop' }));
  assert.equal(desktop.data.path, path.join(base, 'Desktop'));
  assert.equal(desktop.data.location, 'desktop');
  const pc = await run(() => explorer.execute('openLocation', { location: 'thisPC' }));
  assert.equal(pc.data.location, 'thisPC');
  assert.deepEqual(opened, [base, path.join(base, 'Desktop'), 'shell:MyComputerFolder']);
});

test('openLocation refuses files, missing folders and ambiguous input', async (t) => {
  const { base, explorer, opened } = await service(t);
  await assert.rejects(
    run(() => explorer.execute('openLocation', { path: path.join(base, 'note.txt') })),
    {
      code: 'NOT_A_DIRECTORY',
    },
  );
  await assert.rejects(
    run(() => explorer.execute('openLocation', { location: 'music' })),
    {
      code: 'NOT_FOUND',
    },
  );
  await assert.rejects(
    run(() => explorer.execute('openLocation', {})),
    { code: 'INVALID_ARGUMENT' },
  );
  await assert.rejects(
    run(() => explorer.execute('openLocation', { path: base, location: 'desktop' })),
    { code: 'INVALID_ARGUMENT' },
  );
  assert.equal(opened.length, 0);
});

test('resolveLocation returns the real folder path', async (t) => {
  const { base, explorer } = await service(t);
  const result = await run(() => explorer.execute('resolveLocation', { location: 'desktop' }));
  assert.deepEqual(result.data, { location: 'desktop', path: path.join(base, 'Desktop') });
});

test('every explorer action has an explicit permission and is model-callable', async (t) => {
  const { explorer } = await service(t);
  const registry = createToolRegistry(new Map([['explorer', explorer]]));
  assert.equal(registry.get('explorer.listDirectory').risk, 'READ');
  assert.equal(registry.get('explorer.openLocation').risk, 'SAFE_WRITE');
  assert.equal(registry.get('explorer.approveRoot').risk, 'DANGEROUS');
  assert.ok(registry.get('explorer.calculateFolderSize').timeout >= 150000);
  for (const { action } of explorer.getActionList())
    assert.equal(modelPolicy('explorer', action), null, action);
});
