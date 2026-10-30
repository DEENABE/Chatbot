import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import dns from 'node:dns/promises';
import net from 'node:net';
import https from 'node:https';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import {
  spawn,
  executionContext,
  checkCancellation,
  reportExecutionProgress,
} from '../ExecutionContext.js';
import { powerShellPath } from '../DesktopRuntime.js';
import {
  inspectInstaller,
  installerHash,
  installedSoftwareInventory,
} from './InstallerMetadata.js';
import {
  TrustPolicy,
  normalizePublisher,
  samePublisher,
  sameVersion,
  versionAtLeast,
  softwareFailure,
} from './TrustPolicy.js';

// Full application distributions can exceed 800 MiB. Keep header, stream, and
// local-copy limits consistent while retaining a finite per-installer bound.
const LIMIT = 2 * 1024 * 1024 * 1024;
const PRIVATE_V4 =
  /^(?:0\.|10\.|127\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|192\.0\.(?:0|2)\.|198\.(?:1[89]|51\.100)\.|203\.0\.113\.|2(?:2[4-9]|[3-5]\d)\.)/;
export const privateInstallerAddress = (address) => {
  const a = String(address).toLowerCase();
  if (net.isIPv4(a)) return PRIVATE_V4.test(a);
  if (a.startsWith('::ffff:')) {
    const suffix = a.slice(7);
    if (net.isIPv4(suffix)) return PRIVATE_V4.test(suffix);
    const hex = /^([a-f0-9]{1,4}):([a-f0-9]{1,4})$/.exec(suffix);
    if (hex) {
      const n = parseInt(hex[1], 16) * 65536 + parseInt(hex[2], 16);
      return PRIVATE_V4.test(`${n >>> 24}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`);
    }
  }
  return !net.isIPv6(a) || a === '::' || a === '::1' || /^f[cd]|^fe[89ab]|^ff|^2001:db8:/.test(a);
};
export function allowedInstallerAddress(address, networkClass = 'public') {
  if (!privateInstallerAddress(address)) return true;
  if (networkClass !== 'enterprise') return false;
  const a = String(address).toLowerCase();
  if (net.isIPv4(a)) return /^(?:10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.)/.test(a);
  if (a.startsWith('::ffff:')) {
    const suffix = a.slice(7);
    if (net.isIPv4(suffix)) return allowedInstallerAddress(suffix, networkClass);
    const hex = /^([a-f0-9]{1,4}):([a-f0-9]{1,4})$/.exec(suffix);
    if (hex) {
      const n = parseInt(hex[1], 16) * 65536 + parseInt(hex[2], 16);
      return allowedInstallerAddress(
        `${n >>> 24}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`,
        networkClass,
      );
    }
  }
  return net.isIPv6(a) && /^f[cd]/.test(a);
}

