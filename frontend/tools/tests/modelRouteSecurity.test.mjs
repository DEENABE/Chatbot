import test from 'node:test';
import assert from 'node:assert/strict';
import { signWindowsProposal } from '../../../backend/src/services/modelRouteAuthority.js';
import { verifyWindowsProposal } from '../security/ModelRouteAuthority.js';
import { ExecutionLedger } from '../ExecutionLedger.js';
import { ToolPermissionPolicy } from '../security/ToolPermissionPolicy.js';
import { ConfirmationGate } from '../ConfirmationGate.js';
import { executionContext } from '../ExecutionContext.js';

const secret = 'unit-test-launch-secret'.repeat(3),
  userId = 'a269b490-20b2-443b-a352-ccf4c87b042c',
  scope = `renderer:${userId}-3`;
const call = {
  id: 'proposal-1',
  function: {
    name: 'app_openApp',
    arguments: { query: 'Fixture Application' },
  },
};
const request = {
  tool: 'app',
  action: 'openApp',
  params: { query: 'Fixture Application' },
  toolCallId: call.id,
  requestId: 'request-1',
  idempotencyKey: 'key-1',
};
test('signed proposal binds authenticated user, exact action, parameters, call and expiry', () => {
  const grant = signWindowsProposal(call, userId, { secret, now: 100 });
  assert.equal(verifyWindowsProposal(grant, request, scope, { secret, now: 101 }).route, 'windows');
  for (const changed of [
    { ...request, params: { query: 'Other Application' } },
    { ...request, action: 'closeApp' },
    { ...request, toolCallId: 'other' },
  ])
    assert.equal(verifyWindowsProposal(grant, changed, scope, { secret, now: 101 }), null);
  assert.equal(
    verifyWindowsProposal(grant, request, `renderer:other-3`, {
      secret,
      now: 101,
    }),
    null,
  );
  assert.equal(verifyWindowsProposal(grant, request, scope, { secret, now: 600101 }), null);
  assert.equal(
    verifyWindowsProposal(grant + 'tamper', request, scope, {
      secret,
      now: 101,
    }),
    null,
  );
});
test('one signed proposal cannot be replayed with fresh execution identities or another window', async () => {
  let calls = 0;
  const ledger = new ExecutionLedger({
    dispatch: async () => {
      calls++;
      return { success: true };
    },
  });
  const trusted = {
    modelRoute: 'windows',
    proposalId: call.id,
    proposalOwner: userId,
  };
  assert.equal((await ledger.execute(scope, request, null, trusted)).success, true);
  assert.equal((await ledger.execute(scope, request, null, trusted)).success, true);
  assert.equal(
    (
      await ledger.execute(
        scope,
        { ...request, requestId: 'request-2', idempotencyKey: 'key-2' },
        null,
        trusted,
      )
    ).error.code,
    'PROPOSAL_ALREADY_USED',
  );
  assert.equal(
    (await ledger.execute(`renderer:${userId}-4`, request, null, trusted)).error.code,
    'PROPOSAL_ALREADY_USED',
  );
  assert.equal(calls, 1);
});
test('central permission engine denies General origin and still requires Windows approvals', () => {
  const registry = {
    get: () => ({
      name: 'app.openApp',
      parameterSchema: { query: { type: 'string', required: true } },
      allowedScopes: ['renderer'],
      risk: 'DANGEROUS',
      transport: 'TOOL_ENGINE',
    }),
  };
  const policy = new ToolPermissionPolicy({ registry, available: () => true });
  const context = {
    authenticated: true,
    scope,
    taskId: 'task',
    origin: 'model',
    modelRoute: 'general',
  };
  assert.equal(policy.evaluate(request, context).reasonCode, 'MODEL_ROUTE_DENIED');
  assert.equal(
    policy.evaluate(request, { ...context, modelRoute: 'windows' }).decision,
    'REQUIRE_APPROVAL',
  );
});
test('approval remains bound to its original Windows route and human task', () => {
  const gate = new ConfirmationGate({ now: () => 100 });
  const context = {
    authenticated: true,
    scope,
    taskId: 'task',
    origin: 'model',
    modelRoute: 'windows',
  };
  const { confirmationId } = executionContext.run(context, () =>
    gate.request({
      tool: request.tool,
      action: request.action,
      params: request.params,
      scope,
    }),
  );
  assert.equal(
    gate.validateApproval(confirmationId, request, {
      ...context,
      humanApproved: true,
    }),
    null,
  );
  assert.equal(
    gate.validateApproval(confirmationId, request, {
      ...context,
      modelRoute: 'general',
      humanApproved: true,
    }),
    'APPROVAL_ROUTE_MISMATCH',
  );
  assert.equal(gate.validateApproval(confirmationId, request, context), 'APPROVAL_INVALID');
  gate.cancel(confirmationId);
});
