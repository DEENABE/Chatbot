import { spawn } from 'node:child_process';
import { helperScriptPath, powerShellPath } from '../DesktopRuntime.js';

/**
 * One long-lived PowerShell running SystemSettings.ps1 as a request loop (JSON lines over stdin/stdout).
 *
 * Why: every one-shot call pays PowerShell start-up (~0.3 s) plus ~0.26 s for each C# group it compiles, and a full list of
 * settings compiles five of them (~2.8 s). A warm worker pays that once. Calls are serialised (they touch global system
 * state), each has a timeout, a hung or crashed worker is killed and respawned on the next call, and an idle worker exits by
 * itself so it does not sit in memory.
 *
 * It never gets request text from a model: SystemSettingsService validates every request against the catalog first.
 */
const coded = (code, message) => Object.assign(new Error(message), { code });

export class SettingsWorker {
  /**
   * @param options.idleMs     close the worker after this long without a request
   * @param options.timeoutMs  abandon (and kill) a request that takes longer than this
   * @param options.spawnFn    injectable for tests: (file, args, options) => child process
   * @param options.paths      injectable for tests: () => ({ file, script })
   */
  constructor({ idleMs = 5 * 60_000, timeoutMs = 25_000, spawnFn = spawn, paths } = {}) {
    this.idleMs = idleMs;
    this.timeoutMs = timeoutMs;
    this.spawnFn = spawnFn;
    this.paths =
      paths ||
      (() => ({
        file: powerShellPath(),
        script: helperScriptPath('SystemSettings.ps1'),
      }));
    this.child = null;
    this.buffer = '';
    this.pending = null; // { id, resolve, reject, timer }
    this.queue = Promise.resolve();
    this.idleTimer = null;
    this.nextId = 1;
    this.started = 0; // how many worker processes have been started (observability and tests)
  }

  /** Send one request and resolve with the helper's result; rejects with a coded error like UIAutomationService.run does. */
  call(input) {
    const run = () => this.#send(input);
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {}); // a failed call must not poison the queue
    return result;
  }

  close() {
    clearTimeout(this.idleTimer);
    const child = this.child;
    this.child = null;
    if (child) {
      try {
        child.stdin.end();
      } catch {
        /* already closed */
      }
      setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* gone */
        }
      }, 1500).unref?.();
    }
  }

  #ensure() {
    if (this.child) return this.child;
    const { file, script } = this.paths(); // throws DESKTOP_HELPER_MISSING when the script is gone
    const child = this.spawnFn(
      file,
      ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] },
    );
    this.started += 1;
    this.child = child;
    this.buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.#onData(child, chunk));
    child.stdin.on('error', () => {}); // a dead worker is reported by the close handler
    child.on('error', () =>
      this.#onGone(
        child,
        'WORKER_UNAVAILABLE',
        'The Windows settings helper could not be started.',
      ),
    );
    child.on('close', () =>
      this.#onGone(
        child,
        'SETTINGS_HELPER_EXITED',
        'The Windows settings helper stopped unexpectedly. Try again.',
      ),
    );
    child.unref?.(); // never keep the host process alive just for this
    child.stdout.unref?.();
    child.stdin.unref?.();
    return child;
  }

  #onData(child, chunk) {
    if (child !== this.child) return;
    this.buffer += chunk;
    let at;
    while ((at = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, at).trim();
      this.buffer = this.buffer.slice(at + 1);
      if (!line.startsWith('{')) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const pending = this.pending;
      if (!pending || message.requestId !== pending.id) continue; // a late reply to a request that already timed out
      clearTimeout(pending.timer);
      this.pending = null;
      delete message.requestId;
      if (message.success === false)
        pending.reject(
          coded(
            message.code || 'SETTING_FAILED',
            message.message || 'The settings helper reported a failure.',
          ),
        );
      else pending.resolve(message);
    }
  }

  #onGone(child, code, message) {
    if (child !== this.child) return;
    this.child = null;
    const pending = this.pending;
    if (pending) {
      clearTimeout(pending.timer);
      this.pending = null;
      pending.reject(coded(code, message));
    }
  }

  #send(input) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = this.#ensure();
      } catch (error) {
        return reject(error);
      }
      clearTimeout(this.idleTimer);
      const id = this.nextId++;
      const timer = setTimeout(() => {
        // The helper is stuck (for example on a driver call). Kill it; the next request starts a fresh one.
        this.pending = null;
        if (child === this.child) this.child = null;
        try {
          child.kill();
        } catch {
          /* gone */
        }
        reject(
          coded(
            'SETTINGS_TIMEOUT',
            'Changing the setting timed out. No completion is claimed; check the setting before retrying.',
          ),
        );
      }, this.timeoutMs);
      this.pending = { id, resolve, reject, timer };
      try {
        child.stdin.write(`${JSON.stringify({ ...input, requestId: id })}\n`);
      } catch {
        clearTimeout(timer);
        this.pending = null;
        reject(coded('SETTINGS_HELPER_EXITED', 'The Windows settings helper is not running.'));
      }
    }).finally(() => {
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => this.close(), this.idleMs);
      this.idleTimer.unref?.();
    });
  }
}
