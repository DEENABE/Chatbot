/** Authenticated Electron bridge. Secret is supplied only by the parent process. */
let BRIDGE_URL = process.env.TOOL_ENGINE_INTERNAL_URL || null;
export function refreshBridgeUrl() { BRIDGE_URL = process.env.TOOL_ENGINE_INTERNAL_URL || null; }
function configuration(ownerId) {
  if (typeof ownerId !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(ownerId)) throw new Error('Authenticated execution owner required.');
  refreshBridgeUrl();
  const secret = process.env.TOOL_ENGINE_SESSION_SECRET;
  if (!BRIDGE_URL || !secret) throw new Error('Authenticated ToolEngine bridge is unavailable.');
  const url = new URL(BRIDGE_URL);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Invalid loopback bridge URL.');
  return { url: url.origin, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}`, 'X-Execution-Owner': ownerId } };
}
async function operation(endpoint, body, ownerId, signal) {
  const { url, headers } = configuration(ownerId);
  const response = await fetch(url + endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal, redirect: 'error' });
  if (!response.ok) throw Object.assign(new Error((await response.json().catch(() => ({}))).error || `Bridge returned HTTP ${response.status}`), { status: response.status });
  return response.json();
}
export async function cancelToolRequest(requestId, ownerId) {
  return operation('/cancel', { requestId }, ownerId, AbortSignal.timeout(5000));
}
export async function inspectToolCall(idempotencyKey, ownerId) {
  return operation('/status', { idempotencyKey }, ownerId, AbortSignal.timeout(5000));
}
export async function reviewToolCall(request, review, ownerId) {
  return operation('/reconcile', { request, review }, ownerId, AbortSignal.timeout(5000));
}
export async function renewToolConfirmation(confirmationId, renewalId, ownerId) {
  return operation('/confirmations/renew', { confirmationId, renewalId }, ownerId, AbortSignal.timeout(5000));
}
export async function cancelToolConfirmation(confirmationId,ownerId) {return operation('/confirmations/cancel',{confirmationId},ownerId,AbortSignal.timeout(5000));}
export async function callTool(request, { signal, ownerId, humanApproved = false } = {}) {
  const controller = new AbortController();
  let cancellation;
  const abort = () => {
    cancellation ||= cancelToolRequest(request.requestId, ownerId).catch(() => null);
    controller.abort();
  };
  const timer = setTimeout(abort, ['app','uiAutomation'].includes(request.tool) || request.admission?.taskType === 'windows_repair_print_spooler_start' ? 60000 : 30000);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) { abort(); await cancellation; return { success: false, error: { code: 'CANCELLED', message: 'Cancelled before dispatch.' } }; }
    return await operation(humanApproved ? '/approve' : '/', request, ownerId, controller.signal);
  } catch (error) {
    return { success: false, toolCallId: request.toolCallId, requestId: request.requestId, idempotencyKey: request.idempotencyKey,
      error: { code: controller.signal.aborted ? 'EXECUTION_UNCERTAIN' : 'BRIDGE_NETWORK_ERROR', message: error.message } };
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
    if (cancellation) await cancellation;
  }
}
export async function checkBridgeHealth() {
  try {
    const { url, headers } = configuration('health-probe');
    const response = await fetch(url + '/health', { headers, signal: AbortSignal.timeout(2000), redirect: 'error' });
    return { available: response.ok, url };
  } catch { return { available: false, url: null }; }
}
export { BRIDGE_URL };
