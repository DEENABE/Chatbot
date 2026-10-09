import { createHash } from 'node:crypto';
/** Re-evaluate immediately before dispatch and before consuming an approval. */
export class ToolExecutionGuard {
  constructor({ policy, gate, audit }) {
    this.policy = policy;
    this.gate = gate;
    this.audit = audit;
  }
  check(request, context, approvalId) {
    let decision = this.policy.evaluate(request, context);
    if (decision.decision === 'REQUIRE_APPROVAL' && approvalId) {
      const reason = this.gate.validateApproval(approvalId, request, context);
      decision = {
        ...decision,
        decision: reason ? 'DENY' : 'ALLOW',
        reasonCode: reason || 'APPROVAL_VALID',
        userMessage: reason || decision.userMessage,
      };
    }
    this.audit.record(
      request,
      context,
      decision,
      'permission_check',
      approvalId ? createHash('sha256').update(approvalId).digest('hex') : null,
    );
    return decision;
  }
}
