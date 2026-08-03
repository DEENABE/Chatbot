/**
 * @module agent/dangerClassifier
 * @description Classifies a PowerShell command into a risk level so the
 * autonomous agent knows what it may run unattended.
 *
 *  - 'read'    → read-only diagnostics, always safe to auto-run.
 *  - 'fix'     → mutating but recoverable (restart a service, flush DNS,
 *                clear temp, reset an adapter). Auto-run in fully-automatic mode.
 *  - 'blocked' → irreversible or highly disruptive (format a disk, wipe a
 *                partition, delete system files, reboot). NEVER auto-run;
 *                surfaced to the user for a manual decision.
 */

/**
 * Patterns that must never run unattended, even in fully-automatic mode.
 * These are irreversible (data loss / partition changes) or would disrupt
 * the running session (reboot / shutdown / user deletion).
 */
const BLOCKED_PATTERNS = [
  // Disk format: Format-Volume cmdlet, or the legacy `format C:` command.
  // Deliberately does NOT match the harmless Format-List/Table/Custom/Wide.
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
  // Recursive / forced deletion of drive roots or Windows system dirs
  /remove-item[^\n]*-recurse[^\n]*(\s[a-z]:\\?(\s|"|'|$)|\$env:(systemroot|windir)|\\windows\\|\\system32\b|:\\windows)/i,
  /\b(del|erase)\b[^\n]*\/[sq][^\n]*\b([a-z]:\\?\s|\\windows\\|\\system32\b)/i,
  /\brd\b[^\n]*\/s[^\n]*\b([a-z]:\\|\\windows)/i,
  // Mass registry hive deletion
  /reg(istry)?\s+delete\s+HK(LM|EY_LOCAL_MACHINE)\\?(software|system)?\s*(\/f)?\s*$/i,
  /remove-item[^\n]*hk(lm|cu|ey_local_machine):/i,
  // Account / security destruction
  /\bremove-localuser\b/i,
  /\bnet\s+user\b[^\n]*\/delete/i,
  // Session-disrupting
  /\b(stop|restart)-computer\b/i,
  /\bshutdown\b[^\n]*\/(r|s|p)/i,
  // Mass process kill of critical host
  /stop-process[^\n]*\b(wininit|csrss|winlogon|services|lsass|system)\b/i,
];

/**
 * Verbs / commands that only read state. Anchored to the start of the
 * (trimmed) command or a pipeline segment so a mutating verb later in the
 * pipeline still escalates the classification.
 */
const READ_ALLOWLIST = [
  /^get-/i, /^test-/i, /^resolve-/i, /^measure-/i, /^select-/i, /^where-/i,
  /^sort-/i, /^find-/i, /^show-/i, /^read-/i, /^compare-/i, /^format-list/i,
  /^format-table/i, /^out-string/i, /^convertto-/i, /^convertfrom-/i,
  /^ipconfig\b/i, /^systeminfo\b/i, /^ping\b/i, /^tracert\b/i, /^nslookup\b/i,
  /^netstat\b/i, /^tasklist\b/i, /^wmic\b(?![^\n]*\b(delete|call|set)\b)/i,
  /^whoami\b/i, /^hostname\b/i, /^echo\b/i, /^write-(host|output)\b/i,
  /^dir\b/i, /^ls\b/i, /^type\b/i, /^gc\b/i,
];

/**
 * Classify a PowerShell command string.
 *
 * @param {string} command - The raw PowerShell command the model wants to run.
 * @returns {{ level: 'read'|'fix'|'blocked', reason: string }}
 */
export function classifyCommand(command) {
  const cmd = String(command || '').trim();
  if (!cmd) {
    return { level: 'blocked', reason: 'Empty command.' };
  }

  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(cmd)) {
      return {
        level: 'blocked',
        reason: 'Irreversible or session-disrupting operation — needs a human decision.',
      };
    }
  }

  // A command reads only if EVERY pipeline segment is a read-only verb.
  const segments = cmd.split('|').map((s) => s.trim()).filter(Boolean);
  const everySegmentReads = segments.length > 0 && segments.every((seg) =>
    READ_ALLOWLIST.some((pattern) => pattern.test(seg))
  );
  if (everySegmentReads) {
    return { level: 'read', reason: 'Read-only diagnostic.' };
  }

  return { level: 'fix', reason: 'Mutating but recoverable action.' };
}

export default classifyCommand;
