import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, unlinkSync, rmdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Journal } from '../src/journal.mjs';
import { Executor } from '../src/executor.mjs';

function fixture(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'local-os-journal-test-'));
  const journal = new Journal(directory);
  t.after(() => { unlinkSync(journal.file); rmdirSync(directory); });
  return { directory, journal };
}
test('unfinished mutation blocks writes after process restart', async t => {
  const { directory, journal } = fixture(t);
  journal.append({ event: 'execute_started', executionId: 'interrupted', operation: 'theme.set' });
  const reopened = new Journal(directory);
  assert.equal(reopened.writesBlocked, true);
  const executor = new Executor({ autoLow: true }, { journal: reopened, runner: async () => assert.fail('must not execute') });
  const result = await executor.invoke('theme.set', { mode: 'dark' }, { allowChanges: true, sessionId: 's' });
  assert.equal(result.error.code, 'WRITES_BLOCKED');
});
test('known completion clears the latch but unknown completion remains blocked', t => {
  const { directory, journal } = fixture(t);
  journal.append({ event: 'execute_started', executionId: 'known' });
  journal.append({ event: 'execute_finished', executionId: 'known', outcomeUnknown: false });
  assert.equal(new Journal(directory).writesBlocked, false);
  journal.append({ event: 'execute_started', executionId: 'unknown' });
  journal.append({ event: 'execute_finished', executionId: 'unknown', outcomeUnknown: true });
  assert.equal(new Journal(directory).writesBlocked, true);
  journal.append({ event: 'operator_recovery', executionId: 'unknown' });
  assert.equal(new Journal(directory).writesBlocked, false);
});
test('persistent request IDs cannot be reclaimed', t => {
  const { directory, journal } = fixture(t);
  assert.equal(journal.claimRequest('id', 'hash'), true);
  assert.equal(new Journal(directory).claimRequest('id', 'different-hash'), false);
});
test('torn journal record fails closed', t => {
  const { directory, journal } = fixture(t);
  journal.append({ event: 'execute_started', executionId: 'id' });
  appendFileSync(journal.file, '{"partial":');
  assert.throws(() => new Journal(directory), /incomplete record/);
});
test('approved state is carried into the execution worker', async () => {
  const requests = [];
  const executor = new Executor({ autoLow: true }, { audit: async () => {}, runner: async req => {
    requests.push(req);
    return req.mode === 'preview' ? { ok: true, data: { enabled: true } } : { ok: true, status: 'verified' };
  } });
  const context = { allowChanges: true, sessionId: 's' };
  const proposed = await executor.invoke('firewall.set', { profiles: ['Public'], enabled: false }, context);
  await executor.approve(proposed.plan.id, context.sessionId);
  assert.deepEqual(requests.at(-1).expectedBefore, { enabled: true });
});
test('a healthy in-flight journal record queues concurrent writes instead of blocking them', async t => {
  const { journal } = fixture(t);
  let writes = 0;
  let entered;
  const running = new Promise(resolve => { entered = resolve; });
  const executor = new Executor({ autoLow: true }, { journal, runner: async () => {
    writes++; entered(); await new Promise(resolve => setTimeout(resolve, 25));
    return { ok: true, status: 'verified' };
  } });
  const context = { sessionId: 's', allowChanges: true };
  const first = executor.invoke('theme.set', { mode: 'dark' }, context);
  await running;
  const second = executor.invoke('theme.set', { mode: 'light' }, context);
  assert.equal((await first).ok, true); assert.equal((await second).ok, true);
  assert.equal(writes, 2); assert.equal(journal.writesBlocked, false);
});
