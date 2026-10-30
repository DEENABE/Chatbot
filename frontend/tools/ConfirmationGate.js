import crypto from 'node:crypto';
import { DurableConfirmationStore } from './DurableConfirmationStore.js';
import { executionContext } from './ExecutionContext.js';
import { parameterHash } from './security/ToolRequestValidator.js';

/** Tokens persist as a lineage; renewal never executes or implicitly approves. */
export class ConfirmationGate {
  constructor({ directory, now = Date.now, ttlMs = 60000 } = {}) {
    this.store = new DurableConfirmationStore(directory);
    this.records = this.store.load();
    this.pending = new Map();
    this.now = now;
    this.ttlMs = ttlMs;
  }
  commit(records) {
    const previous = this.records;
    this.records = this.store.update(previous, records);
    records = this.records;
    for (const [id, record] of Object.entries(records))
      if (previous[id] !== record && record.metadata?.tool === 'windowsRepair')
        this.observeRepairRecord?.(record);
  }
  getRecord(id) {
    return typeof id === 'string' && Object.hasOwn(this.records, id) ? this.records[id] : undefined;
  }
  request(metadata) {
    const context = executionContext.getStore();
    if (context?.authenticated)
      metadata = {
        ...metadata,
        authorization: {
          userId: context.scope,
          taskId: context.taskId,
          modelRoute: context.modelRoute,
          origin: context.origin,
          tool: metadata.tool,
          action: metadata.action,
          paramsHash: parameterHash(metadata.params),
          createdAt: this.now(),
        },
      };
    const confirmationId = crypto.randomUUID();
    const record = {
      confirmationId,
      rootId: confirmationId,
      generation: 0,
      metadata: structuredClone(metadata),
      expiresAt: Math.min(this.now() + this.ttlMs, metadata.validUntil ?? Infinity),
      status: 'pending',
    };
    this.commit({ ...this.records, [confirmationId]: record });
    let resolve, reject;
    const promise = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    promise.catch(() => {});
    const timeout = setTimeout(() => {
      this.pending.delete(confirmationId);
      reject(new Error('Confirmation expired'));
    }, this.ttlMs);
    timeout.unref?.();
    this.pending.set(confirmationId, { resolve, reject, timeout });
    return { confirmationId, expiresAt: record.expiresAt, promise };
  }
  settle(id, accepted) {
    const pending = this.pending.get(id);
    if (pending) {
      clearTimeout(pending.timeout);
      if (accepted) pending.resolve(this.records[id].metadata);
      else pending.reject(new Error('Confirmation closed'));
      this.pending.delete(id);
    }
  }
  confirm(id) {
    const record = this.getRecord(id);
    if (!record || record.status !== 'pending' || this.now() >= record.expiresAt)
      return { success: false, error: 'Confirmation expired or invalid' };
    this.commit({
      ...this.records,
      [id]: { ...record, status: 'consumed', consumedAt: this.now() },
    });
    this.settle(id, true);
    return { success: true, metadata: structuredClone(record.metadata) };
  }
  validateApproval(id, request, context) {
    const record = this.getRecord(id),
      binding = record?.metadata?.authorization;
    if (!record || !binding || context?.humanApproved !== true) return 'APPROVAL_INVALID';
    if (record.status !== 'pending') return 'APPROVAL_ALREADY_USED';
    if (this.now() >= record.expiresAt || this.now() < binding.createdAt) return 'APPROVAL_EXPIRED';
    if (binding.userId !== context.scope || binding.taskId !== context.taskId)
      return 'APPROVAL_INVALID';
    if (binding.modelRoute !== context.modelRoute) return 'APPROVAL_ROUTE_MISMATCH';
    if (
      binding.tool !== request.tool ||
      binding.action !== request.action ||
      binding.paramsHash !== parameterHash(request.params ?? {})
    )
      return 'APPROVAL_PARAMETER_MISMATCH';
    return null;
  }
  cancel(id) {
    const record = this.getRecord(id);
    if (!record || record.status !== 'pending')
      return { success: false, error: 'Confirmation expired or invalid' };
    this.commit({ ...this.records, [id]: { ...record, status: 'cancelled' } });
    this.settle(id, false);
    return { success: true, metadata: structuredClone(record.metadata) };
  }
  getPending(id) {
    const record = this.getRecord(id);
    return record?.status === 'pending' ? structuredClone(record.metadata) : undefined;
  }
  renew(id, renewalId, scope) {
    if (typeof renewalId !== 'string' || !/^[A-Za-z0-9:._-]{1,120}$/.test(renewalId))
      throw Object.assign(new Error('Invalid renewalId'), { status: 400 });
    const record = this.getRecord(id);
    if (!record || record.metadata.scope !== scope)
      throw Object.assign(new Error('Confirmation not found'), { status: 404 });
    if (record.status === 'superseded' && record.renewalId === renewalId) {
      const next = this.records[record.replacementId];
      return this.response(next);
    }
    if (record.status !== 'pending')
      throw Object.assign(
        new Error('Consumed, cancelled or superseded confirmation cannot be renewed'),
        { status: 409 },
      );
    if (record.metadata.validUntil != null && this.now() >= record.metadata.validUntil)
      throw Object.assign(new Error('REQUIRES_REDIAGNOSIS'), { status: 409 });
    if (record.metadata.maxRenewals != null && record.generation >= record.metadata.maxRenewals)
      throw Object.assign(new Error('Renewal budget exhausted'), {
        status: 409,
      });
    const confirmationId = crypto.randomUUID();
    const next = {
      ...record,
      confirmationId,
      previousId: id,
      generation: record.generation + 1,
      expiresAt: Math.min(this.now() + this.ttlMs, record.metadata.validUntil ?? Infinity),
      status: 'pending',
    };
    this.commit({
      ...this.records,
      [id]: {
        ...record,
        status: 'superseded',
        renewalId,
        replacementId: confirmationId,
      },
      [confirmationId]: next,
    });
    this.settle(id, false);
    return this.response(next);
  }
  response(record) {
    return {
      confirmationId: record.confirmationId,
      previousId: record.previousId,
      rootId: record.rootId,
      generation: record.generation,
      expiresAt: record.expiresAt,
      message: record.metadata.message || 'Review the original action and approve again.',
    };
  }
}
