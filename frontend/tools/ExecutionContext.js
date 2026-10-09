import { AsyncLocalStorage } from 'node:async_hooks';
import * as childProcess from 'node:child_process';

export const executionContext = new AsyncLocalStorage();
const ownedHelpers = new Set();
function trackHelper(child, options) {
  // User-requested GUI apps remain open. Track only hidden, non-detached helpers.
  if (options?.windowsHide === false || options?.detached) return child;
  ownedHelpers.add(child);
  child.once('close', () => ownedHelpers.delete(child));
  child.once('error', () => ownedHelpers.delete(child));
  return child;
}
export function stopOwnedHelpers() {
  for (const child of ownedHelpers) {
    if (child.exitCode !== null || !Number.isSafeInteger(child.pid)) continue;
    try {
      if (process.platform === 'win32')
        childProcess.execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
          timeout: 2000,
        });
      else child.kill();
    } catch {
      child.kill();
    }
  }
  ownedHelpers.clear();
}
export function checkCancellation() {
  executionContext.getStore()?.signal?.throwIfAborted();
}
export function execFile(command, args, options, callback) {
  checkCancellation();
  return trackHelper(
    childProcess.execFile(
      command,
      args,
      // Helper processes (PowerShell, reg.exe, ...) never get a console window of their own; GUI apps the user asked
      // for are started elsewhere with an explicit windowsHide: false.
      {
        windowsHide: true,
        ...options,
        signal: executionContext.getStore()?.signal,
      },
      callback,
    ),
    options,
  );
}
export function spawn(command, args, options) {
  checkCancellation();
  return trackHelper(
    childProcess.spawn(command, args, {
      windowsHide: true,
      ...options,
      signal: executionContext.getStore()?.signal,
    }),
    options,
  );
}
