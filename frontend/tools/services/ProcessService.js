import {helperScriptPath,powerShellPath} from '../DesktopRuntime.js';
import { resolveDocumentTarget } from '../apps/DocumentTarget.js';
import { trustedSystemCapability, systemProcessNames, systemLaunchCommand } from '../apps/WindowsSystemCapabilityRegistry.js';
/**
 * @fileoverview Process Service for listing, inspecting, starting, and
 * terminating OS processes.  Uses PowerShell for queries and `taskkill` /
 * `child_process.spawn` for mutations.
 *
 * @module ProcessService
 */

import { execFile, spawn } from '../ExecutionContext.js';
import { BaseToolService } from '../BaseToolService.js';
import { isBlockedCommand } from '../dangerGuard.js';
import { executionContext } from '../ExecutionContext.js';
import { checkApplicationReadiness } from '../ApplicationReadiness.js';
import path from 'node:path';
import { isAllowedLegacyProcess } from '../repair/contract.js';
import { validateTarget } from '../apps/AppTargetPolicy.js';
import { fileURLToPath } from 'node:url';
import { spawn as spawnApplication } from 'node:child_process';

/**
 * Process names that must never be terminated through this tool — mirrors
 * the equivalent stop-process guard in backend/src/agent/dangerClassifier.js
 * (that one only matches a raw PowerShell Stop-Process string; kill() here
 * goes straight to taskkill /PID with no such check, an independent path to
 * the same catastrophic outcome — killing any of these reliably crashes or
 * locks out the whole session, not just one app).
 */
const PROTECTED_PROCESS_NAMES = new Set([
  'wininit', 'csrss', 'winlogon', 'services', 'lsass', 'smss', 'system', 'ntoskrnl'
]);

/**
 * Pure predicate, exported separately from kill() so it can be regression-
 * tested directly against known process names — proving the policy decision
 * itself is correct without needing to resolve and nearly-terminate a real
 * critical PID (wininit/csrss/lsass/etc. always exist on any Windows
 * machine, including the one running the test suite) just to exercise it.
 *
 * @param {string} name - A process name (case-insensitive, no .exe suffix expected).
 * @returns {boolean}
 */
export function isProtectedProcessName(name) {
  return PROTECTED_PROCESS_NAMES.has(String(name || '').trim().toLowerCase());
}

/**
 * Service for OS-level process management.
 *
 * @extends BaseToolService
 */
