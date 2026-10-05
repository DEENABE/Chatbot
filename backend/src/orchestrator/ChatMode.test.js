import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { executionRequestSignal } from './requestSignal.js';

test('chat UI preserves a tool batch through confirmation and continues the same budget', async () => {
  const originalWindow = globalThis.window;
  const originalStorage = globalThis.localStorage;
  const originalFetch = globalThis.fetch;
  const checkpoints = new Map(); const requests = []; const calls = [];
  globalThis.localStorage = { getItem: () => null, setItem: (key, value) => checkpoints.set(key, JSON.parse(value)) };
  globalThis.window = { addEventListener() {}, toolEngine: {
    getTools: async () => ({ hardware: [{ action: 'first' }, { action: 'second' }] }),
    execute: async (tool, action, params, toolCallId) => {
      calls.push({ tool, action, params, toolCallId });
      return action === 'first' ? { needsConfirmation: true, confirmationId: 'confirm-exact', message: 'Approve?' } : { success: true, data: 'second-result' };
    },
    confirm: async () => ({ success: true, data: 'first-result' }),
  } };
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    const events = requests.length === 1 ? [
      { type: 'tool_call', toolCall: { id: 'model-first', function: { name: 'hardware_first', arguments: {} } } },
      { type: 'tool_call', toolCall: { id: 'model-second', function: { name: 'hardware_second', arguments: {} } } },
      { type: 'done' },
    ] : [{ type: 'token', text: 'Finished.' }, { type: 'done' }];
    return new Response(events.map(e => JSON.stringify(e)).join('\n') + '\n');
  };
  const { useAppStore } = await import('../../../frontend/src/stores/useAppStore.js');
  useAppStore.setState({ user: null, activeChatId: 'chat-test', activeMessages: [], pendingConfirmations: [], autoRepairMode: false, isGenerating: false });
  try {
    await useAppStore.getState().sendMessage('Please run both');
    assert.equal(calls.length, 1);
    const conf = useAppStore.getState().pendingConfirmations[0];
    assert.equal(conf.execution.state.phase, 'waiting_confirmation');
    await useAppStore.getState().resolveConfirmation('confirm-exact', true);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].toolCallId, 'model-second');
    assert.equal(conf.execution.state.stepCount, 3); // two dispatches plus approved continuation
    assert.equal(conf.execution.state.phase, 'done');
    assert.equal(checkpoints.size, 1);
    assert.equal(requests.length, 2);
    const history = requests[1].history;
    assert.deepEqual(history.find(m => m.tool_calls)?.tool_calls.map(c => c.id), ['model-first', 'model-second']);
    assert.deepEqual(history.filter(m => m.role === 'tool').map(m => m.tool_call_id), ['model-first', 'model-second']);
    assert.equal(useAppStore.getState().activeMessages.filter(m => m.role === 'user').length, 1);
    assert.equal(useAppStore.getState().isGenerating, false);
  } finally {
    globalThis.window = originalWindow; globalThis.localStorage = originalStorage; globalThis.fetch = originalFetch;
  }
});

test('request disconnect cancels execution; normal response completion does not', () => {
  const req = new EventEmitter(); const res = new EventEmitter();
  res.writableEnded = false;
  const signal = executionRequestSignal(req, res);
  res.emit('close'); assert.equal(signal.aborted, true);
  assert.equal(req.listenerCount('aborted'), 0);
  const req2 = new EventEmitter(); const res2 = new EventEmitter();
  res2.writableEnded = true;
  const signal2 = executionRequestSignal(req2, res2);
  res2.emit('finish'); res2.emit('close'); assert.equal(signal2.aborted, false);
});
