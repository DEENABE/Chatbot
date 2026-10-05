import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { catalog, validateOperation } from '../src/catalog.mjs';
import { Executor } from '../src/executor.mjs';
import { runAgent } from '../src/agent.mjs';

const config = { autoLow: true, uia: false, maxSteps: 4, toolTimeout: 1000 };
const context = { sessionId: 'test-session', allowChanges: true };
const create = runner => new Executor(config, { runner, audit: async () => {} });

test('catalog rejects unknown commands, wrong types, extra keys and out-of-range values', () => {
  for (const [id, args] of [
    ['powershell', { script: 'Format-Volume C' }], ['audio.volume', { percent: 101 }],
    ['audio.volume', { percent: '50' }], ['theme.set', { mode: 'dark', command: 'cmd.exe' }],
    ['network.dns', { interfaceIndex: 1, reset: false, servers: ['8.8.8.8;whoami'] }],
    ['network.dns', { interfaceIndex: 1, reset: true, servers: ['8.8.8.8'] }],
    ['network.ipv4', { interfaceIndex: 1, mode: 'static' }],
    ['network.ipv4', { interfaceIndex: 1, mode: 'dhcp', gateway: '1.1.1.1' }],
    ['registry.set', { target: 'apps-light-theme', value: {} }], ['audio.volume', {}]
  ]) assert.throws(() => validateOperation(id, args), `${id} should reject ${JSON.stringify(args)}`);
});

test('approved schemas accept legitimate values without string evaluation', () => {
  assert.equal(validateOperation('network.dns', { interfaceIndex: 14, reset: false, servers: ['1.1.1.1', '2606:4700:4700::1111'] }).risk, 'high');
  assert.equal(validateOperation('theme.set', { mode: 'dark' }).risk, 'low');
});

