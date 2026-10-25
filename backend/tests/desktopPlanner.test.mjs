import test from 'node:test';
import assert from 'node:assert/strict';
import { nextDesktopTool } from '../src/ai/desktopChat.js';
import { nextDesktopDecision } from '../src/orchestrator/GenericAppPlanner.js';

const snapshot = {
  snapshotId: 'snapshot-fixture',
  status: 'UI_OBSERVED',
  success: true,
  application: { name: 'Fixture App' },
  elements: [
    {
      elementId: 'element-fixture',
      role: 'Button',
      label: 'Search',
      enabled: true,
      actions: [{ operation: 'invoke', permission: 'SAFE_WRITE', allowed: true }],
    },
  ],
};
const responses = (proposal, sent) => async (_url, options) => {
  sent.push(JSON.parse(options.body));
  return Response.json(
    sent.length === 1
      ? { message: { content: 'I can help you search.' } }
      : { message: { content: JSON.stringify(proposal) } },
  );
};

test('plain model replies get one JSON action retry through the same grounded execution path', async () => {
  const sent = [];
  const proposal = await nextDesktopTool({
    model: 'fixture',
    snapshot,
    prompt: '{}',
    fetchImpl: responses(
      { name: 'desktop_action', arguments: { action: 'click', elementId: 'e0' } },
      sent,
    ),
  });
  assert.equal(sent.length, 2);
  assert.equal(sent[1].format, 'json');
  assert.equal(sent[1].model, sent[0].model);
  const result = await nextDesktopDecision({
    task: 'open Fixture App and click Search',
    evidence: [{ toolName: 'desktop_open', success: true, data: snapshot }],
    complete: async () => proposal,
  });
  assert.deepEqual(result.call, {
    tool: 'desktop',
    action: 'click',
    params: { snapshotId: snapshot.snapshotId, elementId: 'element-fixture' },
  });
});

test('JSON fallback cannot request shell commands or unoffered desktop actions', async () => {
  for (const proposal of [
    { name: 'powershell_run', arguments: { command: 'untrusted' } },
    { name: 'desktop_action', arguments: { action: 'type', text: 'untrusted' } },
    {
      name: 'desktop_action',
      arguments: { action: 'click', elementId: 'e0', command: 'untrusted' },
    },
  ]) {
    const sent = [];
    await assert.rejects(
      nextDesktopTool({
        model: 'fixture',
        snapshot,
        prompt: '{}',
        fetchImpl: responses(proposal, sent),
      }),
      { code: 'INVALID_MODEL_TOOL_CALL' },
    );
    assert.equal(sent.length, 2);
  }
});

test('fallback proposals still cannot act on invented element IDs', async () => {
  const sent = [];
  const proposal = await nextDesktopTool({
    model: 'fixture',
    snapshot,
    prompt: '{}',
    fetchImpl: responses(
      { name: 'desktop_action', arguments: { action: 'click', elementId: 'e99' } },
      sent,
    ),
  });
  const result = await nextDesktopDecision({
    task: 'open Fixture App and click Search',
    evidence: [{ toolName: 'desktop_open', success: true, data: snapshot }],
    complete: async () => proposal,
  });
  assert.equal(result.success, false);
  assert.equal(result.call, undefined);
});
