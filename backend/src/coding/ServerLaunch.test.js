import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'chanakya-server-launch-'));
process.env.APP_DATA_PATH = temporary;
const { asServerLaunch } = await import('./CodingAgentService.js');
const { db } = await import('../services/db.js');
test.after(async () => {
  db.close();
  await fs.rm(temporary, { recursive: true, force: true });
});

const run = (executable, args, extra = {}) => ({
  tool: 'exec.run',
  params: { executable, args, ...extra },
});

test('dev servers started with exec.run become background exec.start launches', () => {
  assert.deepEqual(asServerLaunch(run('npm', ['run', 'dev'], { cwd: '.', timeoutMs: 300000 })), {
    tool: 'exec.start',
    params: {
      executable: 'npm',
      args: ['run', 'dev', '--', '--host', '127.0.0.1', '--port', '5175', '--strictPort'],
      cwd: '.',
      port: 5175,
    },
  });
  assert.equal(asServerLaunch(run('npx', ['vite'])).tool, 'exec.start');
  assert.equal(asServerLaunch(run('npm.cmd', ['run', 'preview'])).params.port, 5175);
  const custom = asServerLaunch(run('npm', ['run', 'dev', '--', '--port', '3000'], { port: 3000 }));
  assert.deepEqual(custom.params.args, ['run', 'dev', '--', '--port', '3000']);
  assert.equal(custom.params.port, 3000);
});

test('commands that finish on their own stay exec.run', () => {
  assert.equal(asServerLaunch(run('npm', ['run', 'build'])), null);
  assert.equal(asServerLaunch(run('npm', ['start'])), null);
  assert.equal(asServerLaunch(run('npx', ['vite', 'build'])), null);
  assert.equal(asServerLaunch(run('python', ['-m', 'unittest'])), null);
  assert.equal(
    asServerLaunch({ tool: 'exec.start', params: { executable: 'npm', args: ['run', 'dev'] } }),
    null,
  );
});
