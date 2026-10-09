import { randomUUID } from 'node:crypto';
/**
 * Application choices waiting for the user, kept by the tool engine. A choice remembers the exact tool call that was
 * ambiguous and the candidates that were offered, so the answer is a candidate id and nothing the caller can forge:
 * only an offered candidate of an unexpired choice owned by the same execution can be bound, and only once.
 * Memory only: after a restart the choice is gone and the caller asks again (APP_CHOICE_EXPIRED).
 */
const gone = () => ({
  ok: false,
  code: 'APP_CHOICE_EXPIRED',
  message: 'This application choice is no longer available. Ask for the application again.',
});
export class PendingAppChoiceStore {
  constructor({ ttlMs = 15 * 60 * 1000, maxPending = 50, now = Date.now } = {}) {
    this.ttlMs = ttlMs;
    this.maxPending = maxPending;
    this.now = now;
    this.records = new Map();
  }
  purge() {
    const now = this.now();
    for (const [id, record] of this.records)
      if (
        now >= record.expiresAt ||
        (record.status !== 'pending' &&
          record.status !== 'claimed' &&
          now - record.settledAt > 60000)
      )
        this.records.delete(id);
    while (this.records.size > this.maxPending)
      this.records.delete(this.records.keys().next().value);
  }
  create({ scope, taskId, origin, requestedApp, candidates }) {
    this.purge();
    // A newer question for the same task and application replaces the older one (a refresh after stale candidates).
    for (const record of this.records.values())
      if (
        record.status === 'pending' &&
        record.scope === scope &&
        record.taskId === taskId &&
        record.requestedApp === requestedApp
      )
        this.settle(record, 'superseded');
    const record = {
      choiceId: randomUUID(),
      scope,
      taskId,
      origin: structuredClone(origin),
      requestedApp,
      candidates: structuredClone(candidates),
      createdAt: this.now(),
      expiresAt: this.now() + this.ttlMs,
      status: 'pending',
    };
    this.records.set(record.choiceId, record);
    return structuredClone(record);
  }
  settle(record, status) {
    record.status = status;
    record.settledAt = this.now();
  }
  /** Takes the choice for execution. Another claim, or a different execution, is refused. */
  claim(choiceId, { scope, taskId }) {
    this.purge();
    const record = typeof choiceId === 'string' ? this.records.get(choiceId) : undefined;
    if (!record) return gone();
    if (record.scope !== scope || record.taskId !== taskId)
      return {
        ok: false,
        code: 'APP_CHOICE_INVALID',
        message: 'This application choice belongs to another task.',
      };
    if (record.status !== 'pending')
      return {
        ok: false,
        code: 'APP_CHOICE_ALREADY_USED',
        message: 'This application choice was already answered.',
      };
    record.status = 'claimed';
    return { ok: true, choice: structuredClone(record) };
  }
  /** The claim ended without launching anything (bad candidate, refresh failure): the user may answer again. */
  release(choiceId) {
    const record = this.records.get(choiceId);
    if (record?.status === 'claimed') record.status = 'pending';
  }
  finish(choiceId, status = 'consumed') {
    const record = this.records.get(choiceId);
    if (record && record.status === 'claimed') this.settle(record, status);
  }
  cancel(choiceId, { scope, taskId }) {
    const record = typeof choiceId === 'string' ? this.records.get(choiceId) : undefined;
    if (
      !record ||
      record.scope !== scope ||
      record.status !== 'pending' ||
      (taskId !== undefined && record.taskId !== taskId)
    )
      return { ok: false };
    this.settle(record, 'cancelled');
    return { ok: true };
  }
  get(choiceId) {
    const record = this.records.get(choiceId);
    return record ? structuredClone(record) : undefined;
  }
}
