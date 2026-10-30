import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { SETTINGS } from '../apps/SystemSettingsCatalog.js';
import { ADMIN_SCRIPT_SHA256 } from '../apps/SystemSettingsAdminDigest.js';
import { desktopPaths, helperScriptPath, powerShellPath } from '../DesktopRuntime.js';

/**
 * Applies the few Windows settings that need administrator rights, and only those (catalog entries with elevation: "admin").
 *
 * How elevation stays honest:
 *   - It runs only after the human ConfirmationGate approved this exact change, and then Windows shows its OWN UAC prompt.
 *     There is no silent elevation, no UAC bypass and no stored credential. Declining UAC stops everything.
 *   - The elevated script (SystemSettingsAdmin.ps1) must sit in the protected install folder (under Program Files, not writable by
 *     standard users, no reparse points), its hash must equal the digest pinned in the app, and the elevated process re-checks that
 *     hash on the bytes it is about to run and runs them from memory. A modified script is never elevated.
 *   - The model supplies nothing but a catalog id and a typed value; both are re-validated here and again by the script.
 *   - The elevated process has no channel back to us except its exit code; the caller verifies the change by reading it back
 *     without elevation.
 */
const failure = (code, message = code) => Object.assign(new Error(message), { code });

/** Exit codes of SystemSettingsAdmin.ps1 (3 is produced by the bootstrap when the integrity check fails). */
export const ADMIN_EXIT = Object.freeze({
  APPLIED: 0,
  INVALID: 2,
  INTEGRITY: 3,
  PREREQUISITE: 4,
  UNSUPPORTED: 5,
  FAILED: 6,
  RESTART_NEEDED: 7,
  NOT_ELEVATED: 8,
});
const ADMIN_IDS = new Set(SETTINGS.filter((s) => s.elevation === 'admin').map((s) => s.id));
// ShellExecute (which shows the UAC prompt) is not reliable with very long command lines.
const MAX_ENCODED_BOOTSTRAP = 1700;

/** Hash of the script as text: a BOM or CRLF-versus-LF difference (for example from Git) never changes it. */
export function normalizedScriptSha256(input) {
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input);
  return createHash('sha256')
    .update(text.replace(/^﻿/, '').replace(/\r\n/g, '\n'), 'utf8')
    .digest('hex');
}
const psQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;
const encode = (text) => Buffer.from(text, 'utf16le').toString('base64');

/** The fixed code the elevated PowerShell runs: verify the script bytes, then run them from memory. Only validated values are spliced in. */
export function adminBootstrap({ scriptPath, sha256, id, value }) {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw failure('ADMIN_INVALID_REQUEST');
  if (!/^[a-z][a-z0-9-]{1,48}$/.test(id) || !ADMIN_IDS.has(id))
    throw failure('ADMIN_INVALID_REQUEST', 'Unknown administrator setting.');
  const literal =
    typeof value === 'boolean'
      ? value
        ? '$true'
        : '$false'
      : Number.isInteger(value) && value >= 0 && value <= 1000
        ? String(value)
        : null;
  if (literal === null) throw failure('ADMIN_INVALID_REQUEST');
  return (
    "$ErrorActionPreference='Stop';try{" +
    `$t=[IO.File]::ReadAllText(${psQuote(scriptPath)}) -replace '\\r\\n',[string][char]10;` +
    "$h=[BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($t))).Replace('-','').ToLower();" +
    `if($h -ne '${sha256}'){exit 3};` +
    '$global:AdminExit=6;' +
    `& ([scriptblock]::Create($t)) -Id '${id}' -Value ${literal} | Out-Null;` +
    'exit $global:AdminExit}catch{exit 6}'
  );
}

