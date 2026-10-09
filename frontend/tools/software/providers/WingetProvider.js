import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseWingetTable, classifyInstall } from '../../services/WingetService.js';
import { checkCancellation } from '../../ExecutionContext.js';
import { downloadTrustedInstaller } from '../InstallerExecutor.js';
import { inspectInstaller } from '../InstallerMetadata.js';
import { TrustPolicy } from '../TrustPolicy.js';
import { error, normalizeIdentity, safeHttpsUrl, validateInstallerPlan } from '../contracts.js';

const PACKAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._+-]{1,127}$/;
const sourceArgs = (name) => [
  '--source',
  name,
  '--accept-source-agreements',
  '--disable-interactivity',
];
const field = (output, name) =>
  String(output || '')
    .match(new RegExp(`^\\s*${name}:\\s*(.+)$`, 'im'))?.[1]
    ?.trim() || '';
const installerFormat = (type, url) => {
  const normalized = type.toLowerCase();
  if (/msixbundle/.test(normalized)) return 'msixbundle';
  if (/appxbundle/.test(normalized)) return 'appxbundle';
  if (/msix/.test(normalized)) return 'msix';
  if (/appx/.test(normalized)) return 'appx';
  if (/msi|wix/.test(normalized)) return 'msi';
  if (/exe|inno|nullsoft|burn|installshield/.test(normalized)) return 'exe';
  const extension = new URL(url).pathname.split('.').pop().toLowerCase();
  return ['exe', 'msi', 'msix', 'appx', 'msixbundle', 'appxbundle'].includes(extension)
    ? extension
    : '';
};

export function parseWingetIdentity(output, expectedId) {
  const found = String(output || '').match(/^Found\s+(.+?)\s+\[([^\]]+)\]/m);
  if (!found || found[2].toLowerCase() !== expectedId.toLowerCase())
    throw error(
      'PACKAGE_IDENTITY_UNAVAILABLE',
      'The manager did not expose the exact requested identity. Its console locale or metadata may be unsupported; use another verified source.',
    );
  const identity = {
    id: found[2],
    name: found[1].trim(),
    publisher: field(output, 'Publisher'),
    version: field(output, 'Version'),
    installerUrl: field(output, 'Installer Url'),
    sha256: field(output, 'Installer SHA256').toLowerCase(),
    installerType: field(output, 'Installer Type'),
    architecture: field(output, 'Architecture').toLowerCase(),
    minimumVersion: field(output, 'Minimum OS Version'),
    scope: field(output, 'Scope').toLowerCase(),
  };
  if (!identity.publisher || !identity.version)
    throw error(
      'PACKAGE_IDENTITY_UNAVAILABLE',
      'The package manager returned no verified publisher or version.',
    );
  identity.edition = field(output, 'Edition');
  identity.dependenciesUnresolved = /^\s*(?:Package )?Dependencies\s*:/im.test(output);
  return identity;
}

