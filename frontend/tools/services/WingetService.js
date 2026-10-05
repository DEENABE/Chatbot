import { BaseToolService } from '../BaseToolService.js';
import { spawn, checkCancellation } from '../ExecutionContext.js';

/**
 * winget-backed discovery and installation of applications that are not installed yet.
 *
 *   winget.search   READ       find candidate package ids (never changes the machine)
 *   winget.install  DANGEROUS  install one exact id; always goes through the ConfirmationGate first
 *
 * Nothing here touches a shell: winget.exe is started with an argv array, and every id is validated and
 * confirmed to exist (`winget show`) before a human is even asked. The model never supplies a command line.
 */
export const PACKAGE_ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._+-]{1,127}$';
const PACKAGE_ID = new RegExp(PACKAGE_ID_PATTERN);
// Search text: no control characters or shell/wildcard metacharacters.
const QUERY_PATTERN = '^[^\\x00-\\x1f"\'`$;&|<>^%*?\\[\\]{}\\\\!]{1,100}$';
const SOURCE = ['--source', 'winget', '--accept-source-agreements', '--disable-interactivity'];
const INSTALL_ARGS = ['--exact', '--silent', '--accept-package-agreements', ...SOURCE];
export const INSTALL_TIMEOUT_MS = 20 * 60_000;
const failure = (code, message = code) => Object.assign(new Error(message), { code });

// Exit codes from winget-cli doc/windows/package-manager/winget/returnCodes.md. Output text is checked as well,
// because the code an installer reports varies by technology.
const EXIT = Object.freeze({
  ALREADY_INSTALLED: [0x8a150061, 0x8a15010d],
  REBOOT: [0x8a150109, 0x8a15010a, 0x8a15010b, 3010, 1641],
  NEEDS_ADMIN: [0x8a150019],
  ELEVATION_PROHIBITED: [0x8a150056],
  CANCELLED: [0x8a15010c, 1223, 1602],
  HASH_MISMATCH: [0x8a150011],
  NO_INSTALLER: [0x8a150010],
  NOT_FOUND: [0x8a150014, 0x8a150017],
  POLICY: [0x8a15003a, 0x8a15010f, 0x8a15001b],
  IN_USE: [0x8a150101, 0x8a150103],
});
const is = (code, list) => Number.isInteger(code) && list.includes(code);

/** Map a finished `winget install` to a stable status. Pure, so it is unit-testable without winget. */
export function classifyInstall({ code, text = '', timedOut = false, missing = false }) {
  if (missing) return { ok: false, status: 'WINGET_UNAVAILABLE', message: 'winget is not available on this PC. Install “App Installer” from the Microsoft Store.' };
  if (timedOut) return { ok: false, status: 'INSTALL_TIMEOUT', message: 'The installation did not finish in time and was stopped.' };
  const reboot = is(code, EXIT.REBOOT) || (code !== 0 && /(?:restart|reboot)\b/i.test(text));
  if (code === 0) return reboot
    ? { ok: true, status: 'INSTALLED_REBOOT_REQUIRED', needsReboot: true, message: 'Installed. Restart Windows to finish.' }
    : { ok: true, status: 'INSTALLED', message: 'Installed successfully.' };
  if (is(code, EXIT.ALREADY_INSTALLED) || /already installed|no available upgrade found/i.test(text)) return { ok: true, status: 'ALREADY_INSTALLED', message: 'The application is already installed.' };
  if (reboot) return { ok: true, status: 'INSTALLED_REBOOT_REQUIRED', needsReboot: true, message: 'Installed. Restart Windows to finish.' };
  if (is(code, EXIT.CANCELLED)) return { ok: false, status: 'INSTALL_CANCELLED', adminRequired: true, message: 'The installation was cancelled (for example the administrator/UAC prompt was declined).' };
  if (is(code, EXIT.NEEDS_ADMIN) || is(code, EXIT.ELEVATION_PROHIBITED) || /administrator|elevat/i.test(text)) return { ok: false, status: 'ADMIN_REQUIRED', adminRequired: true, message: 'This package needs administrator rights. Approve the UAC prompt or run Chanakya as Administrator.' };
  if (is(code, EXIT.HASH_MISMATCH)) return { ok: false, status: 'HASH_MISMATCH', message: 'The downloaded installer failed its integrity check and was not run.' };
  if (is(code, EXIT.NO_INSTALLER)) return { ok: false, status: 'NO_APPLICABLE_INSTALLER', message: 'This package has no installer that applies to this PC.' };
  if (is(code, EXIT.NOT_FOUND)) return { ok: false, status: 'PACKAGE_NOT_FOUND', message: 'winget could not find that package.' };
  if (is(code, EXIT.POLICY)) return { ok: false, status: 'BLOCKED_BY_POLICY', message: 'This installation is blocked by a system policy.' };
  if (is(code, EXIT.IN_USE)) return { ok: false, status: 'PACKAGE_IN_USE', message: 'The application is running; close it and try again.' };
  return { ok: false, status: 'INSTALL_FAILED', message: `The installation failed (exit code 0x${(code ?? 0).toString(16)}).` };
}