// Same protection test the Windows repair runner uses: under Program Files, owned and writable only by SYSTEM / Administrators /
// TrustedInstaller, no reparse points on the way. Anything else (a development tree, a per-user install) is refused.
const protectedProbe = (scriptPath) =>
  `$p=${psQuote(scriptPath)};$root=[Environment]::GetFolderPath('ProgramFiles');$ok=$p.StartsWith($root+'\\',[StringComparison]::OrdinalIgnoreCase);` +
  "$trusted=@('S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464');" +
  'while($ok -and $p){$i=Get-Item -LiteralPath $p -Force;if($i.Attributes -band [IO.FileAttributes]::ReparsePoint){$ok=$false;break};' +
  '$acl=Get-Acl -LiteralPath $p;if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $trusted){$ok=$false;break};' +
  'foreach($a in $acl.Access){$sid=$a.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value;' +
  "if($a.AccessControlType -eq 'Allow' -and $sid -notin $trusted -and -not ($a.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -and ([int]$a.FileSystemRights -band 852310)){$ok=$false}};" +
  'if(-not $ok){break};if($p -eq $root){break};$p=Split-Path -LiteralPath $p};' +
  "if(-not $ok){Write-Output 'UNPROTECTED';exit 0};";

/** The non-elevated launcher: protected-install check, then Start-Process -Verb RunAs (this is what shows the UAC prompt). */
export function adminLauncher({ powershell, scriptPath, encodedBootstrap }) {
  return (
    "$ErrorActionPreference='Stop';" +
    protectedProbe(scriptPath) +
    'try{' +
    `$proc=Start-Process -FilePath ${psQuote(powershell)} -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${encodedBootstrap}';` +
    "Write-Output ('EXIT:'+$proc.ExitCode)}" +
    'catch{$w=$_.Exception;$c=$null;while($w){if($w -is [System.ComponentModel.Win32Exception]){$c=$w.NativeErrorCode;break};$w=$w.InnerException};' +
    "if($c -eq 1223 -or $_.Exception.Message -like '*canceled by the user*'){Write-Output 'DECLINED'}else{Write-Output 'FAILED'}}"
  );
}

export class SettingsElevator {
  /**
   * @param options.spawnFn         injectable for tests
   * @param options.paths           injectable for tests: () => ({ powershell, script, packaged })
   * @param options.readFile        injectable for tests
   * @param options.expectedSha256  the pinned digest (tests pass their own)
   * @param options.timeoutMs       covers the UAC prompt plus the change itself (optional features can take minutes)
   */
  constructor({
    platform = process.platform,
    spawnFn = spawn,
    paths,
    readFile = fs.readFileSync,
    expectedSha256 = ADMIN_SCRIPT_SHA256,
    timeoutMs = 10 * 60_000,
  } = {}) {
    this.platform = platform;
    this.spawnFn = spawnFn;
    this.readFile = readFile;
    this.expectedSha256 = expectedSha256;
    this.timeoutMs = timeoutMs;
    this.paths =
      paths ||
      (() => ({
        powershell: powerShellPath(),
        script: helperScriptPath('SystemSettingsAdmin.ps1'),
        packaged: desktopPaths().isPackaged,
      }));
  }

