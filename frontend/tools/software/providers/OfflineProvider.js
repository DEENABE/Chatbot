import fs from 'node:fs/promises';
import path from 'node:path';
import { checkCancellation } from '../../ExecutionContext.js';
import { ARCHITECTURES, error, normalizeIdentity, validateInstallerPlan } from '../contracts.js';

const formats = new Set(['exe', 'msi', 'msix', 'appx', 'msixbundle', 'appxbundle']);
const formatFor = (file) => path.extname(file).slice(1).toLowerCase();

function localPlan(entry, query, descriptor, metadata) {
  const publisher = metadata?.publisher || entry.publisher;
  if (!publisher)
    throw error('PUBLISHER_NOT_APPROVED', 'The local installer has no verified publisher.');
  if (
    descriptor.publishers?.length &&
    !descriptor.publishers.some((p) => normalizeIdentity(p) === normalizeIdentity(publisher))
  )
    throw error(
      'PUBLISHER_NOT_APPROVED',
      "The local installer's publisher is outside this repository's approved publishers.",
    );
  if (metadata && metadata.status !== 'Valid')
    throw error(
      'UNVERIFIED_INSTALLER',
      'The local installer does not have a valid verified Windows signature.',
    );
  const product = {
    id:
      entry.productId ||
      metadata?.packageIdentity ||
      entry.id ||
      metadata?.productName ||
      entry.name ||
      entry.product,
    name: metadata?.productName || entry.name || entry.product,
    publisher,
    version: metadata?.productVersion || entry.version || '',
    ...(entry.edition ? { edition: entry.edition } : {}),
  };
  const architecture = metadata?.architecture || entry.architecture;
  if (!ARCHITECTURES.includes(architecture))
    throw error(
      'COMPATIBILITY_UNVERIFIED',
      "The local installer's architecture could not be verified.",
    );
  return validateInstallerPlan({
    schemaVersion: 1,
    operation: query.operation,
    protocol: 'local-installer',
    product,
    source: {
      providerId: descriptor.id,
      kind: 'local',
      origin: descriptor.origin,
      trust: descriptor.trust || 'approved',
      publisher,
      allowedHosts: [],
      publisherTrust: {
        publishers: descriptor.publishers?.length ? descriptor.publishers : [publisher],
        ...(descriptor.signatureThumbprints
          ? { signatureThumbprints: descriptor.signatureThumbprints }
          : {}),
      },
      evidence: descriptor.trust === 'local-selection' ? 'native-selection' : 'operator-approved',
      name: descriptor.name,
    },
    architecture,
    platform: {
      os: 'windows',
      ...(metadata?.minimumWindowsVersion || descriptor.minimumWindowsVersion
        ? { minimumVersion: metadata?.minimumWindowsVersion || descriptor.minimumWindowsVersion }
        : {}),
      ...(descriptor.maximumWindowsVersion
        ? { maximumVersion: descriptor.maximumWindowsVersion }
        : {}),
    },
    installer: {
      format: formatFor(entry.path || entry.file),
      path: entry.path || entry.file,
      ...(entry.localId ? { localId: entry.localId } : {}),
      sha256: metadata?.sha256 || entry.sha256,
      size: metadata?.size ?? entry.size,
      ...(metadata?.packageIdentity ? { packageIdentity: metadata.packageIdentity } : {}),
      ...(metadata?.capabilities ? { capabilities: metadata.capabilities } : {}),
    },
    privileges:
      metadata?.privileges ||
      (['requireAdministrator', 'administrator'].includes(metadata?.elevation)
        ? 'administrator'
        : entry.privileges || 'unknown'),
    license: entry.license || { required: 'unknown' },
    reboot: entry.reboot || 'possible',
    dependencies: metadata?.dependencies || entry.dependencies || [],
  });
}