/** TLS validates the named origin, and TCP uses the already checked public address, preventing DNS rebinding. */
export async function downloadTrustedInstaller(
  plan,
  directory,
  { trust = new TrustPolicy(), resolve = dns.lookup, resolveAuthorization } = {},
) {
  trust.assertPlan(plan);
  const signal = AbortSignal.any([
    ...(executionContext.getStore()?.signal ? [executionContext.getStore().signal] : []),
    AbortSignal.timeout(15 * 60000),
  ]);
  let url = trust.assertUrl(plan.installer.url, plan),
    response;
  const initialOrigin = url.origin;
  const authorization = await resolveAuthorization?.(plan.source.providerId);
  if (authorization && (typeof authorization !== 'string' || /[\r\n]/.test(authorization)))
    throw softwareFailure('INVALID_PROVIDER_AUTHORIZATION', 'The provider credential is invalid.');
  for (let n = 0; n <= 5; n++) {
    signal.throwIfAborted();
    if (net.isIP(url.hostname) || !url.hostname.includes('.'))
      throw softwareFailure(
        'UNSAFE_URL',
        'Installer downloads require an approved public DNS origin.',
      );
    const addresses = await resolve(url.hostname, { all: true });
    if (
      !addresses.length ||
      addresses.some((item) => !allowedInstallerAddress(item.address, plan.source.networkClass))
    )
      throw softwareFailure(
        'UNSAFE_URL',
        'The approved origin does not resolve exclusively to addresses allowed by its network policy.',
      );
    const address = addresses[0];
    response = await new Promise((yes, no) => {
      const request = https.get(
        url,
        {
          signal,
          headers: {
            'user-agent': 'ChanakyaAI/1.0',
            accept: 'application/octet-stream,*/*;q=0.8',
            ...(authorization && url.origin === initialOrigin ? { authorization } : {}),
          },
          lookup: (_host, options, callback) =>
            options.all
              ? callback(null, [address])
              : callback(null, address.address, address.family || net.isIP(address.address)),
        },
        yes,
      );
      request.once('error', no);
    });
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      const redirect = response.headers.location;
      response.destroy();
      if (!redirect || n === 5)
        throw softwareFailure(
          'DOWNLOAD_FAILED',
          'The approved source returned invalid or excessive redirects.',
        );
      url = trust.assertUrl(new URL(redirect, url).href, plan);
      continue;
    }
    break;
  }
  if (
    response.statusCode < 200 ||
    response.statusCode >= 300 ||
    /text\/html/i.test(response.headers['content-type'] || '')
  ) {
    response.destroy();
    throw softwareFailure('DOWNLOAD_FAILED', 'The source did not return an installer file.');
  }
  const max = plan.installer.format === 'iso' ? 20 * 1024 * 1024 * 1024 : LIMIT;
  if (Number(response.headers['content-length']) > max) {
    response.destroy();
    throw softwareFailure(
      'DOWNLOAD_TOO_LARGE',
      'The installer exceeds the configured download size limit.',
    );
  }
  await fs.promises.mkdir(directory, { recursive: true });
  const file = path.join(directory, `installer.${plan.installer.format}`),
    hash = crypto.createHash('sha256');
  let size = 0;
  const guard = new Transform({
    transform(chunk, encoding, callback) {
      size += chunk.length;
      if (size > max)
        return callback(
          softwareFailure('DOWNLOAD_TOO_LARGE', 'The installer exceeds the configured size limit.'),
        );
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(response, guard, fs.createWriteStream(file, { flags: 'wx', mode: 0o600 }), {
      signal,
    });
  } catch (error) {
    await fs.promises.rm(file, { force: true });
    throw error;
  }
  return {
    file,
    path: file,
    sha256: hash.digest('hex'),
    size,
    host: url.hostname,
    finalUrl: url.href,
  };
}

// Code-owned launch protocols. Start-Process uses normal Windows ShellExecute/UAC. No model or feed supplies switches.
export const EXECUTION_SCRIPT = String.raw`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$file=$env:CHANAKYA_SOFTWARE_FILE;$format=$env:CHANAKYA_SOFTWARE_FORMAT;$admin=$env:CHANAKYA_SOFTWARE_ADMIN -eq '1'
try{
  if($format -in @('msix','appx','msixbundle','appxbundle')){
    Add-AppxPackage -Path $file -ErrorAction Stop
    [pscustomobject]@{code=0;deployment=$true}|ConvertTo-Json -Compress
  }else{
    $options=@{FilePath=$file;PassThru=$true}
    if($format -eq 'msi'){$options.FilePath=Join-Path $env:SystemRoot 'System32\msiexec.exe';$options.ArgumentList=@('/i',('"'+$file+'"'),'/passive','/norestart')}
    if($admin){$options.Verb='RunAs'}
    $process=Start-Process @options
    [pscustomobject]@{pid=$process.Id;stage='installer-started'}|ConvertTo-Json -Compress
    $process.WaitForExit();$process.Refresh()
    [pscustomobject]@{code=$process.ExitCode}|ConvertTo-Json -Compress
  }
}catch{
  $native=$_.Exception.NativeErrorCode;$code=$_.Exception.HResult
  [pscustomobject]@{code=$(if($native){$native}else{$code});error='Windows declined or could not complete the installation.'}|ConvertTo-Json -Compress
  exit 1
}
`;

export function runValidatedInstaller(plan, { timeout = 20 * 60000 } = {}) {
  if (executionContext.getStore()?.humanApproved !== true)
    return Promise.reject(
      softwareFailure(
        'HUMAN_APPROVAL_REQUIRED',
        'The native installation adapter requires explicit centralized approval.',
      ),
    );
  if (
    !['exe', 'msi', 'msix', 'appx', 'msixbundle', 'appxbundle'].includes(plan.installer?.format) ||
    path
      .extname(plan.installer.path || '')
      .slice(1)
      .toLowerCase() !== plan.installer.format
  )
    return Promise.reject(
      softwareFailure(
        'INSTALLER_FORMAT_MISMATCH',
        'The native adapter only executes the approved declared installer format.',
      ),
    );
  return new Promise((resolve, reject) => {
    let output = '',
      receipt = null,
      installerPid = null,
      timedOut = false,
      finished = false;
    const context = executionContext.getStore(),
      controller = new AbortController();
    const signal = AbortSignal.any([
      ...(context?.signal ? [context.signal] : []),
      controller.signal,
    ]);
    let child;
    try {
      child = executionContext.run({ ...context, signal }, () =>
        spawn(powerShellPath(), ['-NoProfile', '-NonInteractive', '-Command', EXECUTION_SCRIPT], {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            PSModulePath: path.join(path.dirname(powerShellPath()), 'Modules'),
            CHANAKYA_SOFTWARE_FILE: plan.installer.path,
            CHANAKYA_SOFTWARE_FORMAT: plan.installer.format,
            CHANAKYA_SOFTWARE_ADMIN: plan.privileges === 'administrator' ? '1' : '0',
          },
        }),
      );
    } catch (error) {
      return reject(error);
    }
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeout);
    const settle = (value, error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      if (error) reject(error);
      else resolve(value);
    };
    const stop = () => {
      // An elevated or detached installer may survive cancellation. Never represent that as a verified cancellation or installation.
      if (installerPid) {
        try {
          executionContext
            .run({ ...context, signal: undefined }, () =>
              spawn(
                path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
                ['/PID', String(installerPid), '/T', '/F'],
                { windowsHide: true, stdio: 'ignore' },
              ),
            )
            .on('error', () => {});
        } catch {}
      }
      settle({ code: null, timedOut, cancelled: !timedOut, uncertain: true, installerPid });
    };
    signal.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', (chunk) => {
      if (output.length > 1000000) return;
      output += chunk.toString('utf8');
      let newline;
      while ((newline = output.indexOf('\n')) >= 0) {
        const line = output.slice(0, newline).trim();
        output = output.slice(newline + 1);
        try {
          const data = JSON.parse(line);
          if (Number.isSafeInteger(data.pid)) installerPid = data.pid;
          if (Object.hasOwn(data, 'code')) receipt = data;
        } catch {}
      }
    });
    child.stderr.resume();
    child.once('error', (error) => (signal.aborted ? stop() : settle(null, error)));
    child.once('close', (code) => {
      if (signal.aborted) return stop();
      try {
        const data = JSON.parse(output.trim());
        if (Object.hasOwn(data, 'code')) receipt = data;
      } catch {}
      settle(
        receipt
          ? {
              ...receipt,
              code: receipt.code === null ? null : Number(receipt.code) >>> 0,
              timedOut: false,
            }
          : { code: code === null ? null : code >>> 0, uncertain: true, timedOut: false },
      );
    });
  });
}

