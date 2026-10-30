import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

test('hideChildConsoles defaults windowsHide for spawn/exec forms, keeps explicit false, and is idempotent', async () => {
  const cp = require('node:child_process');
  const seen = [];
  const fake = (name) =>
    function (...args) {
      seen.push([name, args]);
      return { fake: true };
    };
  const originals = {};
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync']) {
    originals[name] = cp[name];
    cp[name] = fake(name);
  }
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    const { hideChildConsoles } = await import('../utils/hideConsoles.js');
    hideChildConsoles();
    hideChildConsoles(); // second call must not double-wrap
    cp.spawn('powershell.exe', ['-Command', 'x']);
    cp.spawn('powershell.exe', ['-Command', 'x'], { stdio: 'pipe' });
    cp.spawn('notepad.exe', [], { windowsHide: false });
    cp.spawn('cmd.exe', { cwd: '.' });
    cp.exec('taskkill /pid 1', () => {});
    cp.exec('taskkill /pid 1');
    cp.execSync('netstat', { encoding: 'utf8' });
    cp.execFile('reg.exe', ['query'], () => {});
    const opts = seen.map(([, args]) =>
      args.find((a) => a && typeof a === 'object' && !Array.isArray(a)),
    );
    assert.equal(seen.length, 8, 'each call reaches the original exactly once');
    assert.equal(opts[0].windowsHide, true);
    assert.deepEqual(opts[1], { windowsHide: true, stdio: 'pipe' });
    assert.equal(opts[2].windowsHide, false, 'an explicit false is respected');
    assert.deepEqual(opts[3], { windowsHide: true, cwd: '.' });
    assert.equal(opts[4].windowsHide, true);
    assert.equal(typeof seen[4][1].at(-1), 'function', 'the callback stays last');
    assert.equal(opts[5].windowsHide, true);
    assert.deepEqual(opts[6], { windowsHide: true, encoding: 'utf8' });
    assert.equal(opts[7].windowsHide, true);
  } finally {
    Object.defineProperty(process, 'platform', platform);
    for (const [name, fn] of Object.entries(originals)) cp[name] = fn;
  }
});