export class OfflineInstallerProvider {
  constructor({ id = 'offline-cache', entries = [], inspect, descriptor } = {}) {
    this.id = id;
    this.entries = entries;
    this.inspect = inspect;
    this.descriptor = descriptor || {
      id,
      kind: 'offline-cache',
      name: 'Approved offline installers',
      origin: 'native-selected installer cache',
      trust: 'local-selection',
      publishers: [],
    };
    this.capabilities = { offline: true, network: false };
  }
  async isAvailable() {
    return true;
  }
  async search(query, { scope, signal } = {}) {
    const entries =
      typeof this.entries === 'function' ? await this.entries({ scope }) : this.entries;
    if (!Array.isArray(entries) || entries.length > 500)
      throw error('INVALID_OFFLINE_CACHE', 'The approved offline cache metadata is invalid.');
    const results = [];
    for (const entry of entries) {
      signal?.throwIfAborted();
      checkCancellation();
      if (entry.owner && entry.owner !== scope) continue;
      if (!entry.file && !entry.path) continue;
      if (!formats.has(formatFor(entry.path || entry.file))) continue;
      const stat = await fs.lstat(entry.path || entry.file).catch(() => null);
      if (!stat?.isFile() || stat.isSymbolicLink()) continue;
      try {
        const metadata = this.inspect
          ? await this.inspect(entry.path || entry.file, formatFor(entry.path || entry.file))
          : entry.metadata;
        if (metadata && entry.sha256 && metadata.sha256 !== entry.sha256)
          throw error(
            'OFFLINE_CACHE_CHANGED',
            'The cached bytes changed since verification. Select or download a fresh installer.',
          );
        if (
          metadata &&
          entry.publisher &&
          normalizeIdentity(metadata.publisher) !== normalizeIdentity(entry.publisher)
        )
          throw error(
            'OFFLINE_CACHE_CHANGED',
            'The cached publisher changed. The file was not admitted.',
          );
        if (!metadata && entry.verified !== true)
          throw error(
            'UNVERIFIED_INSTALLER',
            'The cached installer needs fresh signature and identity inspection.',
          );
        const resolvedPlan = localPlan(entry, query, this.descriptor, metadata);
        results.push({
          providerId: this.id,
          ...resolvedPlan.product,
          architecture: resolvedPlan.architecture,
          trust: resolvedPlan.source.trust,
          aliases: entry.aliases || [],
          identityVerified: true,
          resolvedPlan,
        });
      } catch (failure) {
        if (failure.name === 'AbortError') throw failure;
        // Surface unusable local records as diagnostics, never as installable candidates.
        this.lastFailures ||= [];
        this.lastFailures.push({
          fileName: path.basename(entry.path || entry.file),
          status: failure.code || 'OFFLINE_INSPECTION_FAILED',
          message: failure.message,
        });
      }
    }
    if (!results.length && this.lastFailures?.length) {
      const failure = this.lastFailures.at(-1);
      this.lastFailures = [];
      throw error(failure.status, failure.message);
    }
    this.lastFailures = [];
    return results;
  }
  async resolve(candidate) {
    if (!candidate.resolvedPlan)
      throw error('OFFLINE_RECORD_MISSING', 'Select and verify the offline installer again.');
    return candidate.resolvedPlan;
  }
}

/** Enumerates only one explicitly authorized directory; no model paths or symlink traversal. */
export class LocalRepositoryProvider extends OfflineInstallerProvider {
  constructor(descriptor, options = {}) {
    super({ id: descriptor.id, inspect: options.inspect, descriptor });
    this.entries = async () => {
      // A configured folder grants that exact tree. Reject junctions/symlinks
      // in every ancestor rather than following a substituted parent path.
      const resolved = path.resolve(descriptor.directory);
      let ancestor = path.parse(resolved).root;
      for (const part of resolved.slice(ancestor.length).split(path.sep).filter(Boolean)) {
        ancestor = path.join(ancestor, part);
        if ((await fs.lstat(ancestor)).isSymbolicLink())
          throw error(
            'UNSAFE_LOCAL_REPOSITORY',
            'Approved repository paths cannot pass through a symbolic link or junction.',
          );
      }
      const rootStat = await fs.lstat(descriptor.directory);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
        throw error(
          'UNSAFE_LOCAL_REPOSITORY',
          'The approved local repository is not a regular directory.',
        );
      const realRoot = await fs.realpath(descriptor.directory),
        names = await fs.readdir(realRoot, { withFileTypes: true });
      const entries = [];
      for (const name of names) {
        if (!name.isFile() || name.isSymbolicLink() || !formats.has(formatFor(name.name))) continue;
        const file = path.join(realRoot, name.name),
          actual = await fs.realpath(file);
        if (path.dirname(actual).toLowerCase() !== realRoot.toLowerCase()) continue;
        entries.push({
          file: actual,
          id: actual,
          name: path.basename(name.name, path.extname(name.name)),
        });
        if (entries.length > 100)
          throw error(
            'LOCAL_REPOSITORY_TOO_LARGE',
            'The approved folder has over 100 installers. Select a narrower repository.',
          );
      }
      return entries;
    };
  }
  async isAvailable() {
    return (await fs.stat(this.descriptor.directory).catch(() => null))?.isDirectory() || false;
  }
}