  /** Change one administrator setting. Resolves {outcome: "applied" | "restart-needed"}; throws coded errors otherwise. */
  async apply({ id, value } = {}) {
    if (this.platform !== 'win32')
      throw failure(
        'ELEVATION_UNAVAILABLE',
        'Administrator settings can only be changed on Windows.',
      );
    if (!ADMIN_IDS.has(id))
      throw failure('ADMIN_INVALID_REQUEST', 'That setting is not an administrator setting.');
    let location;
    try {
      location = this.paths();
    } catch (error) {
      if (error?.code === 'DESKTOP_HELPER_MISSING')
        throw failure(
          'ADMIN_HELPER_MISSING',
          'The administrator settings helper (SystemSettingsAdmin.ps1) is missing. Security software may have removed it; reinstall the app.',
        );
      throw error;
    }
    if (!location.packaged)
      throw failure(
        'ADMIN_HELPER_UNPROTECTED',
        'Administrator settings only work in the installed app (under Program Files), never from a development folder.',
      );
    let bytes;
    try {
      bytes = this.readFile(location.script);
    } catch {
      throw failure(
        'ADMIN_HELPER_MISSING',
        'The administrator settings helper (SystemSettingsAdmin.ps1) could not be read.',
      );
    }
    if (normalizedScriptSha256(bytes) !== this.expectedSha256)
      throw failure(
        'ADMIN_HELPER_INTEGRITY',
        'The administrator settings helper does not match the version shipped with the app, so it was not run.',
      );
    const bootstrap = adminBootstrap({
      scriptPath: location.script,
      sha256: this.expectedSha256,
      id,
      value,
    });
    const encodedBootstrap = encode(bootstrap);
    if (encodedBootstrap.length > MAX_ENCODED_BOOTSTRAP)
      throw failure(
        'ADMIN_HELPER_UNPROTECTED',
        'The install path is too long for the administrator helper. Install the app in a shorter folder under Program Files.',
      );
    const output = await this.#run(
      location.powershell,
      adminLauncher({
        powershell: location.powershell,
        scriptPath: location.script,
        encodedBootstrap,
      }),
    );
    return this.#interpret(output, id);
  }

  #run(powershell, launcher) {
    return new Promise((resolve, reject) => {
      let out = '';
      let settled = false;
      const child = this.spawnFn(
        powershell,
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encode(launcher)],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
      );
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        error ? reject(error) : resolve(value);
      };
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        finish(
          failure(
            'ELEVATION_TIMEOUT',
            'Windows did not finish the administrator change in time. It may still be applying; check the setting before retrying.',
          ),
        );
      }, this.timeoutMs);
      child.stdout?.setEncoding?.('utf8');
      child.stdout?.on('data', (chunk) => {
        out += chunk;
        if (out.length > 4096) out = out.slice(-4096);
      });
      child.on('error', () =>
        finish(
          failure(
            'ELEVATION_FAILED',
            'Windows PowerShell could not be started for the administrator change.',
          ),
        ),
      );
      child.on('close', () => finish(null, out));
    });
  }

  #interpret(output, id) {
    const text = String(output || '');
    if (/^UNPROTECTED\s*$/m.test(text))
      throw failure(
        'ADMIN_HELPER_UNPROTECTED',
        'Administrator settings need the app installed under Program Files, in a folder only administrators can change.',
      );
    if (/^DECLINED\s*$/m.test(text))
      throw failure(
        'ELEVATION_DECLINED',
        'Administrator approval (UAC) was declined, so nothing was changed.',
      );
    const exit = /^EXIT:(-?\d+)\s*$/m.exec(text);
    if (!exit)
      throw failure('ELEVATION_FAILED', 'Windows could not start the administrator change.');
    const code = Number(exit[1]);
    if (code === ADMIN_EXIT.APPLIED) return { outcome: 'applied' };
    if (code === ADMIN_EXIT.RESTART_NEEDED) return { outcome: 'restart-needed' };
    const messages = {
      [ADMIN_EXIT.INVALID]: ['ADMIN_INVALID_REQUEST', 'That request is not valid.'],
      [ADMIN_EXIT.INTEGRITY]: [
        'ADMIN_HELPER_INTEGRITY',
        'The administrator settings helper does not match the version shipped with the app, so it was not run.',
      ],
      [ADMIN_EXIT.PREREQUISITE]: [
        'ADMIN_PREREQUISITE',
        id === 'fast-startup'
          ? 'Fast Startup needs hibernate to be on first.'
          : 'Windows Update active hours can be at most 18 hours long.',
      ],
      [ADMIN_EXIT.UNSUPPORTED]: [
        'ADMIN_UNSUPPORTED',
        'This edition of Windows does not support that setting.',
      ],
      [ADMIN_EXIT.NOT_ELEVATED]: [
        'ELEVATION_FAILED',
        'Windows did not give the helper administrator rights.',
      ],
    };
    const [errorCode, message] = messages[code] || [
      'ADMIN_FAILED',
      'Windows reported an error while changing the setting.',
    ];
    throw failure(errorCode, message);
  }
}
