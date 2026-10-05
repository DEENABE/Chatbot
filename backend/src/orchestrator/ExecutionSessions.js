const sessions = new Map();
export function claimSession(controller, parentSignal) {
  const id = controller.state.sessionId;
  if (sessions.has(id)) throw Object.assign(new Error('Execution is already active.'), { status: 409 });
  const abort = new AbortController();
  const forward = () => abort.abort();
  if (parentSignal?.aborted) forward();
  parentSignal?.addEventListener('abort', forward, { once: true });
  sessions.set(id, { controller, abort });
  return { signal: abort.signal, release() { parentSignal?.removeEventListener('abort', forward); sessions.delete(id); } };
}
export function cancelSessionRequest(sessionId, ownerId, requestId) {
  const entry = sessions.get(sessionId);
  if (!entry || entry.controller.state.ownerId !== ownerId) return false;
  if (!entry.controller.state.attempts.some(a => a.request.requestId === requestId)) return false;
  entry.abort.abort();
  return true;
}