export class InstallerExecutor {
  constructor({
    root,
    inspect = inspectInstaller,
    download = downloadTrustedInstaller,
    run = runValidatedInstaller,
    inventory = installedSoftwareInventory,
    refresh,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    waits = [0, 2000, 5000],
    managerAdapters = {},
    trust = new TrustPolicy(),
    now = Date.now,
    resolveAuthorization,
  } = {}) {
    this.root =
      root ||
      path.join(
        process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
        'Chanakya',
        'software-installers',
      );
    Object.assign(this, {
      inspect,
      downloadFile: download,
      run,
      inventory,
      refresh,
      sleep,
      waits,
      managerAdapters,
      trust,
      now,
      resolveAuthorization,
    });
  }
  adapter(plan) {
    const value =
      this.managerAdapters instanceof Map
        ? this.managerAdapters.get(plan.installer.manager || plan.source.providerId)
        : this.managerAdapters[plan.installer.manager || plan.source.providerId];
    if (!value)
      throw softwareFailure(
        'INSTALL_PROVIDER_UNAVAILABLE',
        'The trusted package-manager adapter is unavailable. Try another source or its official page.',
      );
    return value;
  }
  async prepare(plan) {
    checkCancellation();
    this.trust.assertPlan(plan);
    if (plan.protocol === 'handoff') return { plan, metadata: null, handoff: true };
    if (plan.protocol === 'package-manager') {
      const adapter = this.adapter(plan);
      if (typeof adapter.prepare !== 'function')
        throw softwareFailure(
          'PACKAGE_IDENTITY_UNVERIFIED',
          'This provider cannot independently refresh the approved package identity.',
        );
      const evidence = await adapter.prepare(plan);
      return { plan, metadata: evidence };
    }
    if (!plan.installer.path) return { plan, metadata: null, downloadRequired: true };
    const metadata = await this.inspect(plan.installer.path, plan.installer.format);
    if (plan.installer.format === 'iso') {
      if (
        plan.protocol !== 'download' ||
        !plan.installer.sha256 ||
        metadata.sha256 !== plan.installer.sha256.toLowerCase()
      )
        throw softwareFailure(
          'HASH_MISMATCH',
          'Operating system media requires an approved published SHA-256 and a download-only plan.',
        );
    } else this.trust.verifyInstaller(plan, metadata);
    if (metadata.inspectionIncomplete && plan.protocol !== 'download')
      throw softwareFailure(
        'PACKAGE_INSPECTION_INCOMPLETE',
        "This bundle's nested dependencies and capabilities could not be independently inspected. Use the official user-assisted deployment path.",
      );
    return { plan, metadata };
  }
  async download(plan) {
    reportExecutionProgress('downloading', `Downloading and checking ${plan.product.name}…`);
    checkCancellation();
    this.trust.assertPlan(plan);
    if (plan.protocol === 'handoff')
      return {
        success: false,
        status: 'USER_ACTION_REQUIRED',
        message: 'Open the verified official page to continue.',
        plan,
      };
    if (plan.protocol === 'package-manager') {
      const adapter = this.adapter(plan);
      if (typeof adapter.download !== 'function')
        throw softwareFailure(
          'PROVIDER_DOWNLOAD_UNSUPPORTED',
          'This package-manager adapter does not expose a separately verifiable download. Installation still requires explicit approval.',
        );
      return adapter.download(plan);
    }
    const directory = path.join(this.root, crypto.randomBytes(16).toString('hex'));
    try {
      let received;
      if (plan.installer.path) {
        const original = await fs.promises.lstat(plan.installer.path);
        if (
          !original.isFile() ||
          original.isSymbolicLink() ||
          original.size > (plan.installer.format === 'iso' ? 20 * 1024 * 1024 * 1024 : LIMIT)
        )
          throw softwareFailure(
            'INVALID_INSTALLER',
            'Choose a regular installer within the configured size limit.',
          );
        await fs.promises.mkdir(directory, { recursive: true });
        const file = path.join(directory, `installer.${plan.installer.format}`);
        await fs.promises.copyFile(plan.installer.path, file, fs.constants.COPYFILE_EXCL);
        received = { file, size: original.size, sha256: await installerHash(file) };
      } else
        received = await this.downloadFile(plan, directory, {
          trust: this.trust,
          resolveAuthorization: this.resolveAuthorization,
        });
      const metadata = await this.inspect(received.file || received.path, plan.installer.format);
      if (plan.installer.sha256 && metadata.sha256 !== plan.installer.sha256.toLowerCase())
        throw softwareFailure(
          'HASH_MISMATCH',
          'The downloaded bytes differ from the approved provider checksum.',
        );
      // Download approval cannot authorize execution. The newly signed metadata forms a new immutable plan for the later installation dialog.
      const verifiedPlan = {
        ...structuredClone(plan),
        dependencies: metadata.dependencies?.length ? metadata.dependencies : plan.dependencies,
        privileges:
          metadata.privileges && metadata.privileges !== 'unknown'
            ? metadata.privileges
            : plan.privileges,
        installer: {
          ...structuredClone(plan.installer),
          capabilities: metadata.capabilities || plan.installer.capabilities || [],
        },
      };
      if (plan.installer.format !== 'iso') this.trust.verifyInstaller(verifiedPlan, metadata);
      const staged = {
        ...verifiedPlan,
        installer: {
          ...verifiedPlan.installer,
          path: received.file || received.path,
          sha256: metadata.sha256,
          size: metadata.size,
          ...(metadata.packageIdentity
            ? { packageIdentity: plan.installer.packageIdentity || metadata.packageIdentity }
            : {}),
        },
      };
      await this.prepare(staged);
      return {
        success: true,
        status: 'DOWNLOADED_VERIFIED',
        plan: staged,
        metadata,
        sha256: metadata.sha256,
        size: metadata.size,
        publisher: metadata.publisher || plan.product.publisher,
        name: plan.product.name,
        message: `Verified ${plan.product.name}; it has not been executed.`,
      };
    } catch (error) {
      await fs.promises
        .rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
        .catch((cleanupError) =>
          console.warn('[software] Private staging cleanup deferred:', cleanupError.code),
        );
      throw error;
    }
  }
  async verify(plan, { before } = {}) {
    reportExecutionProgress('verifying', `Checking the installed version of ${plan.product.name}…`);
    this.trust.assertPlan(plan);
    checkCancellation();
    let entries = [];
    if (plan.protocol === 'package-manager') {
      const adapter = this.adapter(plan);
      if (typeof adapter.inventory !== 'function')
        return {
          status: 'unverified',
          criterion: 'inventory-unavailable',
          observedAt: new Date(this.now()).toISOString(),
        };
      entries = await adapter.inventory(plan);
    } else {
      await this.refresh?.();
      if (typeof this.inventory !== 'function')
        return {
          status: 'unverified',
          criterion: 'inventory-unavailable',
          observedAt: new Date(this.now()).toISOString(),
        };
      entries = await this.inventory(plan);
    }
    if (!Array.isArray(entries)) entries = entries?.entries || entries?.apps || [];
    const normalizeName = (value) =>
      String(value || '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]/gu, '');
    const packageId =
      plan.installer.packageIdentity ||
      plan.product.packageIdentity ||
      (plan.protocol === 'package-manager' ? plan.installer.packageId : null);
    const hit = entries.find(
      (entry) =>
        entry.available !== false &&
        (packageId
          ? String(
              entry.packageId || entry.packageIdentity || entry.packageFamilyName || entry.id || '',
            ).toLowerCase() === String(packageId).toLowerCase()
          : normalizeName(entry.productName || entry.name) === normalizeName(plan.product.name)) &&
        samePublisher(entry.publisher || entry.manufacturer, plan.product.publisher, {
          allowLegalSuffix: plan.protocol === 'package-manager',
        }) &&
        sameVersion(entry.version || entry.productVersion, plan.product.version) &&
        Boolean(entry.version || entry.productVersion || (!plan.product.version && packageId)),
    );
    return {
      status: hit ? 'verified' : 'unverified',
      criterion: plan.protocol === 'package-manager' ? 'provider_inventory' : 'installed_identity',
      observedAt: new Date(this.now()).toISOString(),
      ...(hit
        ? {
            identity: {
              id: hit.packageId || hit.packageIdentity || hit.id,
              name: hit.productName || hit.name,
              publisher: hit.publisher || hit.manufacturer,
              version: hit.version || hit.productVersion,
            },
            alreadyPresent:
              Array.isArray(before) &&
              before.some((value) => JSON.stringify(value) === JSON.stringify(hit)),
          }
        : {}),
    };
  }
  async install(plan) {
    checkCancellation();
    this.trust.assertPlan(plan);
    const context = executionContext.getStore();
    if (context?.humanApproved !== true)
      throw softwareFailure(
        'HUMAN_APPROVAL_REQUIRED',
        'Installation requires explicit approval through the centralized permission gate.',
      );
    if (
      plan.operation === 'download' ||
      ['download', 'handoff'].includes(plan.protocol) ||
      plan.installer.format === 'iso'
    )
      throw softwareFailure(
        'INSTALL_ACTION_NOT_ALLOWED',
        'This plan permits download or user-assisted handoff only.',
      );
    if (
      plan.operation === 'reinstall' &&
      !(
        plan.protocol === 'package-manager' &&
        typeof this.adapter(plan).verifyReinstall === 'function'
      )
    )
      throw softwareFailure(
        'REINSTALL_VERIFICATION_UNSUPPORTED',
        'This provider cannot independently verify reinstall or repair effects. Continue through its official user-assisted installer.',
      );
    const prepared = await this.prepare(plan);
    if (prepared.downloadRequired)
      throw softwareFailure(
        'INSTALLER_STAGING_REQUIRED',
        'Download and verify this installer first, then review its actual publisher and privileges in a new installation approval.',
      );
    // Presence is an independently observed result, not evidence that a new
    // installation happened. Avoid rerunning a matching installed product.
    if (['install', 'update'].includes(plan.operation)) {
      const existing = await this.verify(plan);
      if (existing.status === 'verified')
        return {
          success: true,
          status: 'ALREADY_INSTALLED',
          name: plan.product.name,
          publisher: plan.product.publisher,
          version: plan.product.version,
          verification: existing,
          message:
            'The exact requested product, publisher and version are already installed. No installer was executed.',
        };
    }
    const dependencies = prepared.metadata?.dependencies || plan.dependencies || [];
    if (dependencies.length) {
      await this.refresh?.();
      const observed = await this.inventory(plan),
        items = Array.isArray(observed) ? observed : observed?.entries || observed?.apps || [];
      if (
        !Array.isArray(items) ||
        dependencies.some(
          (dep) =>
            !items.some(
              (known) =>
                String(known.packageIdentity || known.packageId || known.name).toLowerCase() ===
                  String(dep.name || dep.id).toLowerCase() &&
                (!dep.publisher ||
                  normalizePublisher(known.publisher) ===
                    normalizePublisher(
                      dep.publisher.startsWith('CN=')
                        ? /(?:^|,\s*)O=([^,]+)/.exec(dep.publisher)?.[1] ||
                            /(?:^|,\s*)CN=([^,]+)/.exec(dep.publisher)?.[1] ||
                            dep.publisher
                        : dep.publisher,
                    )) &&
                versionAtLeast(known.version, dep.minimumVersion || dep.version),
            ),
        )
      )
        throw softwareFailure(
          'DEPENDENCIES_REQUIRED',
          'A declared package dependency is not independently installed with its required identity, publisher and version. Approve each dependency separately or use the official deployment interface.',
        );
    }
    const started = this.now(),
      adapter = plan.protocol === 'package-manager' ? this.adapter(plan) : null;
    reportExecutionProgress('installing', `Installing ${plan.product.name}…`);
    const r = adapter ? await adapter.execute(plan) : await this.run(plan);
    if (r.uncertain)
      return {
        success: false,
        status: 'EXECUTION_UNCERTAIN',
        exitCode: r.code,
        message:
          'Windows execution may still be active. Check the application inventory before retrying.',
        verification: {
          status: 'unverified',
          criterion: 'execution-uncertain',
          observedAt: new Date(this.now()).toISOString(),
        },
      };
    const cancelled = r.cancelled || [1223, 1602, 0x800704c7].includes(r.code),
      reboot = [3010, 1641, 0x8a150109, 0x8a15010a, 0x8a15010b].includes(r.code);
    let verification = {
      status: 'unverified',
      criterion: 'installer-exit',
      observedAt: new Date(this.now()).toISOString(),
    };
    if (!cancelled && !r.timedOut && (r.code === 0 || reboot))
      for (const wait of this.waits) {
        checkCancellation();
        if (wait) await this.sleep(wait);
        verification = await this.verify(plan);
        if (verification.status === 'verified') break;
      }
    let reinstallVerified = plan.operation !== 'reinstall';
    if (plan.operation === 'reinstall' && verification.status === 'verified')
      reinstallVerified = (await adapter.verifyReinstall(plan, r))?.status === 'verified';
    const success =
      !cancelled &&
      !r.timedOut &&
      !reboot &&
      r.code === 0 &&
      verification.status === 'verified' &&
      reinstallVerified;
    const status = cancelled
      ? 'INSTALL_CANCELLED'
      : r.timedOut
        ? 'INSTALL_TIMEOUT'
        : reboot
          ? 'INSTALL_PENDING_RESTART'
          : success
            ? 'INSTALLED'
            : r.code === 0
              ? 'INSTALL_UNVERIFIED'
              : 'INSTALL_FAILED';
    return {
      success,
      status,
      name: plan.product.name,
      publisher: plan.product.publisher,
      version: plan.product.version,
      exitCode: r.code,
      needsReboot: reboot,
      durationMs: this.now() - started,
      verification,
      message: success
        ? `${plan.product.name} is independently verified as installed.`
        : reboot
          ? 'Windows requires a restart; installation is pending and has not been reported as complete.'
          : cancelled
            ? 'The installation was cancelled.'
            : r.timedOut
              ? 'Installation timed out; inspect the application inventory before retrying.'
              : r.code === 0
                ? 'The installer exited successfully, but the approved product identity and version were not found. Installation is unverified.'
                : `Windows installation failed (exit code ${r.code ?? 'unknown'}).`,
    };
  }
}
