import { digest } from './contracts.js';

// Read-only inspection calls, and an identical fs.write. Repeating one against unchanged state can never add information.
const REPEATABLE =
  /^(?:fs\.(?:list|read|write)|code\.search|workspace\.(?:inspect|open)|runtime\.inspect|checkpoint\.list)$/;

const cleanPath = (value) =>
  typeof value === 'string'
    ? value
        .replaceAll('\\', '/')
        .replace(/^(?:\.\/)+/, '')
        .replace(/\/+$/, '')
        .replace(/^\.$/, '')
    : value;
const canonical = (call) => ({
  tool: call.tool,
  params: {
    ...call.params,
    ...(call.params && 'path' in call.params ? { path: cleanPath(call.params.path) } : {}),
  },
});

/**
 * Stops a small local model from burning the step budget re-running identical read-only
 * calls (for example fs.list on an empty project). A repeat is blocked and the model is
 * told to act; persistent repeating ends the task with a clear NO_PROGRESS error.
 */
export class RepeatGuard {
  constructor({ maxNudges = 3 } = {}) {
    Object.assign(this, { maxNudges, seen: new Map(), nudges: 0, lastState: null });
  }
  /** Returns null when the call may run, otherwise { exhausted, message }. */
  check(call, state) {
    if (state !== this.lastState) {
      this.lastState = state;
      this.nudges = 0;
    }
    if (!REPEATABLE.test(call?.tool || '')) return null;
    const key = digest({ call: canonical(call), state });
    const count = (this.seen.get(key) || 0) + 1;
    this.seen.set(key, count);
    if (count < 2) return null;
    this.nudges++;
    return {
      exhausted: this.nudges > this.maxNudges,
      message: `You already ran ${call.tool} with these exact parameters and nothing in the project changed since, so it cannot add anything. Do not repeat it. If a file is missing, create it now with fs.write (expectedVersion "new"), one different file per action, then run the checks.`,
    };
  }
}
