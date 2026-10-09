import { spawn, executionContext, checkCancellation } from '../../ExecutionContext.js';
import path from 'node:path';
import { powerShellPath } from '../../DesktopRuntime.js';
import { ProviderRegistry } from '../ProviderRegistry.js';
import { error, validateInstallerPlan } from '../contracts.js';
import { OfflineInstallerProvider } from './OfflineProvider.js';
import { validateProviderDescriptor } from './MetadataProvider.js';
import { WingetProvider } from './WingetProvider.js';

export async function runSourceProcess(executable, args, { timeout = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    checkCancellation();
    let child,
      out = '',
      timedOut = false,
      settled = false;
    try {
      child = spawn(executable, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(path.basename(executable).toLowerCase() === 'powershell.exe'
          ? {
              env: { ...process.env, PSModulePath: path.join(path.dirname(executable), 'Modules') },
            }
          : {}),
      });
    } catch (failure) {
      return reject(failure);
    }
    const signal = executionContext.getStore()?.signal;
    const finish = (result, failure) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else resolve(result);
    };
    const stop = () => {
      if (Number.isSafeInteger(child.pid)) {
        try {
          executionContext
            .run({ ...executionContext.getStore(), signal: undefined }, () =>
              spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
                windowsHide: true,
                stdio: 'ignore',
              }),
            )
            .on('error', () => {});
        } catch {
          child.kill();
        }
      }
    };
    const abort = () => {
      stop();
      finish(null, signal.reason || error('CANCELLED', 'Software discovery was cancelled.'));
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
      finish({ code: null, out, timedOut: true });
    }, timeout);
    signal?.addEventListener('abort', abort, { once: true });
    const feed = (chunk) => {
      if (out.length < 2_000_000) out += chunk.toString('utf8');
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.once('error', (failure) =>
      finish(
        failure.code === 'ENOENT' ? { code: null, out: '', missing: true } : null,
        failure.code === 'ENOENT' ? null : failure,
      ),
    );
    child.once('close', (code) =>
      finish({ code: code === null ? null : code >>> 0, out, timedOut }),
    );
  });
}

export const MANAGER_PROBE_SCRIPT = String.raw`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$rows=[Collections.Generic.List[object]]::new()
# WinGet's execution alias is a reparse point. Inspect the registered Microsoft package's real binary.
$package=Get-AppxPackage -Name Microsoft.DesktopAppInstaller -ErrorAction SilentlyContinue | Select-Object -First 1
if($package -and $package.InstallLocation){$file=Join-Path $package.InstallLocation 'winget.exe';if(Test-Path -LiteralPath $file){$sig=Get-AuthenticodeSignature -LiteralPath $file;$rows.Add([pscustomobject]@{manager='winget';path=$file;signature=[string]$sig.Status;publisher=$(if($sig.SignerCertificate){[string]$sig.SignerCertificate.Subject}else{''})})}}
foreach($item in @(@{name='choco.exe';manager='chocolatey'},@{name='scoop.ps1';manager='scoop'})){$cmd=Get-Command -Name $item.name -CommandType Application,ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1;if($cmd){$rows.Add([pscustomobject]@{manager=$item.manager;path=[string]$cmd.Source;signature='unverified';publisher=''})}}
ConvertTo-Json -InputObject @($rows) -Depth 4 -Compress
`;

export async function probePackageManagers({ run = runSourceProcess } = {}) {
  const result = await run(
    powerShellPath(),
    ['-NoProfile', '-NonInteractive', '-Command', MANAGER_PROBE_SCRIPT],
    { timeout: 20_000 },
  );
  if (result.missing || result.timedOut || result.code !== 0)
    throw error(
      'MANAGER_DISCOVERY_FAILED',
      'Installed package managers could not be inspected. Offline and approved repository sources remain available.',
    );
  let values;
  try {
    values = JSON.parse(result.out.trim());
  } catch {
    throw error(
      'MANAGER_DISCOVERY_FAILED',
      'Windows did not return valid package-manager metadata.',
    );
  }
  if (!Array.isArray(values)) values = [values];
  return values.slice(0, 4);
}

export function parseWingetSources(raw) {
  let values;
  try {
    const parsed = JSON.parse(String(raw).trim());
    values = Array.isArray(parsed) ? parsed : parsed.Sources || [parsed];
  } catch {
    // `source export` emits one JSON object per source on clients without an outer array.
    const objects = [];
    let depth = 0,
      start = -1,
      quoted = false,
      escaped = false;
    for (let i = 0; i < String(raw).length; i++) {
      const char = raw[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === '{') {
        if (depth++ === 0) start = i;
      } else if (char === '}' && --depth === 0 && start >= 0) {
        try {
          objects.push(JSON.parse(raw.slice(start, i + 1)));
        } catch {}
        start = -1;
      }
    }
    values = objects;
  }
  if (!Array.isArray(values) || values.length > 30)
    throw error(
      'INVALID_MANAGER_SOURCES',
      'The package manager returned an invalid repository list.',
    );
  return values.filter(
    (item) =>
      item &&
      typeof item.Name === 'string' &&
      /^[A-Za-z0-9._ -]{1,80}$/.test(item.Name) &&
      typeof item.Arg === 'string' &&
      typeof item.Type === 'string',
  );
}

const platformRepository = (source) =>
  source.Arg?.replace(/\/$/, '') === 'https://cdn.winget.microsoft.com/cache' &&
  source.Type === 'Microsoft.PreIndexed.Package' &&
  (source.Identifier === 'Microsoft.Winget.Source_8wekyb3d8bbwe' ||
    source.Data === 'Microsoft.Winget.Source_8wekyb3d8bbwe');

