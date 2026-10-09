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
  // Recursive / forced deletion of drive roots or Windows system dirs.
  // Lookaheads instead of a fixed left-to-right sequence: PowerShell/cmd don't
  // care whether the path or the switch comes first
  // ("Remove-Item C:\Windows -Recurse" is identical to
  // "Remove-Item -Recurse C:\Windows"), and the previous version only matched
  // the switch-then-path order, so the more natural path-then-switch phrasing
  // slipped through as 'fix' instead of 'blocked'.
  /remove-item\b(?=[^\n]*-recurse)(?=[^\n]*(\s[a-z]:\\?(\s|"|'|$)|\$env:(systemroot|windir)|\\windows\\|\\system32\b|:\\windows))/i,
  // ":\windows\b" (word boundary, not a required trailing backslash/space) so
  // "\Windows" is caught whatever follows it — end of string, a space before
  // the next switch, anything. The remove-item pattern above already had this
  // form (":\\windows" with no trailing requirement); del/rd only had the
  // stricter "\\windows\\" / trailing-space forms, so "del C:\Windows /s /q"
  // (subfolder followed by more text, not end-of-string and not immediately
  // followed by another backslash) fell through uncaught.
  /\b(del|erase)\b(?=[^\n]*\/[sq])(?=[^\n]*([a-z]:\\?(\s|$)|:\\windows\b|\\system32\b))/i,
  /\brd\b(?=[^\n]*\/s)(?=[^\n]*([a-z]:\\|:\\windows\b))/i,
  // Mass registry hive deletion
  /reg(istry)?\s+delete\s+HK(LM|EY_LOCAL_MACHINE)\\?(software|system)?\s*(\/f)?\s*$/i,
  /remove-item[^\n]*hk(lm|cu|ey_local_machine):/i,
  // Account / security destruction
  /\bremove-localuser\b/i,
  /\bnet\s+user\b[^\n]*\/delete/i,
  // Account / privilege creation — a new local account or a new
  // administrator is exactly as irreversible-in-practice as deleting one;
  // the previous list only ever looked at the delete direction.
  /\bnew-localuser\b/i,
  /\bnet\s+user\b[^\n]*\/add\b/i,
  /\badd-localgroupmember\b(?=[^\n]*-group)(?=[^\n]*\badministrators\b)/i,
  /\bnet\s+localgroup\s+administrators\b[^\n]*\/add/i,
  // Disabling security software (Defender) — its own CRITICAL category:
  // this is how a machine gets blinded, not a "recoverable" fix.
  /\bset-mppreference\b[^\n]*-disable\w*\s+\$true/i,
  /\b(uninstall|disable)-windows(feature|optionalfeature)\b[^\n]*defender/i,
  // Disabling the firewall wholesale (not the same as adding one rule).
  /\bnetsh\s+advfirewall\b[^\n]*\bset\b[^\n]*\bstate\s+off\b/i,
  /\bset-netfirewallprofile\b[^\n]*-enabled\s+false/i,
  // Persistent execution-policy weakening. The runner already scopes its
  // own -ExecutionPolicy Bypass to just this one invocation (powershellRunner.js)
  // — there is no legitimate reason for the agent itself to change the
  // system/user-wide policy going forward.
  /\bset-executionpolicy\b[^\n]*(unrestricted|bypass)/i,
  // "Download and run" one-liners — the standard living-off-the-land
  // pattern for pulling and executing a remote payload, in either order.
  /(downloadstring|downloadfile|invoke-webrequest|invoke-restmethod|\biwr\b|\birm\b)[^\n]*\|\s*(iex|invoke-expression)\b/i,
  /\b(iex|invoke-expression)\b[^\n]*(downloadstring|downloadfile|invoke-webrequest|invoke-restmethod|\biwr\b|\birm\b)/i,
  // Service deletion — distinct from stop/start/restart (which stay 'fix':
  // recoverable), removing a service outright is not.
  /\bsc(\.exe)?\s+delete\b/i,
  /\bremove-service\b/i,
  // Registry autostart persistence via raw text — the classic backdoor
  // mechanism, reachable here even though the structured RegistryService
  // tool has its own equivalent guard, because this is free-text PowerShell/CMD.
  /\breg(istry)?\s+add\b[^\n]*\\run\b/i,
  /\b(set|new)-itemproperty\b[^\n]*\\(currentversion\\run|winlogon)\b/i,
  // Session-disrupting
  /\b(stop|restart)-computer\b/i,
  /\bshutdown\b[^\n]*\/(r|s|p)/i,
  // Mass process kill of critical host
  /stop-process[^\n]*\b(wininit|csrss|winlogon|services|lsass|system)\b/i,
];

/**
 * Added by the security review. A deny-list can never be complete, so these target whole CLASSES of technique that let a
 * prompt-injected or confused model escape the other rules: hiding the real command, pulling or pushing data over the
 * network, surviving a reboot, blinding security tooling, and reading credentials. Anything here needs a human decision.
 */
const SECURITY_PATTERNS = [
  // Hidden or indirect execution: the real command never appears in the text the other rules inspect.
  /(^|[\s;|&(])-(e|ec|enc|encodedcommand)\b\s+[a-z0-9+/=]{16,}/i,
  /\bfrombase64string\b/i,
  /\b(iex|invoke-expression)\b/i,
  /\[scriptblock\]::create\b/i,
  /invokecommand\.invokescript\b/i,
  /\[(system\.)?reflection\.assembly\]::(load|loadfrom|loadfile)\b/i,
  /\badd-type\b[^\n]*-(typedefinition|memberdefinition)\b/i,
  // Dynamic invocation: "& $cmd", "& ('Remove'+'-Item')", ". $script" — the verb is computed at run time.
  /(^|[;|\n(]|&&)\s*[&.]\s*[$("']/,
  /\binvoke-command\b/i,
  // A second interpreter escapes the per-segment analysis entirely.
  /\b(powershell|pwsh)(\.exe)?\b[^\n]*\s-(c|command|file|enc|encodedcommand)\b/i,
  /\bstart-process\b[^\n]*\b(powershell|pwsh|cmd|wscript|cscript|mshta|rundll32|regsvr32|msiexec)\b/i,
  // Download to disk, and any upload / exfiltration (a plain read-only GET stays allowed).
  /\b(downloadfile|start-bitstransfer)\b/i,
  /\bbitsadmin\b[^\n]*\/transfer/i,
  /\bcertutil\b[^\n]*(-urlcache|-split|-decode)/i,
  /\b(invoke-webrequest|invoke-restmethod|iwr|irm|curl(\.exe)?|wget)\b[^\n]*(-outfile|\s-o\s|-infile|-method\s+(post|put|patch|delete)|\s-body\b|--data|--upload-file|\s-t\s)/i,
  // Persistence and remote access.
  /\b(register-scheduledtask|new-scheduledtask|new-service)\b/i,
  /\bschtasks(\.exe)?\b[^\n]*\/(create|change)\b/i,
  /\bsc(\.exe)?\s+(create|config)\b/i,
  /\breg(istry)?\s+add\b[^\n]*\\(runonce|image file execution options|appinit_dlls|winlogon)\b/i,
  /\b(enable-psremoting|set-wsmaninstance)\b|\bwinrm\s+(quickconfig|set)\b/i,
  /\bwmic\b[^\n]*\bprocess\s+call\s+create\b/i,
  // Blinding security tooling or covering tracks.
  /\b(add|set)-mppreference\b[^\n]*-exclusion/i,
  /\b(stop|set|disable|remove)-service\b[^\n]*\b(windefend|wdnissvc|wdfilter|sense|mpssvc|wscsvc|securityhealthservice|eventlog)\b/i,
  /\bsc(\.exe)?\s+(stop|config)\s+(windefend|wdnissvc|sense|mpssvc|wscsvc|securityhealthservice|eventlog)\b/i,
  /\b(wevtutil\s+(cl|clear-log)|clear-eventlog)\b/i,
  /\b(vssadmin|wbadmin)\b[^\n]*\bdelete\b/i,
  // Credential and secret access.
  /\b(mimikatz|procdump|ntdsutil|cmdkey|vaultcmd)\b/i,
  /\breg(\.exe)?\s+save\s+hk(lm|ey_local_machine)\\(sam|security|system)\b/i,
  /(\.ssh[\\/]|\bid_(rsa|ed25519|ecdsa)\b|\.aws[\\/]credentials|\.kube[\\/]config|[\\/]login data\b|\bntuser\.dat\b|[\\/]config[\\/]sam\b)/i,
];

/**
 * Verbs / commands that only read state. Anchored to the start of the
 * (trimmed) command or a pipeline segment so a mutating verb later in the
 * pipeline still escalates the classification.
 */
const READ_ALLOWLIST = [
  /^get-/i,
  /^test-/i,
  /^resolve-/i,
  /^measure-/i,
  /^select-/i,
  /^where-/i,
  /^sort-/i,
  /^find-/i,
  /^show-/i,
  /^read-/i,
  /^compare-/i,
  /^format-list/i,
  /^format-table/i,
  /^out-string/i,
  /^convertto-/i,
  /^convertfrom-/i,
  /^ipconfig\b/i,
  /^systeminfo\b/i,
  /^ping\b/i,
  /^tracert\b/i,
  /^nslookup\b/i,
  /^netstat\b/i,
  /^tasklist\b/i,
  /^wmic\b(?![^\n]*\b(delete|call|set)\b)/i,
  /^whoami\b/i,
  /^hostname\b/i,
  /^echo\b/i,
  /^write-(host|output)\b/i,
  /^dir\b/i,
  /^ls\b/i,
  /^type\b/i,
  /^gc\b/i,
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

  // PowerShell ignores backticks inside names ("I`E`X", "Invoke-Ex`pression"), so strip them before matching; the
  // original text is still what would run, which is exactly why this normalisation is needed.
  const normalized = cmd.replace(/`/g, '');
  for (const pattern of SECURITY_PATTERNS) {
    if (pattern.test(normalized)) {
      return {
        level: 'blocked',
        reason:
          'Obfuscated or indirect execution, network download/upload, persistence, security-tool tampering or credential access — needs a human decision.',
      };
    }
  }

  // A command reads only if EVERY statement/pipeline segment is a read-only
  // verb. Splitting on "|" alone let a statement separator smuggle a mutating
  // command past the check — "Get-Process; Remove-Item C:\Windows -Recurse"
  // starts with a read verb and was classified 'read', auto-running the
  // Remove-Item unattended. PowerShell also accepts "\n" and "&&"/"||" as
  // statement separators, so all of them have to split the command before
  // any segment is trusted.
  const segments = cmd
    .split(/[|;\n]|&&|\|\|/)
    .map((s) => s.trim())
    .filter(Boolean);
  const everySegmentReads =
    segments.length > 0 &&
    segments.every((seg) => READ_ALLOWLIST.some((pattern) => pattern.test(seg)));
  if (everySegmentReads) {
    return { level: 'read', reason: 'Read-only diagnostic.' };
  }

  return { level: 'fix', reason: 'Mutating but recoverable action.' };
}

export default classifyCommand;