export class ProcessService extends BaseToolService {
  async observeSystemApp(app,waitMs=8000) {
    const trusted=trustedSystemCapability(app);if(!trusted)throw new Error('APP_UNSAFE_TARGET');
    const title=trusted.windowTitle.replace(/'/g,"''");
    const names=systemProcessNames(trusted);
    return this._runPS(`Add-Type -AssemblyName UIAutomationClient;Add-Type -AssemblyName UIAutomationTypes;$deadline=[DateTime]::UtcNow.AddMilliseconds(${waitMs});do{$windows=[Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children,[Windows.Automation.Condition]::TrueCondition);foreach($w in $windows){if(${app.id==='file-explorer'?"$w.Current.ClassName -eq 'CabinetWClass' -and $w.Current.Name -ne 'Control Panel'":`$w.Current.Name.IndexOf('${title}',[StringComparison]::OrdinalIgnoreCase) -ge 0`}){$p=Get-Process -Id $w.Current.ProcessId -ErrorAction SilentlyContinue;if($p.ProcessName -in @('${names.join("','")}')){@{Id=$p.Id;MainWindowTitle=$w.Current.Name}|ConvertTo-Json -Compress;exit}}};Start-Sleep -Milliseconds 200}while([DateTime]::UtcNow -lt $deadline)`,waitMs+4000);
  }
  /** Internal registry-only launch path; intentionally absent from tool actions. */
  async launchApp(app, target) {
    if(target)target=await resolveDocumentTarget(target);
    validateTarget(app);
    const signal=executionContext.getStore()?.signal;
    signal?.throwIfAborted();
    // An open Settings window carries the same title for every page: always launch the URI so it navigates.
    const navigatesExisting=/^ms-settings:/.test(trustedSystemCapability(app)?.launchArgs?.[0]||'');
    if(!target && app.executablePath && !navigatesExisting) {
      const exe=app.executablePath.replace(/'/g,"''");
      const label=app.windowTitle?.replace(/'/g,"''");
      const existing=trustedSystemCapability(app)?await this.observeSystemApp(app,500):await this._runPS(`$p=Get-Process -ErrorAction SilentlyContinue | Where-Object {$_.MainWindowHandle -ne 0 -and $_.Path -eq '${exe}' ${label?`-and $_.MainWindowTitle.IndexOf('${label}',[StringComparison]::OrdinalIgnoreCase) -ge 0`:''}} | Select-Object -First 1 Id,MainWindowTitle;if($p){$null=(New-Object -ComObject WScript.Shell).AppActivate($p.Id);$p|ConvertTo-Json -Compress}`,5000).catch(()=>null);
      if(existing?.Id) {
        const observedAt=new Date().toISOString();
        // A window already observed for a trusted system tool is the same evidence a fresh launch would produce.
        return {processId:existing.Id,readiness:{status:'ready',criterion:label?'window_title':'executable_process',pid:existing.Id,observedAt},
          ...(trustedSystemCapability(app)?{verification:{status:'verified',criterion:'window_title',confidence:'medium',windowTitle:existing.MainWindowTitle||'',observedAt}}:{})};
      }
    }
    if(app.launchType==='app_user_model_id') {
      const evidence=await new Promise((resolve,reject)=>execFile(powerShellPath(),
        ['-NoProfile','-NonInteractive','-File',helperScriptPath('ActivateApp.ps1'),'-AppId',app.appUserModelId],
        {windowsHide:true,timeout:15000,maxBuffer:65536},(error,out)=>{if(error)return reject(error);try{resolve(JSON.parse(out));}catch(e){reject(e);}}));
      if(evidence.appUserModelId!==app.appUserModelId || !Number.isInteger(evidence.pid)||evidence.pid<1)throw new Error('APP_INVALID_EVIDENCE');
      return {processId:evidence.pid,windowId:evidence.windowId,readiness:{status:'ready',criterion:'activated_process',pid:evidence.pid,windowId:evidence.windowId,observedAt:evidence.observedAt}};
    }
    // The application outlives the tool call. Cancellation bounds observation,
    // but must not kill the user's application when the tool timeout later fires.
    signal?.throwIfAborted();
    const launchedAt=new Date().toISOString();
    const command=target?null:systemLaunchCommand(app);
    const child=spawnApplication(command?command.executable:app.executablePath,target?[target.path||target.value]:(command?.args||[]),{shell:false,windowsHide:false,detached:true,stdio:'ignore'});
    await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
    child.unref();
    if(target || trustedSystemCapability(app)) {
      const executable=app.executablePath.replace(/'/g,"''");
      const label=(target?target.path?path.win32.basename(target.path):new URL(target.value).hostname:app.windowTitle).replace(/'/g,"''");
      const system=!!trustedSystemCapability(app);
      const evidence=system?await this.observeSystemApp(app):await this._runPS(`$deadline=[DateTime]::UtcNow.AddSeconds(10);do{$p=Get-Process -ErrorAction SilentlyContinue | Where-Object {$_.MainWindowHandle -ne 0 -and $_.MainWindowTitle.IndexOf('${label}',[StringComparison]::OrdinalIgnoreCase) -ge 0 -and $_.Path -eq '${executable}'}|Select-Object -First 1 Id,MainWindowTitle;if($p){$p|ConvertTo-Json -Compress;break};Start-Sleep -Milliseconds 300}while([DateTime]::UtcNow -lt $deadline)`,15000);
      const verified=Number.isInteger(evidence?.Id)&&evidence.Id>0;
      return {processId:evidence?.Id||child.pid,readiness:{status:verified?'ready':'not_ready',criterion:'window_title',pid:evidence?.Id,observedAt:new Date().toISOString()},
        verification:{status:verified?'verified':'unverified',criterion:'window_title',confidence:verified?'medium':'low',windowTitle:evidence?.MainWindowTitle||'',observedAt:new Date().toISOString()}};
    }
    const evidence=await new Promise((resolve,reject)=>execFile(powerShellPath(),
      ['-NoProfile','-NonInteractive','-File',helperScriptPath('ObserveApp.ps1'),'-ExecutablePath',app.executablePath,'-LaunchProcessId',String(child.pid),'-LaunchedAt',launchedAt],
      {windowsHide:true,timeout:16000,maxBuffer:65536,encoding:'utf8'},(error,out)=>{if(error)return reject(error);try{resolve(JSON.parse(out));}catch(e){reject(e);}}));
    if(Number.isInteger(evidence?.pid)&&evidence.pid>0&&evidence.windowId)return {processId:evidence.pid,windowId:evidence.windowId,readiness:{status:'ready',criterion:'executable_process',windowCriterion:evidence.criterion,pid:evidence.pid,windowId:evidence.windowId,observedAt:evidence.observedAt}};
    return {processId:child.pid,readiness:{status:'not_ready',criterion:'executable_process'}};
  }
  constructor(confirmationGate) {
    super('process', confirmationGate);
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  /** @override */
  get actions() {
    return {
      list: {
        handler: this.list.bind(this),
        schema: {
          sortBy: {
            type: 'enum',
            required: false,
            values: ['cpu', 'memory', 'name', 'pid'],
          },
          limit: { type: 'number', required: false, integer: true, min: 1, max: 10000 },
        },
        destructive: false,
        description: 'List running processes with optional sorting and limit',
      },
      getProcess: {
        handler: this.getProcess.bind(this),
        schema: {
          pid: { type: 'number', required: false, integer: true },
          name: { type: 'string', required: false },
        },
        destructive: false,
        description: 'Retrieve detailed information about a specific process',
      },
      kill: {
        handler: this.kill.bind(this),
        schema: {
          pid: { type: 'number', required: true, integer: true },
          force: { type: 'boolean', required: false },
        },
        destructive: true,
        description: 'Terminate a process by PID',
      },
      startProcess: {
        handler: this.startProcess.bind(this),
        schema: {
          command: { type: 'string', required: true, minLength: 1, maxLength: 4096, pattern: '\\S' },
          args: { type: 'array', required: false, maxItems: 128, itemSchema: { type: 'string', maxLength: 4096 } },
          detached: { type: 'boolean', required: false },
        },
        destructive: true,
        description: 'Start a new process',
      },
    };
  }

  /**
   * Returns the confirmation message for destructive actions.
   *
   * @param {string} action - The action name.
   * @param {Object} params - The action parameters.
   * @returns {string|null} Confirmation message or null if not destructive.
   */
  getConfirmationMessage(action, params) {
    switch (action) {
      case 'kill':
        return `Terminate process PID ${params.pid}${params.force ? ' (forced)' : ''}?`;
      case 'startProcess':
        return `Start process: ${params.command}${params.args?.length ? ' ' + params.args.join(' ') : ''}?`;
      default:
        return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Execute a PowerShell command and return parsed JSON.
   *
   * @param {string} command - PowerShell command string.
   * @returns {Promise<*>}
   */
  _runPS(command, timeout = 30000) {
    return new Promise((resolve, reject) => {
      execFile(
        path.join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-Command', command],
        { windowsHide: true, timeout, maxBuffer: 10 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            reject(new Error(`PowerShell error: ${stderr?.trim() || err.message}`));
            return;
          }
          try {
            const trimmed = stdout.trim();
            if (!trimmed) {
              resolve(null);
              return;
            }
            resolve(JSON.parse(trimmed));
          } catch {
            resolve(stdout.trim());
          }
        },
      );
    });
  }

  /**
   * Run `taskkill` with the given arguments.
   *
   * @param {string[]} args - Arguments for taskkill.
   * @returns {Promise<{ exitCode: number, output: string }>}
   */
  _runTaskkill(args) {
    return new Promise((resolve, reject) => {
      execFile('taskkill', args, { windowsHide: true }, (err, stdout, stderr) => {
        if (err) {
          // taskkill returns non-zero on failure but we still want the code
          if (err.code !== undefined) {
            resolve({ exitCode: err.code, output: stderr?.trim() || err.message });
            return;
          }
          reject(new Error(`taskkill error: ${stderr?.trim() || err.message}`));
          return;
        }
        resolve({ exitCode: 0, output: stdout.trim() });
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Action handlers
  // ---------------------------------------------------------------------------

  /**
   * List running processes.
   *
   * @param {{ sortBy?: string, limit?: number }} params
   * @returns {Promise<{ processes: Array, total: number }>}
   */
  async list(params = {}) {
    const { sortBy, limit = 50 } = params;

    const raw = await this._runPS(
      'Get-Process | Select-Object Id, ProcessName, CPU, WorkingSet64, Path, StartTime | ConvertTo-Json',
    );

    let processes = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
    const total = processes.length;

    // Normalise field names for consistent output
    processes = processes.map((p) => ({
      pid: p.Id,
      name: p.ProcessName,
      cpu: p.CPU ?? 0,
      memoryBytes: p.WorkingSet64 ?? 0,
      path: p.Path ?? null,
      startTime: p.StartTime ?? null,
    }));

    // Sort
    if (sortBy) {
      const key =
        sortBy === 'cpu' ? 'cpu'
        : sortBy === 'memory' ? 'memoryBytes'
        : sortBy === 'name' ? 'name'
        : 'pid';

      processes.sort((a, b) => {
        if (key === 'name') {
          return (a.name || '').localeCompare(b.name || '');
        }
        // Descending for cpu / memory, ascending for pid
        return key === 'pid'
          ? (a[key] ?? 0) - (b[key] ?? 0)
          : (b[key] ?? 0) - (a[key] ?? 0);
      });
    }

    // Limit
    const cappedLimit = Math.max(1, Math.min(limit, processes.length));
    processes = processes.slice(0, cappedLimit);

    return { processes, total };
  }

  /**
   * Get detailed information about a specific process.
   *
   * @param {{ pid?: number, name?: string }} params - At least one must be provided.
   * @returns {Promise<Object>}
   */
  async getProcess(params) {
    const { pid, name } = params;

    if (pid == null && (!name || !name.trim())) {
      throw new Error('At least one of "pid" or "name" must be provided');
    }

    let psCommand;
    if (pid != null) {
      psCommand = `Get-Process -Id ${Number(pid)} -ErrorAction Stop | Select-Object Id, ProcessName, CPU, WorkingSet64, VirtualMemorySize64, HandleCount, Threads, Path, StartTime, Responding | ConvertTo-Json`;
    } else {
      // Sanitise process name: allow only word characters, dots, dashes
      const safeName = name.replace(/[^a-zA-Z0-9._-]/g, '');
      psCommand = `Get-Process -Name '${safeName}' -ErrorAction Stop | Select-Object Id, ProcessName, CPU, WorkingSet64, VirtualMemorySize64, HandleCount, Threads, Path, StartTime, Responding | ConvertTo-Json`;
    }

    const raw = await this._runPS(psCommand);

    if (raw == null) {
      throw new Error(`Process not found (pid=${pid}, name=${name})`);
    }

    const list = Array.isArray(raw) ? raw : [raw];
    const mapped = list.map((p) => ({
      pid: p.Id,
      name: p.ProcessName,
      cpu: p.CPU ?? 0,
      memoryBytes: p.WorkingSet64 ?? 0,
      virtualMemoryBytes: p.VirtualMemorySize64 ?? 0,
      handleCount: p.HandleCount ?? 0,
      threadCount: p.Threads?.length ?? 0,
      path: p.Path ?? null,
      startTime: p.StartTime ?? null,
      responding: p.Responding ?? null,
    }));

    return mapped.length === 1 ? mapped[0] : { processes: mapped };
  }

  /**
   * Terminate a process by PID.
   *
   * @param {{ pid: number, force?: boolean }} params
   * @returns {Promise<{ killed: number, exitCode: number }>}
   */
  async kill(params) {
    const { pid, force = false } = params;

    if (!Number.isInteger(pid) || pid <= 0) {
      throw new Error('pid must be a positive integer');
    }

    // Resolve the name before doing anything irreversible — the caller (LLM
    // or human) supplied a PID, but the actual policy is name-based, same as
    // the backend's PowerShell-text danger classifier.
    let processName = null;
    try {
      const raw = await this._runPS(`(Get-Process -Id ${Number(pid)} -ErrorAction Stop).ProcessName`);
      processName = typeof raw === 'string' ? raw.trim().toLowerCase() : null;
    } catch {
      // Already gone, or couldn't be resolved — fall through and let
      // taskkill itself report "not found" rather than failing validation.
    }
    if (processName && isProtectedProcessName(processName)) {
      const error = new Error(`Refusing to terminate '${processName}' (PID ${pid}) — this is a critical system process; killing it will crash or lock out the session.`);
      error.code = 'PROTECTED_PROCESS';
      throw error;
    }

    const args = ['/PID', String(pid)];
    if (force) {
      args.push('/F');
    }

    const { exitCode } = await this._runTaskkill(args);
    return { killed: pid, exitCode };
  }

  /**
   * Start a new process.
   *
   * @param {{ command: string, args?: string[], detached?: boolean }} params
   * @returns {Promise<{ pid: number, command: string }>}
   */
  async startProcess(params) {
    const { command, args = [], detached = false } = params;

    if (!command || typeof command !== 'string') {
      throw new Error('command must be a non-empty string');
    }

    // Unlike PowerShellService.runPS/CmdService.runCmd, this launches an
    // arbitrary executable directly via spawn() — including powershell.exe
    // or cmd.exe with attacker-controlled args — which previously never
    // passed through the same command-policy check, making it a silent
    // bypass of every other guard in the tool engine. Checked against the
    // full command line (command + args) so `startProcess('powershell.exe',
    // ['-Command', '<blocked pattern>'])` is caught the same as calling
    // powershell.execute directly would be.
    const fullCommandLine = [command, ...(Array.isArray(args) ? args : [])].join(' ');
    if (isBlockedCommand(fullCommandLine)) {
      const error = new Error('This command is irreversible or session-disrupting and is blocked regardless of confirmation.');
      error.code = 'COMMAND_BLOCKED';
      throw error;
    }

    const spawnOpts = {
      windowsHide: true,
      detached: Boolean(detached),
      stdio: detached ? 'ignore' : 'pipe',
    };

    let executable=command;
    if(executionContext.getStore()) {
      if((executionContext.getStore().origin==='model' || !isAllowedLegacyProcess(params)) || process.platform!=='win32' || !path.isAbsolute(process.env.SystemRoot||'')) throw new Error('MODEL_CAPABILITY_DENIED');
      // Never resolve even an allowlisted GUI name through a user-controlled PATH.
      executable=path.join(process.env.SystemRoot,'System32',command);
    }
    const child = spawn(executable, args, spawnOpts);

    // A PID alone is not proof of a successful spawn. Keep the error listener
    // installed for cancellation errors emitted after the spawn event as well.
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });

    if (detached) {
      child.unref();
    }

    const readiness = await checkApplicationReadiness({ child, command, signal: executionContext.getStore()?.signal });
    return { pid: child.pid, command, readiness };
  }
}

export default ProcessService;