test('PowerShell allowlist matches JavaScript catalog', async () => {
  const manifest = JSON.parse(await readFile(new URL('../config/operations.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest, Object.values(catalog).map(({ id, risk, engine, uri }) => ({ id, risk, engine, uri })));
});

test('read-only context cannot mutate even a low-risk setting', async () => {
  let calls = 0;
  const executor = create(async () => { calls++; return { ok: true }; });
  const result = await executor.invoke('theme.set', { mode: 'dark' }, { ...context, allowChanges: false });
  assert.equal(result.error.code, 'CHANGES_NOT_AUTHORIZED'); assert.equal(calls, 0);
});

test('registry/service policy is enforced before spawning any process', async () => {
  let calls = 0;
  const executor = create(async () => { calls++; });
  for (const [operation, parameters] of [
    ['service.set', { name: 'WinDefend', action: 'stop' }],
    ['registry.set', { target: 'HKLM:\\SAM', value: 1 }],
    ['registry.set', { target: 'apps-light-theme', value: 20 }],
    ['registry.set', { target: 'machine-build', value: 'evil' }]
  ]) assert.equal((await executor.invoke(operation, parameters, context)).ok, false);
  assert.equal(calls, 0);
});

test('high-risk plans bind parameters, session, state and one-use approval', async () => {
  let writes = 0;
  const executor = create(async req => req.mode === 'preview' ? { ok: true, data: { enabled: true } } : (writes++, { ok: true, status: 'verified' }));
  const parameters = { profiles: ['Public'], enabled: false };
  const proposed = await executor.invoke('firewall.set', parameters, context);
  assert.equal(proposed.status, 'approval_required'); assert.equal(writes, 0);
  parameters.enabled = true; // Mutable caller input cannot alter the stored plan.
  const id = proposed.plan.id;
  assert.equal(executor.plans.get(id).parameters.enabled, false);
  assert.equal((await executor.approve(id, 'different-session')).error.code, 'PLAN_NOT_FOUND');
  assert.equal((await executor.approve(id, context.sessionId)).status, 'verified');
  assert.equal((await executor.approve(id, context.sessionId)).error.code, 'PLAN_CONSUMED');
  assert.equal(writes, 1);
});

test('stale and expired plans do not execute', async () => {
  let state = 1, writes = 0;
  const executor = create(async req => req.mode === 'preview' ? { ok: true, data: { state } } : (writes++, { ok: true }));
  const result = await executor.invoke('firewall.set', { profiles: ['Public'], enabled: true }, context);
  state = 2;
  assert.equal((await executor.approve(result.plan.id, context.sessionId)).error.code, 'STATE_CHANGED');
  const expired = await executor.invoke('firewall.set', { profiles: ['Public'], enabled: true }, context);
  executor.plans.get(expired.plan.id).expiresAt = 1;
  assert.equal((await executor.approve(expired.plan.id, context.sessionId)).error.code, 'PLAN_EXPIRED');
  assert.equal(writes, 0);
});

test('mutations are globally serialized and unknown outcomes block further writes', async () => {
  let running = 0, max = 0;
  const executor = create(async () => { running++; max = Math.max(max, running); await new Promise(r => setTimeout(r, 10)); running--; return { ok: true }; });
  await Promise.all([executor.invoke('theme.set', { mode: 'dark' }, context), executor.invoke('theme.set', { mode: 'light' }, context)]);
  assert.equal(max, 1);
  executor.runner = async () => ({ ok: false, error: { code: 'TIMEOUT', outcomeUnknown: true } });
  await executor.invoke('theme.set', { mode: 'dark' }, context);
  assert.equal((await executor.invoke('theme.set', { mode: 'light' }, context)).error.code, 'WRITES_BLOCKED');
});

test('audit write failure prevents execution', async () => {
  let executed = false;
  const executor = new Executor(config, { runner: async () => { executed = true; }, audit: async () => { throw new Error('disk full'); } });
  await executor.invoke('theme.set', { mode: 'dark' }, context);
  assert.equal(executed, false);
});

test('fallback is allowed only for capability absence, never denial or partial execution', async () => {
  for (const [code, unknown, expectedCalls] of [['UNSUPPORTED_HARDWARE', false, 2], ['ACCESS_DENIED', false, 1], ['WINDOWS_ERROR', false, 1], ['UNSUPPORTED_HARDWARE', true, 1]]) {
    let calls = 0;
    const executor = new Executor({ ...config, uia: true }, { runner: async req => {
      calls++;
      return req.engine === 'uia' ? { ok: true, status: 'verified' } : { ok: false, error: { code, outcomeUnknown: unknown } };
    }, audit: async () => {} });
    await executor.invoke('brightness.set', { instance: 'test-monitor', percent: 40 }, context);
    assert.equal(calls, expectedCalls, code);
  }
});

test('registry prototype names cannot bypass target allowlist', async () => {
  const executor = create(async () => assert.fail('must not spawn'));
  for (const target of ['__proto__', 'constructor', 'toString']) assert.equal((await executor.invoke('registry.get', { target }, context)).ok, false);
});

test('Ollama loop retains assistant tool calls and returns native tool_name messages', async () => {
  let step = 0;
  const session = { id: 's', messages: [] };
  const call = { role: 'assistant', content: '', thinking: 'inspect', tool_calls: [{ function: { name: 'run_operation', arguments: { operation: 'audio.inspect', parameters: {} } } }] };
  const chat = async (_, history) => {
    if (step++ === 0) return call;
    assert.deepEqual(history.at(-2), call);
    assert.equal(history.at(-1).role, 'tool'); assert.equal(history.at(-1).tool_name, 'run_operation');
    assert.equal(JSON.parse(history.at(-1).content).data.percent, 40);
    return { role: 'assistant', content: 'Volume is 40%.' };
  };
  const executor = create(async () => ({ ok: true, data: { percent: 40 } }));
  const result = await runAgent({ session, message: 'volume?', allowChanges: false, executor, config, chat });
  assert.equal(result.answer, 'Volume is 40%.'); assert.equal(session.messages.length, 2);
});

test('malformed calls enter LLM context as errors instead of crashing', async () => {
  let step = 0;
  const chat = async (_, history) => {
    if (step++ === 0) return { role: 'assistant', tool_calls: [{ function: { name: 'run_operation', arguments: '{broken' } }] };
    assert.equal(JSON.parse(history.at(-1).content).error.code, 'INVALID_TOOL_CALL');
    return { role: 'assistant', content: 'Invalid request.' };
  };
  await runAgent({ session: { id: 's', messages: [] }, message: 'test', executor: create(async () => assert.fail('No spawn expected')), config, chat });
});

test('pending approval stops remaining tool calls in the same batch', async () => {
  let writes = 0;
  const executor = create(async req => req.mode === 'preview' ? { ok: true, data: { state: 1 } } : (writes++, { ok: true }));
  const chat = async () => ({ role: 'assistant', tool_calls: [
    { function: { name: 'run_operation', arguments: { operation: 'firewall.set', parameters: { profiles: ['Public'], enabled: false } } } },
    { function: { name: 'run_operation', arguments: { operation: 'theme.set', parameters: { mode: 'dark' } } } }
  ] });
  const result = await runAgent({ session: { id: 's', messages: [] }, message: 'test', allowChanges: true, executor, config, chat });
  assert.equal(result.events.length, 1); assert.equal(writes, 0);
});

test('step budget terminates a looping model', async () => {
  let calls = 0;
  const chat = async () => { calls++; return { role: 'assistant', tool_calls: [{ function: { name: 'list_capabilities', arguments: { category: 'audio' } } }] }; };
  const result = await runAgent({ session: { id: 's', messages: [] }, message: 'test', executor: create(async () => ({})), config, chat });
  assert.equal(calls, config.maxSteps); assert.match(result.answer, /limit/);
});