/**
 * Parse winget's fixed-width table. Column offsets are read from the header line (never hardcoded), so any
 * console width works. Spinner frames and \r-overwritten progress output are stripped first. Ids that winget
 * truncated with an ellipsis are unusable and are dropped.
 */
export function parseWingetTable(raw) {
  const lines = String(raw).split('\n').map(l => l.replace(/\r+$/, '').split('\r').pop());
  const sep = lines.findIndex(l => /^-{5,}\s*$/.test(l));
  if (sep < 1) return [];
  const cols = [...lines[sep - 1].matchAll(/\S+/g)].map(m => ({ name: m[0].toLowerCase(), start: m.index }));
  const at = name => cols.findIndex(c => c.name === name);
  const idCol = at('id');
  if (idCol === -1) return [];
  const cell = (line, i) => i < 0 ? '' : line.slice(cols[i].start, i + 1 < cols.length ? cols[i + 1].start : undefined).trim();
  const rows = [];
  for (const line of lines.slice(sep + 1)) {
    if (!line.trim()) continue;
    let id = cell(line, idCol);
    if (id.endsWith('…')) continue;
    // Wide (CJK) characters can shift columns: fall back to the first id-shaped token on the line.
    if (!PACKAGE_ID.test(id)) {
      const m = line.match(/\b[A-Za-z0-9][\w+-]*(?:\.[\w+-]+)+\b|\b[A-Z0-9]{12}\b/);
      if (!m) continue;
      id = m[0];
    }
    rows.push({ id, name: cell(line, 0), version: cell(line, at('version')), source: cell(line, at('source')) });
  }
  return rows;
}

function rank(rows, query) {
  const q = query.toLowerCase().replace(/\s+/g, '');
  const score = r => {
    const n = r.name.toLowerCase().replace(/\s+/g, ''), id = r.id.toLowerCase();
    if (n === q || id === q || id.endsWith(`.${q}`)) return 0;
    if (n.startsWith(q) || id.includes(q)) return 1;
    return n.includes(q) ? 2 : 3;
  };
  return rows.map((r, i) => [r, i]).sort((a, b) => score(a[0]) - score(b[0]) || a[1] - b[1]).map(x => x[0]);
}

