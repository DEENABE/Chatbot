import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const {
  checkBuildRequirements,
  parseBuildArguments,
} = require('../../scripts/build-preflight.cjs');
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chanakya build fixture '));
  const write = (file, content = '') => {
    const absolute = path.join(root, file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, typeof content === 'string' ? content : JSON.stringify(content));
  };
  write('frontend/package.json', { build: { electronVersion: '37.10.3' } });
  write('node_modules/electron/package.json', { version: '37.10.3' });
  for (const file of [
    'node_modules/electron/dist/electron.exe',
    'node_modules/vite/bin/vite.js',
    'node_modules/electron-builder/cli.js',
    'frontend/electron/preload.cjs',
    'frontend/scripts/prepare-backend.cjs',
  ])
    write(file);
  write('backend/package.json', { dependencies: { first: '1.0', second: '2.0' } });
  write('frontend/backend-runtime/package.json', { dependencies: { second: '2.0', first: '1.0' } });
  fs.mkdirSync(path.join(root, 'frontend/backend-runtime/node_modules'), { recursive: true });
  return { root, frontend: path.join(root, 'frontend'), write };
}
const platform = {
  platform: 'win32',
  architecture: 'x64',
  nodeVersion: '24.0.0',
  nativeProbe: false,
};

test('build preflight validates source, tools and isolated dependencies without creating output or requiring a GPU', () => {
  const current = fixture();
  try {
    const before = fs.readdirSync(current.frontend).sort();
    const result = checkBuildRequirements(current.frontend, ['--check'], platform);
    assert.equal(result.check, true);
    assert.equal(result.nativeChecked, false);
    assert.deepEqual(fs.readdirSync(current.frontend).sort(), before);
    assert.equal(fs.existsSync(result.output.directory), false);
  } finally {
    fs.rmSync(current.root, { recursive: true, force: true });
  }
});
test('preflight refuses mismatched Electron, user storage, used outputs and missing dependencies before mutations', () => {
  const scenarios = [
    [
      (f) => f.write('node_modules/electron/package.json', { version: '99.0.0' }),
      /differs from pinned/,
    ],
    [
      (f) => f.write('frontend/backend-runtime/storage/private.txt', 'private'),
      /contains user storage/,
    ],
    [(f) => f.write('frontend/release-test/old.exe', 'preserve'), /already contains files/],
    [(f) => fs.rmSync(path.join(f.root, 'node_modules/vite/bin/vite.js')), /Missing build input/],
    [
      (f) => f.write('frontend/backend-runtime/package.json', { dependencies: { wrong: '1' } }),
      /dependencies differ/,
    ],
  ];
  for (const [change, expected] of scenarios) {
    const current = fixture();
    try {
      change(current);
      assert.throws(
        () => checkBuildRequirements(current.frontend, ['--output-dir=release-test'], platform),
        expected,
      );
    } finally {
      fs.rmSync(current.root, { recursive: true, force: true });
    }
  }
});
test('native preflight uses Electron in Node mode with an in-memory SQLite probe and reports ABI failures clearly', () => {
  const current = fixture();
  try {
    let probe;
    checkBuildRequirements(current.frontend, ['--check'], {
      ...platform,
      nativeProbe: true,
      execute: (exe, args, options) => {
        probe = { exe, args, options };
      },
    });
    assert.match(probe.exe, /electron\.exe$/);
    assert.equal(probe.options.env.ELECTRON_RUN_AS_NODE, '1');
    assert.equal(probe.options.windowsHide, true);
    assert.match(probe.args[1], /:memory:/);
    assert.throws(
      () =>
        checkBuildRequirements(current.frontend, [], {
          ...platform,
          nativeProbe: true,
          execute: () => {
            throw new Error('NODE_MODULE_VERSION mismatch');
          },
        }),
      /native dependencies do not load in Electron/,
    );
  } finally {
    fs.rmSync(current.root, { recursive: true, force: true });
  }
});
test('preflight accepts --check with a safe output and rejects unknown, duplicate and traversing arguments', () => {
  assert.deepEqual(parseBuildArguments(['--output-dir=release-test', '--check']), {
    check: true,
    releaseArgs: ['--output-dir=release-test'],
  });
  assert.throws(() => parseBuildArguments(['--check', '--check']), /only once/);
  const current = fixture();
  try {
    for (const args of [
      ['--check', '--unknown'],
      ['--output-dir=../outside'],
      ['--output-dir=release-a', '--output-dir=release-b'],
    ])
      assert.throws(() => checkBuildRequirements(current.frontend, args, platform));
  } finally {
    fs.rmSync(current.root, { recursive: true, force: true });
  }
});
test(
  'rebuild.cmd finds Node without npm and preserves arguments when launched from a directory containing spaces',
  { skip: process.platform !== 'win32' },
  () => {
    const current = fixture();
    try {
      for (const name of ['rebuild.cmd', 'build-exe.cmd'])
        fs.copyFileSync(path.join(project, name), path.join(current.root, name));
      current.write(
        'frontend/scripts/build-release.cjs',
        `console.log(JSON.stringify({args:process.argv.slice(2),node:process.execPath}));`,
      );
      const result = spawnSync(
        process.env.ComSpec || 'cmd.exe',
        ['/d', '/s', '/c', `""${path.join(current.root, 'rebuild.cmd')}" --check"`],
        {
          cwd: os.tmpdir(),
          windowsHide: true,
        windowsVerbatimArguments: true,
          encoding: 'utf8',
          timeout: 10000,
          env: {
            ...process.env,
            CHANAKYA_NODE_EXE: process.execPath,
            CHANAKYA_NO_PAUSE: '1',
            PATH: process.env.SystemRoot + '\\System32',
          },
        },
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const event = result.stdout.split(/\r?\n/).find((line) => line.startsWith('{'));
      assert.deepEqual(JSON.parse(event).args, ['--check']);
      assert.equal(path.resolve(JSON.parse(event).node), path.resolve(process.execPath));
    } finally {
      fs.rmSync(current.root, { recursive: true, force: true });
    }
  },
);
