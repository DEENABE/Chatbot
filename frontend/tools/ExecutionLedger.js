import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { executionContext } from './ExecutionContext.js';

const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
const failure = (code, message) => ({ success: false, error: { code, message } });
const validId = id => typeof id === 'string' && /^[A-Za-z0-9:._-]{1,240}$/.test(id);
const fingerprint = request => createHash('sha256').update(JSON.stringify(canonical({ tool: request.tool, action: request.action, params: Object.hasOwn(request, 'params') ? request.params : {}, toolCallId: request.toolCallId }))).digest('hex');
const rejectReview = (message, status = 409) => { throw Object.assign(new Error(message), { status }); };

/** Durable write-ahead evidence. Unknown in-flight effects are never replayed. */
export class ExecutionLedger {
  constructor({ directory, dispatch, timeoutMs = 30000, renewConfirmation }) {
    this.directory = directory; this.dispatch = dispatch;
    this.timeoutMs = timeoutMs;
    this.renewConfirmation = renewConfirmation;
    this.unsettled = new Set();
    this.active = new Map(); this.memory = new Map(); this.cancellations = new Set();
    if (directory) fs.mkdirSync(directory, { recursive: true });
  }
  file(scope, key) { return path.join(this.directory, createHash('sha256').update(`${scope}\0${key}`).digest('hex') + '.json'); }
  read(scope, key) {
    if (!this.directory) return this.memory.get(`${scope}\0${key}`);
    try { return JSON.parse(fs.readFileSync(this.file(scope, key), 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  write(scope, key, record) {
    if (!this.directory) { this.memory.set(`${scope}\0${key}`, structuredClone(record)); return; }
    const file = this.file(scope, key); const fd = fs.openSync(file + '.tmp', 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(file + '.tmp', file);
  }
  status(scope, key) {
    if (!validId(key)) throw new Error('Invalid idempotencyKey');
    const record = this.read(scope, key);
    if (!record) return { status: 'unknown', executionActive: false };
    const activeId = `${scope}\0${record.requestId}`;
    const executionActive = this.active.has(activeId) || this.unsettled.has(activeId);
    if (record.status === 'running' && !executionActive) return { ...record, status: 'uncertain', executionActive };
    return { ...record, executionActive };
  }
  cancel(scope, requestId) {
    if (!validId(requestId)) throw new Error('Invalid requestId');
    const id = `${scope}\0${requestId}`;
    try { this.write(`${scope}:cancellation`,requestId,{cancelled:true}); }
    finally {this.cancellations.add(id);this.active.get(id)?.controller.abort();}
    this.onCancel?.(scope,requestId);
    return { cancelled: true, requestId };
  }
  reconcile(scope, request, review) {
    if (!request || ![request.requestId, request.idempotencyKey].every(validId) || typeof request.toolCallId !== 'string' || !request.toolCallId) rejectReview('Invalid execution identity', 400);
    if (!review || !validId(review.reviewId) || !['completed','not_completed','abandon'].includes(review.disposition) || review.quiescenceConfirmed !== true || typeof review.note !== 'string' || review.note.trim().length < 10 || review.note.length > 4000) rejectReview('A review ID, disposition, evidence note and quiescence confirmation are required', 400);
    if (review.disposition === 'completed' && (!review.data || typeof review.data !== 'object' || Array.isArray(review.data))) rejectReview('Completed reviews require structured result data', 400);
    const hash = fingerprint(request);
    const reviewHash = createHash('sha256').update(JSON.stringify(canonical(review))).digest('hex');
    const existing = this.read(scope, request.idempotencyKey);
    if (existing && (existing.hash !== hash || existing.requestId !== request.requestId || existing.toolCallId !== request.toolCallId)) rejectReview('Review identity mismatch');
    if (existing?.reconciliation) {
      if (existing.reconciliation.reviewId !== review.reviewId || existing.reconciliation.reviewHash !== reviewHash) rejectReview('Execution already has a different review');
      return existing;
    }
    const activeId = `${scope}\0${request.requestId}`;
    if (this.active.has(activeId) || this.unsettled.has(activeId)) rejectReview('Original execution has not stopped');
    if (existing?.status === 'completed') rejectReview('Completed evidence cannot be overwritten');
    const binding = this.read(`${scope}:request-index`, request.requestId);
    if (binding && binding.idempotencyKey !== request.idempotencyKey) rejectReview('Request ID belongs to another call');
    const reconciliation = { reviewId: review.reviewId, reviewHash, disposition: review.disposition,
      note: review.note.trim(), quiescenceConfirmed: true, reviewedBy: scope, reviewedAt: new Date().toISOString(), provenance: 'human_attestation' };
    const identity = { requestId: request.requestId, idempotencyKey: request.idempotencyKey, toolCallId: request.toolCallId };
    const result = { ...identity, success: review.disposition === 'completed', data: review.disposition === 'completed' ? review.data : null,
      reconciliation, ...(review.disposition === 'completed' ? {} : { error: { code: review.disposition === 'abandon' ? 'MANUALLY_ABANDONED' : 'MANUALLY_NOT_COMPLETED', message: review.note.trim() } }) };
    const record = { schemaVersion: 1, ...identity, hash, status: 'completed', result, reconciliation, previousStatus: existing?.status || 'unknown' };
    this.write(`${scope}:request-index`, request.requestId, { idempotencyKey: request.idempotencyKey });
    this.write(scope, request.idempotencyKey, record);
    return record;
  }
  async execute(scope, request, sender, trusted = {}) {
    const { requestId, idempotencyKey, toolCallId } = request;
    if (![requestId, idempotencyKey].every(validId) || typeof toolCallId !== 'string' || !toolCallId.length || toolCallId.length > 1024) return failure('INVALID_IDENTITY', 'requestId, idempotencyKey and toolCallId are required.');
    const hash = fingerprint(request);
    const existing = this.read(scope, idempotencyKey);
    if (existing) {
      if (existing.hash !== hash || existing.requestId !== requestId) return failure('IDEMPOTENCY_CONFLICT', 'Key belongs to a different request.');
      if (existing.status === 'completed') return existing.result;
      return failure('EXECUTION_UNCERTAIN', 'Existing request is running or requires reconciliation.');
    }
    const activeId = `${scope}\0${requestId}`;
    const binding = this.read(`${scope}:request-index`, requestId);
    if (binding && binding.idempotencyKey !== idempotencyKey) return failure('REQUEST_CONFLICT', 'Request ID belongs to another idempotency key.');
    if (this.active.has(activeId)) return failure('REQUEST_CONFLICT', 'Request ID is already active.');
    if (this.cancellations.has(activeId) || this.read(`${scope}:cancellation`,requestId)) return failure('CANCELLED', 'Request was cancelled before dispatch.');
    const controller = new AbortController();
    const record = { schemaVersion: 1, status: 'running', hash, requestId, idempotencyKey, toolCallId };
    this.write(`${scope}:request-index`, requestId, { idempotencyKey });
    this.write(scope, idempotencyKey, record);
    this.active.set(activeId, { controller });
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const cancelled = new Promise(resolve => controller.signal.addEventListener('abort', () => resolve(failure('CANCELLED', 'Execution cancelled.')), { once: true }));
    try {
      let result;
      try {
        this.unsettled.add(activeId);
        const admission = trusted.backend === true ? request.admission : null;
        const taskId = admission?.sessionId || (requestId.includes(':request:') ? requestId.split(':request:')[0] : toolCallId);
        const dispatched = executionContext.run({ signal: controller.signal, scope, authenticated:/^(backend|renderer):[A-Za-z0-9-]{1,100}$/.test(scope), taskId, transport:trusted.transport==='MCP'?'MCP':'TOOL_ENGINE', origin:trusted.origin==='operator'?'operator':'model', humanApproved:trusted.humanApproved===true, admission, requestId,idempotencyKey,toolCallId }, async () => {
          controller.signal.throwIfAborted();
          return this.dispatch(request, sender);
        }).finally(() => this.unsettled.delete(activeId));
        result = await Promise.race([
          dispatched,
          cancelled,
        ]);
      } catch (error) { result = failure(controller.signal.aborted ? 'CANCELLED' : 'EXECUTION_ERROR', error.message); }
      result = { ...result, requestId, idempotencyKey, toolCallId };
      if (controller.signal.aborted || result?.error?.code === 'EXECUTION_UNCERTAIN') {
        result = { ...failure('EXECUTION_UNCERTAIN', 'Cancellation reached execution; side effects require reconciliation.'), requestId, idempotencyKey, toolCallId };
        this.write(scope, idempotencyKey, { ...record, status: 'uncertain', result });
      } else this.write(scope, idempotencyKey, { ...record, status: 'completed', result });
      return result;
    } finally { clearTimeout(timer); this.active.delete(activeId); }
  }
}