/** Default runner: winget.exe via argv (no shell), cancellation-aware, whole process tree killed on timeout. */
export function runWinget(args, { timeout = 60_000, onLine } = {}) {
  return new Promise((resolve, reject) => {
    let child, out = '', timedOut = false;
    try { checkCancellation(); child = spawn('winget.exe', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { return reject(error); }
    const timer = setTimeout(() => { timedOut = true; spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {}); }, timeout);
    const feed = chunk => {
      const text = chunk.toString('utf8');
      if (out.length < 2_000_000) out += text;
      if (onLine) for (const line of text.split(/[\r\n]+/)) if (line.trim()) onLine(line.trim());
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('error', error => {
      clearTimeout(timer);
      if (error.code === 'ENOENT') resolve({ code: null, out: '', missing: true });
      else reject(error); // includes AbortError when the engine cancels the task
    });
    child.on('close', code => { clearTimeout(timer); resolve({ code: code === null ? null : code >>> 0, out, timedOut }); });
  });
}

// Only milestone lines are kept as progress; spinner frames and download bars are noise.
const MILESTONE = /found|download|verified|starting|installing|successfully|fail|error|restart|reboot|administrator/i;
const NOISE = /^[-\\|/]$|[█▒]|^\s*\d+(?:\.\d+)?\s*[KMG]?B\s*\/\s*\d/;

export class WingetService extends BaseToolService {
  /**
   * @param gate ConfirmationGate
   * @param options.appService  AppService; its registry is refreshed after a successful install
   * @param options.run         injectable winget runner (tests)
   * @param options.onProgress  optional (stage) => void for live progress
   */
  constructor(gate, { appService, run = runWinget, onProgress } = {}) {
    super('winget', gate);
    this.appService = appService;
    this.run = run;
    this.onProgress = onProgress;
    this.known = new Map(); // lowercase id -> {id,name,version,publisher}
  }

  get actions() {
    return {
      search: {
        schema: { query: { type: 'string', required: true, minLength: 1, maxLength: 100, pattern: QUERY_PATTERN } },
        destructive: false, handler: p => this.search(p),
        description: 'Search the winget repository for an application that is not installed. Returns package ids and names; the user is never asked for anything here.',
      },
      install: {
        schema: { packageId: { type: 'string', required: true, minLength: 2, maxLength: 128, pattern: PACKAGE_ID_PATTERN } },
        destructive: true, handler: p => this.install(p),
        description: 'Install one exact winget package id (taken from winget.search) silently. Requires explicit human confirmation. Afterwards open the app with app.openApp.',
      },
    };
  }

  /** Confirm the id exists BEFORE a human is asked, so the prompt can show the real package name and version. */
  async execute(action, params = {}) {
    // Malformed or missing ids fall through to the base class, which rejects them with a VALIDATION_ERROR.
    if (action === 'install' && typeof params.packageId === 'string' && PACKAGE_ID.test(params.packageId)) await this.describe(params.packageId);
    return super.execute(action, params);
  }

  getConfirmationMessage(action, params) {
    const info = this.known.get(String(params.packageId).toLowerCase());
    const label = info ? `“${info.name}” (${info.id}${info.version ? ` ${info.version}` : ''}${info.publisher ? `, ${info.publisher}` : ''})` : `package ${params.packageId}`;
    return `Install ${label} from the winget repository? It runs silently, may show a Windows administrator (UAC) prompt, and changes the software installed on this PC.`;
  }

  async search({ query }) {
    checkCancellation();
    const r = await this.run(['search', '--query', query, ...SOURCE, '--count', '10'], { timeout: 60_000 });
    if (r.missing) return { success: false, status: 'WINGET_UNAVAILABLE', message: classifyInstall({ missing: true }).message };
    if (r.timedOut) return { success: false, status: 'SEARCH_TIMEOUT', message: 'The winget search timed out.' };
    const results = rank(parseWingetTable(r.out), query).slice(0, 8);
    for (const x of results) this.known.set(x.id.toLowerCase(), { id: x.id, name: x.name, version: x.version });
    return {
      success: true, status: results.length ? 'PACKAGES_FOUND' : 'NO_PACKAGES_FOUND', query, results,
      message: results.length ? `Found ${results.length} package(s). Pick the id whose name best matches, then call winget.install.` : 'No matching package in the winget repository.',
    };
  }

  /** `winget show` is the authority on whether an id exists; its result is cached for the confirmation text. */
  async describe(packageId) {
    const id = String(packageId ?? '');
    if (!PACKAGE_ID.test(id)) throw failure('INVALID_PACKAGE_ID', 'That is not a valid winget package id.');
    const cached = this.known.get(id.toLowerCase());
    if (cached?.publisher !== undefined) return cached;
    const r = await this.run(['show', '--id', id, '--exact', ...SOURCE], { timeout: 45_000 });
    if (r.missing) throw failure('WINGET_UNAVAILABLE', classifyInstall({ missing: true }).message);
    if (r.code !== 0) throw failure('PACKAGE_NOT_FOUND', `winget has no package with the exact id “${id}”. Use winget.search first.`);
    const found = r.out.match(/^Found\s+(.+?)\s+\[([^\]]+)\]/m);
    const info = {
      id: found?.[2] ?? id, name: found?.[1] ?? id,
      version: r.out.match(/^Version:\s*(.+)$/m)?.[1]?.trim() ?? cached?.version ?? '',
      publisher: r.out.match(/^Publisher:\s*(.+)$/m)?.[1]?.trim() ?? '',
    };
    if (info.id.toLowerCase() !== id.toLowerCase()) throw failure('PACKAGE_NOT_FOUND', `winget has no package with the exact id “${id}”.`);
    this.known.set(id.toLowerCase(), info);
    return info;
  }

  async install({ packageId }) {
    checkCancellation();
    const info = await this.describe(packageId); // also re-checked here: confirmation records can outlive the cache
    const stages = [];
    const note = line => {
      if (NOISE.test(line) || !MILESTONE.test(line) || stages.at(-1) === line) return;
      stages.push(line.slice(0, 160));
      try { this.onProgress?.({ packageId, stage: line.slice(0, 160) }); } catch { /* progress is best effort */ }
    };
    const started = Date.now();
    const r = await this.run(['install', '--id', info.id, ...INSTALL_ARGS], { timeout: INSTALL_TIMEOUT_MS, onLine: note });
    const outcome = classifyInstall(r);

    // Confirm with the package manager's own inventory rather than trusting the exit code alone.
    let verified = false;
    if (outcome.ok && !outcome.needsReboot) {
      const listed = await this.run(['list', '--id', info.id, '--exact', ...SOURCE.slice(2)], { timeout: 45_000 }).catch(() => null);
      verified = listed?.code === 0 && parseWingetTable(listed.out).some(x => x.id.toLowerCase() === info.id.toLowerCase());
    }
    // Make the new application resolvable by app.openApp straight away.
    let registryRefreshed = false;
    if (outcome.ok) {
      try { await this.appService?.registry?.refresh?.(); registryRefreshed = !!this.appService?.registry; } catch { /* the next resolve refreshes on a miss */ }
    }
    return {
      success: outcome.ok, status: outcome.status, packageId: info.id, name: info.name, version: info.version,
      exitCode: r.code, needsReboot: !!outcome.needsReboot, adminRequired: !!outcome.adminRequired, registryRefreshed,
      durationMs: Date.now() - started, stages: stages.slice(-12), message: outcome.message,
      verification: { status: verified ? 'verified' : 'unverified', criterion: verified ? 'winget_list' : 'exit_code_only', observedAt: new Date().toISOString() },
      ...(outcome.ok ? { next: `Call app.openApp with query "${info.name}" to launch it.` } : {}),
    };
  }
}
