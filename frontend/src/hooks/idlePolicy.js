/** How long the window may sit untouched before it shrinks back to the bubble. */
export const IDLE_COLLAPSE_MS = 3 * 60 * 1000;

/**
 * Whether an idle window should now collapse to the bubble. Never while the
 * assistant is working or waiting on the user (a reply streaming in, an
 * approval prompt, a screen capture) or while the window is hidden/minimized —
 * collapsing then would pull the app out from under a task in progress.
 */
export function shouldCollapse({ idleMs, timeoutMs = IDLE_COLLAPSE_MS, busy = false }) {
  return !busy && idleMs >= timeoutMs;
}
