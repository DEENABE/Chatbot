import test from 'node:test';
import assert from 'node:assert/strict';
import { RepeatGuard } from './RepeatGuard.js';

const list = (path = '') => ({ tool: 'fs.list', params: { path } });

test('first read-only call runs, an identical repeat on unchanged state is blocked', () => {
  const guard = new RepeatGuard();
  assert.equal(guard.check(list(), 's1'), null);
  const blocked = guard.check(list(), 's1');
  assert.equal(blocked.exhausted, false);
  assert.match(blocked.message, /fs\.write/);
});

test('equivalent root spellings count as the same call', () => {
  const guard = new RepeatGuard();
  guard.check(list(''), 's1');
  for (const alias of ['.', './', '.\\', ''])
    assert.ok(guard.check(list(alias), 's1'), `alias ${JSON.stringify(alias)}`);
});

test('a changed project state allows the call again and resets the nudge count', () => {
  const guard = new RepeatGuard({ maxNudges: 1 });
  guard.check(list(), 's1');
  assert.equal(guard.check(list(), 's1').exhausted, false);
  assert.equal(guard.check(list(), 's1').exhausted, true);
  assert.equal(guard.check(list(), 's2'), null);
  assert.equal(guard.check(list(), 's2').exhausted, false);
});

test('an identical write on unchanged state is a repeat; other writes, commands and paths are not', () => {
  const guard = new RepeatGuard();
  const write = {
    tool: 'fs.write',
    params: { path: 'a.py', content: 'x', expectedVersion: 'new' },
  };
  assert.equal(guard.check(write, 's1'), null);
  assert.ok(guard.check(write, 's1'), 'same write, nothing changed since');
  assert.equal(guard.check(write, 's2'), null, 'project changed, so the write is new information');
  const other = {
    tool: 'fs.write',
    params: { path: 'b.py', content: 'x', expectedVersion: 'new' },
  };
  assert.equal(guard.check(other, 's2'), null);
  assert.equal(guard.check({ tool: 'exec.output', params: { jobId: 'j' } }, 's1'), null);
  assert.equal(guard.check({ tool: 'exec.output', params: { jobId: 'j' } }, 's1'), null);
  guard.check(list('src'), 's1');
  assert.equal(guard.check(list('tests'), 's1'), null);
});

test('persistent repeating is reported as exhausted after maxNudges', () => {
  const guard = new RepeatGuard({ maxNudges: 3 });
  guard.check(list(), 's');
  const results = [1, 2, 3, 4].map(() => guard.check(list(), 's').exhausted);
  assert.deepEqual(results, [false, false, false, true]);
});
