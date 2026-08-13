/**
 * @module tools/dangerGuard
 * @description Blocks irreversible/session-disrupting commands before
 * PowerShellService/CmdService execute them, even after the user has
 * confirmed the action. Mirrors the BLOCKED_PATTERNS list in
 * backend/src/agent/dangerClassifier.js (kept separate because this tree is
 * packaged independently of the backend — see frontend/package.json "build.files").
 */

const BLOCKED_PATTERNS = [
  /\bformat-volume\b/i,
  /\bformat(\.com)?\s+[a-z]:/i,
  /\bclear-disk\b/i,
  /\b(initialize|set|remove|clear)-disk\b/i,
  /\bremove-partition\b/i,
  /\bdiskpart\b/i,
  /\bcipher\s+\/w/i,
  /\bfsutil\b.*\b(deletejournal|setflags)/i,
  /\bbcdedit\b/i,
  /\bbootrec\b/i,
  /remove-item\b(?=[^\n]*-recurse)(?=[^\n]*(\s[a-z]:\\?(\s|"|'|$)|\$env:(systemroot|windir)|\\windows\\|\\system32\b|:\\windows))/i,
  /\b(del|erase)\b(?=[^\n]*\/[sq])(?=[^\n]*([a-z]:\\?(\s|$)|:\\windows\b|\\system32\b))/i,
  /\brd\b(?=[^\n]*\/s)(?=[^\n]*([a-z]:\\|:\\windows\b))/i,
  /reg(istry)?\s+delete\s+HK(LM|EY_LOCAL_MACHINE)\\?(software|system)?\s*(\/f)?\s*$/i,
  /remove-item[^\n]*hk(lm|cu|ey_local_machine):/i,
  /\bremove-localuser\b/i,
  /\bnet\s+user\b[^\n]*\/delete/i,
  /\b(stop|restart)-computer\b/i,
  /\bshutdown\b[^\n]*\/(r|s|p)/i,
  /stop-process[^\n]*\b(wininit|csrss|winlogon|services|lsass|system)\b/i,
];

/**
 * @param {string} command
 * @returns {boolean} true if the command is irreversible/session-disrupting and must never run.
 */
export function isBlockedCommand(command) {
  const cmd = String(command || '');
  return BLOCKED_PATTERNS.some((pattern) => pattern.test(cmd));
}

export default isBlockedCommand;
