/** Safe history/training projection. Raw approvals and runner commands never enter it. */
export function projectTypedRepair(state) {
  const steps = state.attempts.map((a) => ({
    tool: a.request.tool,
    action: a.request.action,
    toolCallId: a.request.toolCallId,
    requestId: a.request.requestId,
    success: a.observation?.success ?? null,
    needsConfirmation: a.observation?.needsConfirmation === true,
    diagnosisId: a.observation?.data?.diagnosisId ?? a.request.params?.diagnosisId ?? null,
    verificationStatus: a.observation?.data?.verificationStatus ?? null,
    errorCode: a.observation?.error?.code ?? null,
  }));
  return {
    id: state.sessionId,
    schemaVersion: 2,
    type: 'typed_repair',
    capabilityId: 'windows.printSpooler.start.v1',
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    userId: state.ownerId,
    goal: state.task,
    domain: 'windows',
    subdomain: 'printer',
    plan: state.plan.map((s) => s.action),
    steps,
    phase: state.phase,
    revision: state.revision,
    resolved: false,
    userIssueResolved: null,
    machineVerification: {
      scope: 'service_running',
      status:
        state.phase === 'done' ? 'passed' : (steps.at(-1)?.verificationStatus ?? 'not_established'),
    },
    summary:
      state.verdict?.summary ||
      state.reason ||
      (state.phase === 'act'
        ? 'Execution outcome is uncertain; manual reconciliation is required.'
        : state.phase),
    recommendation: '',
    feedback: null,
    auditEvent: {
      eventId: `${state.sessionId}:${state.revision}`,
      eventType: ['done', 'error', 'cancelled'].includes(state.phase)
        ? 'session.completed'
        : 'session.checkpoint',
      stateRevision: state.revision,
      phase: state.phase,
    },
  };
}
