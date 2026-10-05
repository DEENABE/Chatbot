import { AsyncLocalStorage } from 'node:async_hooks';
import * as childProcess from 'node:child_process';

export const executionContext = new AsyncLocalStorage();
export function checkCancellation() { executionContext.getStore()?.signal?.throwIfAborted(); }
export function execFile(command, args, options, callback) {
  checkCancellation();
  return childProcess.execFile(command, args, { ...options, signal: executionContext.getStore()?.signal }, callback);
}
export function spawn(command, args, options) {
  checkCancellation();
  return childProcess.spawn(command, args, { ...options, signal: executionContext.getStore()?.signal });
}