/** One instance per discovered authorized repository. Repository names are data, not routing conditions. */
export class WingetProvider {
  constructor({
    source,
    executable,
    run,
    inspect = inspectInstaller,
    download = downloadTrustedInstaller,
    inventory,
    root,
    approved = false,
    authorization,
  }) {
    this.source = source;
    this.executable = executable;
    this.run = run;
    this.inspect = inspect;
    this.downloadFile = download;
    this.installedInventory = inventory;
    this.root =
      root ||
      path.join(
        process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
        'Chanakya',
        'software-manager-verification',
      );
    this.id =
      authorization?.id || `winget:${source.Name.toLowerCase().replace(/[^a-z0-9._-]/g, '-')}`;
    this.authorization = authorization;
    this.capabilities = { offline: false, network: true };
    this.descriptor = {
      id: this.id,
      name: `Windows Package Manager: ${source.Name}`,
      kind: 'package-manager',
      origin: source.Arg,
      trust: approved ? 'approved' : 'official',
      sourceIdentifier: source.Identifier,
    };
  }
  async isAvailable() {
    return !!this.executable;
  }
  async show(id, query) {
    if (!PACKAGE_ID.test(id)) throw error('INVALID_PACKAGE_ID', 'Invalid exact package identity.');
    const args = ['show', '--id', id, '--exact', ...sourceArgs(this.source.Name)];
    if (query.version) args.push('--version', query.version);
    if (query.architecture && query.architecture !== 'auto')
      args.push('--architecture', query.architecture);
    const result = await this.run(this.executable, args, { timeout: 30_000 });
    if (result.missing || result.timedOut || result.code !== 0)
      throw error(
        result.missing
          ? 'MANAGER_UNAVAILABLE'
          : result.timedOut
            ? 'SOURCE_TIMEOUT'
            : 'PACKAGE_LOOKUP_FAILED',
        'The exact package metadata could not be obtained. Try another approved source.',
      );
    return parseWingetIdentity(result.out, id);
  }
  plan(identity, query) {
    if (query.edition && normalizeIdentity(identity.edition) !== normalizeIdentity(query.edition))
      throw error(
        'EDITION_UNVERIFIED',
        'This repository did not independently identify the requested edition. Try an approved edition-specific source or its official interface.',
      );
    if (identity.dependenciesUnresolved)
      throw error(
        'DEPENDENCIES_REVIEW_REQUIRED',
        "This manager's console metadata declares dependencies without independently resolved identities. Use a structured approved deployment source or the official interface.",
      );
    if (!identity.installerUrl || !/^[a-f0-9]{64}$/.test(identity.sha256))
      throw error(
        'PACKAGE_PAYLOAD_UNVERIFIABLE',
        'This repository does not expose a published installer URL and digest. Continue through its official user-assisted interface.',
      );
    const url = safeHttpsUrl(identity.installerUrl, 'package installer URL', {
        enterprise: this.authorization?.networkClass === 'enterprise',
      }),
      payloadFormat = installerFormat(identity.installerType, url);
    if (!payloadFormat)
      throw error(
        'UNSUPPORTED_INSTALLER',
        'The repository installer uses an unsupported deployment protocol.',
      );
    // Winget selects a compatible installer for this machine. A requested arch is passed to show/install.
    const architecture = ['x64', 'x86', 'arm64', 'neutral'].includes(identity.architecture)
      ? identity.architecture === 'neutral'
        ? 'any'
        : identity.architecture
      : query.architecture && query.architecture !== 'auto'
        ? query.architecture
        : process.arch === 'arm64'
          ? 'arm64'
          : process.arch === 'ia32'
            ? 'x86'
            : 'x64';
    if (
      this.authorization &&
      !this.authorization.publishers.some(
        (publisher) => normalizeIdentity(publisher) === normalizeIdentity(identity.publisher),
      )
    )
      throw error(
        'PUBLISHER_NOT_APPROVED',
        'The configured repository returned a publisher outside its operator-approved anchors.',
      );
    return validateInstallerPlan({
      schemaVersion: 1,
      operation: query.operation,
      protocol: 'package-manager',
      product: {
        id: identity.id,
        name: identity.name,
        publisher: identity.publisher,
        version: identity.version,
        ...(query.edition ? { edition: query.edition } : {}),
      },
      source: {
        providerId: this.id,
        kind: 'package-manager',
        origin: this.source.Arg,
        trust: this.descriptor.trust,
        publisher: identity.publisher,
        allowedHosts: this.authorization?.allowedHosts || [new URL(url).hostname],
        publisherTrust: {
          publishers: this.authorization?.publishers || [identity.publisher],
          ...(this.authorization?.signatureThumbprints
            ? { signatureThumbprints: this.authorization.signatureThumbprints }
            : {}),
        },
        evidence: this.authorization ? 'operator-approved' : 'platform-repository',
        repository: this.source.Identifier || this.source.Name,
        name: this.descriptor.name,
        networkClass: this.authorization?.networkClass || 'public',
      },
      architecture,
      platform: {
        os: 'windows',
        ...(identity.minimumVersion ? { minimumVersion: identity.minimumVersion } : {}),
      },
      installer: {
        format: 'manager',
        payloadFormat,
        url,
        sha256: identity.sha256,
        manager: this.id,
        source: this.source.Name,
        packageId: identity.id,
      },
      privileges: identity.scope === 'user' ? 'user' : 'administrator',
      license: { required: 'unknown', description: 'Package and source terms require acceptance.' },
      reboot: 'possible',
      dependencies: [],
    });
  }
  async search(query) {
    checkCancellation();
    if (query.scope === 'operating-system') return [];
    const result = await this.run(
      this.executable,
      ['search', '--query', query.product, ...sourceArgs(this.source.Name), '--count', '15'],
      { timeout: 35_000 },
    );
    if (result.missing || result.timedOut)
      throw error(
        result.missing ? 'MANAGER_UNAVAILABLE' : 'SOURCE_TIMEOUT',
        'This package manager is unavailable or its repository timed out.',
      );
    const rows = parseWingetTable(result.out).slice(0, 8);
    if (result.code !== 0 && !rows.length)
      throw error(
        'SOURCE_SEARCH_FAILED',
        'The repository search failed or requires user authentication. Try another approved source or the Store interface.',
      );
    const candidates = [],
      failures = [];
    for (const row of rows) {
      try {
        const identity = await this.show(row.id, query),
          resolvedPlan = this.plan(identity, query);
        candidates.push({
          providerId: this.id,
          ...resolvedPlan.product,
          architecture: resolvedPlan.architecture,
          aliases: [],
          trust: resolvedPlan.source.trust,
          identityVerified: true,
          resolvedPlan,
        });
      } catch (failure) {
        if (failure.name === 'AbortError') throw failure;
        failures.push(failure);
      }
    }
    if (!candidates.length && failures.length) throw failures[0];
    return candidates;
  }
  async resolve(candidate) {
    if (!candidate.resolvedPlan)
      throw error('ONLINE_RESOLUTION_REQUIRED', 'Repeat an approved manager lookup.');
    return candidate.resolvedPlan;
  }
  async prepare(plan) {
    if (
      plan.source.providerId !== this.id ||
      plan.installer.manager !== this.id ||
      plan.installer.source !== this.source.Name ||
      plan.source.origin !== this.source.Arg ||
      plan.source.repository !== (this.source.Identifier || this.source.Name)
    )
      throw error(
        'PACKAGE_SOURCE_CHANGED',
        'The package source differs from the approved repository.',
      );
    const refreshed = this.plan(
      await this.show(plan.product.id, {
        operation: plan.operation,
        version: plan.product.version,
        architecture: plan.architecture,
        edition: plan.product.edition,
      }),
      { operation: plan.operation, architecture: plan.architecture, edition: plan.product.edition },
    );
    for (const key of ['id', 'name', 'publisher', 'version', 'edition'])
      if (refreshed.product[key] !== plan.product[key])
        throw error(
          'PACKAGE_IDENTITY_CHANGED',
          'The package identity changed after approval. Review a new discovery.',
        );
    for (const key of ['url', 'sha256', 'payloadFormat', 'packageId', 'source'])
      if (refreshed.installer[key] !== plan.installer[key])
        throw error(
          'PACKAGE_PAYLOAD_CHANGED',
          'The published package payload changed after approval. Review a new discovery.',
        );
    return { ...refreshed.product, sha256: refreshed.installer.sha256, source: this.source.Name };
  }
  async download(plan) {
    await this.prepare(plan);
    const payload = {
        ...structuredClone(plan),
        installer: { ...structuredClone(plan.installer), format: plan.installer.payloadFormat },
      },
      trust = new TrustPolicy();
    const directory = path.join(this.root, crypto.randomBytes(16).toString('hex'));
    try {
      const received = await this.downloadFile(payload, directory, { trust });
      const metadata = await this.inspect(received.file || received.path, payload.installer.format);
      trust.verifyInstaller(payload, metadata);
      if (metadata.inspectionIncomplete || metadata.dependencies?.length)
        throw error(
          'PACKAGE_INSPECTION_INCOMPLETE',
          'The package requires independently verified deployment dependencies. Use its official deployment interface.',
        );
      const staged = validateInstallerPlan({
        ...structuredClone(plan),
        privileges:
          metadata.elevation === 'requireAdministrator' ? 'administrator' : plan.privileges,
        installer: {
          ...structuredClone(plan.installer),
          path: received.file || received.path,
          size: metadata.size,
        },
      });
      // A required UAC change cannot be silently added after the approval dialog.
      if (staged.privileges !== plan.privileges)
        throw error(
          'ELEVATION_CHANGED',
          'The verified package requires administrator privileges. Review a new plan showing that requirement.',
        );
      return {
        success: true,
        status: 'DOWNLOADED_VERIFIED',
        plan: staged,
        metadata,
        sha256: metadata.sha256,
        size: metadata.size,
        name: plan.product.name,
        publisher: plan.product.publisher,
        message:
          'The exact repository installer has been downloaded and independently verified; it has not been run.',
      };
    } catch (failure) {
      await fs.rm(directory, { recursive: true, force: true });
      throw failure;
    }
  }
  async execute(plan) {
    await this.prepare(plan);
    if (plan.installer.path) {
      const payload = {
        ...plan,
        installer: { ...plan.installer, format: plan.installer.payloadFormat },
      };
      new TrustPolicy().verifyInstaller(
        payload,
        await this.inspect(plan.installer.path, plan.installer.payloadFormat),
      );
    } else await this.download(plan);
    // Pin the same version and fresh digest before delegating. Winget independently enforces the published hash.
    await this.prepare(plan);
    const verb = plan.operation === 'update' ? 'upgrade' : 'install';
    const args = [
      verb,
      '--id',
      plan.installer.packageId,
      '--exact',
      '--version',
      plan.product.version,
      '--architecture',
      plan.architecture,
      '--interactive',
      ...sourceArgs(this.source.Name),
    ];
    if (plan.operation === 'reinstall') args.push('--force');
    const result = await this.run(this.executable, args, { timeout: 20 * 60_000 });
    const outcome = classifyInstall({ ...result, text: result.out });
    return {
      code: result.code,
      timedOut: !!result.timedOut,
      cancelled: outcome.status === 'INSTALL_CANCELLED',
      uncertain: !!result.missing,
    };
  }
  async inventory(plan) {
    const result = await this.run(
      this.executable,
      [
        'list',
        '--id',
        plan.product.id,
        '--exact',
        '--disable-interactivity',
        '--accept-source-agreements',
      ],
      { timeout: 40_000 },
    );
    if (result.code !== 0 || result.missing || result.timedOut) return [];
    const rows = parseWingetTable(result.out).filter(
      (item) =>
        item.id.toLowerCase() === plan.product.id.toLowerCase() &&
        item.version === plan.product.version,
    );
    if (!rows.length || typeof this.installedInventory !== 'function') return [];
    const installed = await this.installedInventory(plan);
    return rows.flatMap((row) =>
      (Array.isArray(installed) ? installed : installed?.apps || [])
        .filter(
          (entry) =>
            normalizeIdentity(entry.productName || entry.name) ===
              normalizeIdentity(plan.product.name) &&
            normalizeIdentity(entry.publisher || entry.manufacturer) ===
              normalizeIdentity(plan.product.publisher) &&
            entry.version === plan.product.version,
        )
        .map((entry) => ({ ...entry, packageId: row.id })),
    );
  }
}