/** Official catalog interface only: product publisher is deliberately unresolved, and no bytes execute. */
export class StoreHandoffProvider {
  constructor() {
    this.id = 'microsoft-store-handoff';
    this.capabilities = { offline: true, network: false };
    this.descriptor = {
      id: this.id,
      name: 'Microsoft Store official interface',
      kind: 'official-page',
      origin: 'https://apps.microsoft.com/',
      trust: 'official',
    };
  }
  async isAvailable() {
    return true;
  }
  async search(query) {
    if (query.scope === 'operating-system') return [];
    const resolvedPlan = validateInstallerPlan({
      schemaVersion: 1,
      operation: query.operation,
      protocol: 'handoff',
      product: {
        id: query.product,
        name: query.product,
        publisher: '',
        version: query.version || '',
      },
      source: {
        providerId: this.id,
        kind: 'official-page',
        origin: this.descriptor.origin,
        trust: 'official',
        publisher: 'Microsoft Corporation',
        allowedHosts: ['apps.microsoft.com'],
        publisherTrust: { publishers: ['Microsoft Corporation'] },
        evidence: 'platform-interface',
        name: this.descriptor.name,
      },
      architecture: 'any',
      platform: { os: 'windows' },
      installer: {
        format: 'page',
        url: `https://apps.microsoft.com/search?query=${encodeURIComponent(query.product)}`,
      },
      privileges: 'unknown',
      license: {
        required: 'unknown',
        userAction:
          'Choose the verified product in Microsoft Store and handle account login, entitlement, and installation yourself.',
      },
      reboot: 'unknown',
      dependencies: [],
    });
    return [
      {
        providerId: this.id,
        id: query.product,
        name: query.product,
        publisher: '',
        version: query.version || '',
        architecture: 'any',
        trust: 'official',
        identityVerified: false,
        handoff: true,
        resolvedPlan,
      },
    ];
  }
  async resolve(candidate) {
    return candidate.resolvedPlan;
  }
}

/** Runtime discovery is read-only; factory creation never searches repositories or downloads installers. */
export async function discoverDefaultProviders(options = {}) {
  const registry = options.registry || new ProviderRegistry(options),
    managerAdapters = new Map(),
    diagnostics = [];
  const descriptors = (options.descriptors || []).map(validateProviderDescriptor);
  registry.register(
    new OfflineInstallerProvider({
      entries: options.offlineEntries || [],
      inspect: options.inspect,
    }),
    { trusted: true },
  );
  for (const descriptor of descriptors.filter((item) => item.kind !== 'package-repository'))
    registry.registerDescriptor(descriptor, { approved: true, approvedBy: 'operator' });
  const run = options.run || runSourceProcess;
  let managers = [];
  try {
    managers = await (options.probeManagers || probePackageManagers)({ run });
  } catch (failure) {
    if (failure.name === 'AbortError') throw failure;
    diagnostics.push({
      providerId: 'package-managers',
      status: failure.code || 'MANAGER_DISCOVERY_FAILED',
      message: failure.message,
    });
  }
  for (const manager of managers.slice(0, 4)) {
    if (manager.manager !== 'winget') {
      diagnostics.push({
        providerId: manager.manager,
        status: 'MANAGER_PROTOCOL_UNAVAILABLE',
        message:
          'This package manager was detected. Its executable/install protocol has no validated integrity adapter; use an approved local installer, official repository, or its user interface.',
      });
      continue;
    }
    if (
      manager.signature !== 'Valid' ||
      !/(?:^|,\s*)O=Microsoft Corporation(?:,|$)/i.test(manager.publisher || '')
    ) {
      diagnostics.push({
        providerId: 'winget',
        status: 'MANAGER_SIGNATURE_UNVERIFIED',
        message:
          'The package-manager binary is not independently signed by its expected publisher. It was not executed.',
      });
      continue;
    }
    try {
      const version = await run(manager.path, ['--version'], { timeout: 10_000 });
      if (version.code !== 0 || version.missing || version.timedOut)
        throw error(
          'MANAGER_UNAVAILABLE',
          'The discovered package manager could not report its version.',
        );
      const sourceResult = await run(
        manager.path,
        ['source', 'export', '--disable-interactivity'],
        { timeout: 20_000 },
      );
      if (sourceResult.code !== 0 || sourceResult.timedOut)
        throw error(
          'SOURCE_DISCOVERY_FAILED',
          "The manager's configured repositories could not be exported. No source was assumed.",
        );
      for (const source of parseWingetSources(sourceResult.out)) {
        const authorization = descriptors.find(
          (item) =>
            item.kind === 'package-repository' &&
            item.manager === 'winget' &&
            item.origin.replace(/\/$/, '') === source.Arg.replace(/\/$/, '') &&
            (!item.repository || item.repository === source.Name),
        );
        if (!platformRepository(source) && !authorization) {
          diagnostics.push({
            providerId: `winget:${source.Name}`,
            status: 'SOURCE_APPROVAL_REQUIRED',
            message:
              'A configured repository was found, but its origin and publishers require explicit operator approval before automatic installation.',
          });
          continue;
        }
        const provider = new WingetProvider({
          source,
          executable: manager.path,
          run,
          inspect: options.inspect,
          download: options.download,
          inventory: options.inventory,
          root: options.root,
          approved: !!authorization,
          authorization,
        });
        registry.register(provider, { trusted: true });
        managerAdapters.set(provider.id, provider);
      }
    } catch (failure) {
      if (failure.name === 'AbortError') throw failure;
      diagnostics.push({
        providerId: 'winget',
        status: failure.code || 'MANAGER_DISCOVERY_FAILED',
        message: failure.message,
      });
    }
  }
  registry.register(new StoreHandoffProvider(), { trusted: true });
  return { registry, managerAdapters, diagnostics };
}
