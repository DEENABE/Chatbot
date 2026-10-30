import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  syncBackendRuntime,
  runtimeDifferences,
} = require('../../scripts/sync-backend-runtime.cjs');

function fixture({ backend, runtime, installed = [] }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chanakya sync fixture '));
  const write = (file, value) => {
    const f = path.join(root, file);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(value));
  };
  write('backend/package.json', { name: 'local-ai-assistant', dependencies: backend });
  write('frontend/backend-runtime/package.json', {
    name: 'local-ai-assistant',
    dependencies: runtime,
  });
  fs.mkdirSync(path.join(root, 'frontend/backend-runtime/node_modules'), { recursive: true });
  for (const name of installed)
    write(`frontend/backend-runtime/node_modules/${name}/package.json`, { name });
  return { root, frontend: path.join(root, 'frontend') };
}

test('in-sync runtime: nothing is installed', () => {
  const f = fixture({
    backend: { a: '1', b: '2' },
    runtime: { b: '2', a: '1' },
    installed: ['a', 'b'],
  });
  try {
    let calls = 0;
    assert.deepEqual(syncBackendRuntime(f.frontend, { execute: () => calls++, log: () => {} }), {
      changed: false,
    });
    assert.equal(calls, 0);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('new backend dependencies are installed into the runtime with cache-first, no install scripts', () => {
  const f = fixture({
    backend: { a: '1', exceljs: '^4.4.0', jszip: '^3.10.2' },
    runtime: { a: '1' },
    installed: ['a', 'jszip'],
  });
  try {
    const calls = [];
    const execute = (file, args, options) => {
      calls.push({ file, args, cwd: options.cwd, offline: options.env.npm_config_offline });
      fs.mkdirSync(path.join(options.cwd, 'node_modules/exceljs'), { recursive: true });
      fs.writeFileSync(path.join(options.cwd, 'node_modules/exceljs/package.json'), '{}');
    };
    const r = syncBackendRuntime(f.frontend, {
      execute,
      log: () => {},
      env: { npm_config_offline: 'true' },
    });
    assert.deepEqual(r, { changed: true, installed: ['exceljs', 'jszip'] });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cwd, path.join(f.frontend, 'backend-runtime'));
    for (const flag of ['install', '--omit=dev', '--prefer-offline', '--ignore-scripts'])
      assert.ok(calls[0].args.includes(flag), flag);
    assert.equal(calls[0].offline, undefined, 'a missing package may be fetched once');
    const runtimePkg = JSON.parse(
      fs.readFileSync(path.join(f.frontend, 'backend-runtime/package.json'), 'utf8'),
    );
    assert.deepEqual(runtimePkg.dependencies, { a: '1', exceljs: '^4.4.0', jszip: '^3.10.2' });
    assert.equal(runtimeDifferences(f.frontend).inSync, true);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('a failed install stops the build with a clear message', () => {
  const f = fixture({
    backend: { a: '1', exceljs: '^4.4.0' },
    runtime: { a: '1' },
    installed: ['a'],
  });
  try {
    assert.throws(
      () =>
        syncBackendRuntime(f.frontend, {
          execute: () => {
            throw new Error('ENOTFOUND');
          },
          log: () => {},
        }),
      /Connect to the internet once and run rebuild\.cmd again/,
    );
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('a runtime holding user storage is never touched', () => {
  const f = fixture({ backend: { a: '1', b: '2' }, runtime: { a: '1' }, installed: ['a'] });
  try {
    fs.mkdirSync(path.join(f.frontend, 'backend-runtime/storage'));
    let calls = 0;
    assert.deepEqual(syncBackendRuntime(f.frontend, { execute: () => calls++, log: () => {} }), {
      changed: false,
    });
    assert.equal(calls, 0);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
