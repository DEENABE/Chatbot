/**
 * @module ConfirmationGate
 * @description Manages pending confirmations for destructive tool actions.
 * Each confirmation request generates a unique ID, stores the associated
 * metadata, and auto-expires after a configurable timeout (default 60s).
 */

import crypto from 'node:crypto';

/** Default confirmation timeout in milliseconds (60 seconds). */
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * @typedef {Object} PendingEntry
 * @property {Object} metadata - Arbitrary metadata associated with the confirmation.
 * @property {Function} resolve - Promise resolve callback.
 * @property {Function} reject - Promise reject callback.
 * @property {ReturnType<typeof setTimeout>} timeout - The expiry timer handle.
 */

/**
 * @typedef {Object} ConfirmResult
 * @property {boolean} success - Whether the confirmation was found and processed.
 * @property {Object} [metadata] - The stored metadata (on success).
 * @property {string} [error] - Error message (on failure).
 */

export class ConfirmationGate {
  /**
   * Create a new ConfirmationGate instance.
   */
  constructor() {
    /** @type {Map<string, PendingEntry>} */
    this.pending = new Map();
  }

  /**
   * Request confirmation for a destructive action.
   *
   * Generates a unique confirmation ID, stores the metadata alongside
   * resolve/reject callbacks, and sets a 60-second auto-expiry timer.
   *
   * @param {Object} metadata - Contextual data about the action requiring confirmation
   *   (e.g., `{ tool, action, params, message }`).
   * @returns {{ confirmationId: string, promise: Promise<Object> }}
   *   The confirmation ID (to send to the user) and a Promise that resolves
   *   when the user confirms or rejects on timeout/cancel.
   *
   * @example
   * const { confirmationId, promise } = gate.request({
   *   tool: 'file',
   *   action: 'delete',
   *   params: { path: 'C:\\temp\\data.log' },
   *   message: 'Delete file C:\\temp\\data.log?'
   * });
   */
  request(metadata) {
    const confirmationId = crypto.randomUUID();

    let resolve;
    let reject;

    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // The current callers (BaseToolService/ToolEngineRouter) drive
    // confirm/cancel through this gate's own confirm()/cancel() return
    // values, not by awaiting this promise — so nothing was ever attached
    // to it. An unawaited promise that later rejects (every cancel, every
    // 60s timeout) is an unhandled rejection, which under Node's default
    // --unhandled-rejections=throw crashes the process. The promise is
    // still returned for any future caller that does want to await it;
    // this only stops the *unused* case from being fatal.
    promise.catch(() => {});

    const timeout = setTimeout(() => {
      this.pending.delete(confirmationId);
      reject(new Error('Confirmation expired'));
    }, DEFAULT_TIMEOUT_MS);

    this.pending.set(confirmationId, {
      metadata,
      resolve,
      reject,
      timeout,
    });

    return { confirmationId, promise };
  }

  /**
   * Confirm a pending action by its confirmation ID.
   *
   * Clears the expiry timer, resolves the stored promise with the metadata,
   * and removes the entry from the pending map.
   *
   * @param {string} confirmationId - The ID returned from {@link request}.
   * @returns {ConfirmResult} Success with metadata, or failure with error message.
   */
  confirm(confirmationId) {
    const entry = this.pending.get(confirmationId);

    if (!entry) {
      return { success: false, error: 'Confirmation expired or invalid' };
    }

    clearTimeout(entry.timeout);
    entry.resolve(entry.metadata);
    this.pending.delete(confirmationId);

    return { success: true, metadata: entry.metadata };
  }

  /**
   * Cancel a pending confirmation, rejecting its promise.
   *
   * @param {string} confirmationId - The ID returned from {@link request}.
   * @returns {ConfirmResult} Success with metadata, or failure with error message.
   */
  cancel(confirmationId) {
    const entry = this.pending.get(confirmationId);

    if (!entry) {
      return { success: false, error: 'Confirmation expired or invalid' };
    }

    clearTimeout(entry.timeout);
    entry.reject(new Error('cancelled'));
    this.pending.delete(confirmationId);

    return { success: true, metadata: entry.metadata };
  }

  /**
   * Retrieve the metadata for a pending confirmation without altering its state.
   *
   * @param {string} confirmationId - The ID returned from {@link request}.
   * @returns {Object|undefined} The metadata if the confirmation is still pending, otherwise undefined.
   */
  getPending(confirmationId) {
    const entry = this.pending.get(confirmationId);
    return entry ? entry.metadata : undefined;
  }
}
