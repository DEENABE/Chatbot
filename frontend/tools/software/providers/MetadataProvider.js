import dns from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';
import { checkCancellation, executionContext } from '../../ExecutionContext.js';
import {
  ARCHITECTURES,
  INSTALLER_FORMATS,
  PROVIDER_ID,
  assertKeys,
  deepFreeze,
  error,
  hostNames,
  normalizeIdentity,
  safeHttpsUrl,
  stringList,
  textValue,
  validateInstallerPlan,
} from '../contracts.js';
import { LocalRepositoryProvider } from './OfflineProvider.js';
import { allowedInstallerAddress } from '../InstallerExecutor.js';

export function validateProviderDescriptor(value) {
  assertKeys(
    value,
    [
      'schemaVersion',
      'id',
      'kind',
      'name',
      'origin',
      'publishers',
      'allowedHosts',
      'signatureThumbprints',
      'metadataUrl',
      'directory',
      'product',
      'architecture',
      'minimumWindowsVersion',
      'maximumWindowsVersion',
      'versionUrlTemplate',
      'approvedBy',
      'approvedAt',
      'networkClass',
      'manager',
      'repository',
      'scope',
    ],
    'descriptor',
  );
  if (
    value.schemaVersion !== 1 ||
    !PROVIDER_ID.test(value.id) ||
    ![
      'json-feed',
      'release-api',
      'local-repository',
      'official-page',
      'package-repository',
    ].includes(value.kind)
  )
    throw error(
      'INVALID_PROVIDER_DESCRIPTOR',
      'Unsupported provider identity, kind, or schema version.',
    );
  const result = {
    ...value,
    name: textValue(value.name, 'provider name'),
    origin: textValue(value.origin, 'provider origin', { max: 2048 }),
    publishers: stringList(value.publishers || [], 'approved publishers'),
  };
  if (result.networkClass && !['public', 'enterprise'].includes(result.networkClass))
    throw error('INVALID_PROVIDER_DESCRIPTOR', 'Invalid source network class.');
  const networkOptions = { enterprise: result.networkClass === 'enterprise' };
  if (result.scope && !['application', 'operating-system'].includes(result.scope))
    throw error('INVALID_PROVIDER_DESCRIPTOR', 'Invalid repository software scope.');
  if (!result.publishers.length)
    throw error('PUBLISHER_NOT_APPROVED', 'A repository needs independently approved publishers.');
  if (result.kind === 'package-repository' && result.manager !== 'winget')
    throw error(
      'UNSUPPORTED_MANAGER_PROTOCOL',
      'This manager requires a separately validated code adapter before its repositories may execute.',
    );
  if (result.kind === 'local-repository') {
    result.directory = textValue(result.directory, 'approved local repository directory', {
      max: 1024,
    });
    if (
      !/^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(result.directory) ||
      /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(result.directory)
    )
      throw error(
        'INVALID_PROVIDER_DESCRIPTOR',
        'A local repository requires an absolute directory without traversal.',
      );
    result.allowedHosts = [];
  } else {
    result.origin = safeHttpsUrl(result.origin, 'approved source origin', networkOptions);
    result.allowedHosts = hostNames(
      result.allowedHosts,
      [new URL(result.origin).hostname],
      networkOptions,
    );
    if (!result.allowedHosts.includes(new URL(result.origin).hostname))
      throw error(
        'INVALID_PROVIDER_DESCRIPTOR',
        'The source origin must be in its approved hosts.',
      );
    if (['json-feed', 'release-api'].includes(result.kind)) {
      result.metadataUrl = safeHttpsUrl(result.metadataUrl, 'metadata URL', networkOptions);
      if (!result.allowedHosts.includes(new URL(result.metadataUrl).hostname))
        throw error(
          'INVALID_PROVIDER_DESCRIPTOR',
          'The metadata URL must be within approved hosts.',
        );
    }
  }
  if (result.architecture && !ARCHITECTURES.includes(result.architecture))
    throw error('INVALID_PROVIDER_DESCRIPTOR', 'Invalid repository architecture.');
  if (result.signatureThumbprints)
    result.signatureThumbprints = stringList(
      result.signatureThumbprints,
      'signature thumbprints',
    ).map((x) => {
      if (!/^[a-f0-9]{40,128}$/i.test(x))
        throw error('INVALID_PROVIDER_DESCRIPTOR', 'Invalid signature thumbprint.');
      return x.toUpperCase();
    });
  if (result.product) {
    assertKeys(
      result.product,
      ['id', 'name', 'publisher', 'edition', 'aliases'],
      'descriptor.product',
    );
    for (const field of ['id', 'name', 'publisher']) textValue(result.product[field], field);
    if (
      !result.publishers.some(
        (p) => normalizeIdentity(p) === normalizeIdentity(result.product.publisher),
      )
    )
      throw error('PUBLISHER_NOT_APPROVED', 'The descriptor product publisher is not approved.');
  }
  if (result.kind === 'release-api' && !result.product)
    throw error(
      'INVALID_PROVIDER_DESCRIPTOR',
      'A release API needs an operator-approved product identity.',
    );
  if (result.versionUrlTemplate) {
    if (
      typeof result.versionUrlTemplate !== 'string' ||
      !result.versionUrlTemplate.includes('{version}') ||
      /\{(?!version\})/.test(result.versionUrlTemplate)
    )
      throw error(
        'INVALID_PROVIDER_DESCRIPTOR',
        'A version URL template may only contain {version}.',
      );
    const test = safeHttpsUrl(
      result.versionUrlTemplate.replaceAll('{version}', '1.0'),
      'version metadata URL',
      networkOptions,
    );
    if (!result.allowedHosts.includes(new URL(test).hostname))
      throw error(
        'INVALID_PROVIDER_DESCRIPTOR',
        'Version metadata must stay within approved hosts.',
      );
  }
  return deepFreeze(structuredClone(result));
}

export function sourceForDescriptor(descriptor, publisher) {
  return {
    providerId: descriptor.id,
    kind:
      descriptor.kind === 'local-repository'
        ? 'local'
        : descriptor.kind === 'official-page'
          ? 'official-page'
          : 'metadata',
    origin: descriptor.origin,
    trust: 'approved',
    publisher,
    allowedHosts: descriptor.allowedHosts || [],
    publisherTrust: {
      publishers: descriptor.publishers,
      ...(descriptor.signatureThumbprints
        ? { signatureThumbprints: descriptor.signatureThumbprints }
        : {}),
    },
    evidence: 'operator-approved',
    name: descriptor.name,
    approvedBy: 'operator',
    networkClass: descriptor.networkClass || 'public',
  };
}

export function providerFromDescriptor(descriptor, options = {}) {
  if (descriptor.kind === 'package-repository')
    throw error(
      'MANAGER_DISCOVERY_REQUIRED',
      'Approve the repository, then rediscover installed managers to bind it to the registered manager executable.',
    );
  if (descriptor.kind === 'local-repository')
    return new LocalRepositoryProvider(descriptor, options);
  if (descriptor.kind === 'official-page') return new OfficialPageProvider(descriptor);
  return new MetadataProvider(descriptor, options);
}

/** Bounded HTTPS JSON with exact host authorization on every redirect and no credential forwarding. */
export async function fetchAuthorizedJson(
  url,
  { descriptor, signal, resolveAuthorization, resolve = dns.lookup } = {},
) {
  const allowedHosts = descriptor.allowedHosts,
    authorization = await resolveAuthorization?.(descriptor.id);
  const initial = new URL(
      safeHttpsUrl(url, 'metadata URL', { enterprise: descriptor.networkClass === 'enterprise' }),
    ),
    controller = AbortSignal.timeout(25_000);
  const taskSignal = signal || executionContext.getStore()?.signal;
  const combined = taskSignal ? AbortSignal.any([taskSignal, controller]) : controller;
  let current = initial;
  for (let hop = 0; hop < 6; hop++) {
    checkCancellation();
    combined.throwIfAborted();
    if (!allowedHosts.includes(current.hostname.toLowerCase()))
      throw error('UNTRUSTED_REDIRECT', 'The metadata redirected outside approved hosts.');
    safeHttpsUrl(current.href, 'metadata redirect', {
      enterprise: descriptor.networkClass === 'enterprise',
    });
    const addresses = await resolve(current.hostname, { all: true });
    if (
      !addresses.length ||
      addresses.some(
        (item) => !allowedInstallerAddress(item.address, descriptor.networkClass || 'public'),
      )
    )
      throw error(
        'UNSAFE_SOURCE',
        'The metadata host resolves outside its approved network policy.',
      );
    const headers = { accept: 'application/json', 'user-agent': 'Chanakya-Software-Discovery/1' };
    if (authorization && current.origin === initial.origin) {
      if (typeof authorization !== 'string' || /[\r\n]/.test(authorization))
        throw error('INVALID_PROVIDER_AUTHORIZATION', 'Invalid provider authorization.');
      headers.authorization = authorization;
    }
    const address = addresses[0];
    const response = await new Promise((yes, no) => {
      const request = https.get(
        current,
        {
          headers,
          signal: combined,
          lookup: (_host, lookupOptions, callback) =>
            lookupOptions.all
              ? callback(null, [address])
              : callback(null, address.address, address.family || net.isIP(address.address)),
        },
        yes,
      );
      request.once('error', no);
    });
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      const location = response.headers.location;
      response.destroy();
      if (!location) throw error('METADATA_FAILED', 'The metadata redirect has no target.');
      current = new URL(location, current);
      continue;
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      response.destroy();
      throw error(
        'METADATA_FAILED',
        `The approved metadata endpoint returned HTTP ${response.statusCode}.`,
      );
    }
    const announced = Number(response.headers['content-length']);
    if (announced > 2_000_000) {
      response.destroy();
      throw error('METADATA_TOO_LARGE', 'The metadata endpoint exceeded its size limit.');
    }
    const chunks = [];
    let total = 0;
    try {
      for await (const value of response) {
        combined.throwIfAborted();
        total += value.length;
        if (total > 2_000_000)
          throw error('METADATA_TOO_LARGE', 'The metadata endpoint exceeded its size limit.');
        chunks.push(Buffer.from(value));
      }
    } finally {
      response.destroy();
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw error('INVALID_METADATA', 'The approved endpoint did not return valid JSON metadata.');
    }
  }
  throw error('UNTRUSTED_REDIRECT', 'The metadata endpoint redirected too many times.');
}

export class MetadataProvider {
  constructor(descriptor, options = {}) {
    this.descriptor = descriptor;
    this.id = descriptor.id;
    this.capabilities = { offline: false, network: true };
    this.options = options;
    this.fetchJson = options.fetchJson || fetchAuthorizedJson;
  }
  async isAvailable() {
    return true;
  }
  async search(query, context = {}) {
    const url =
      query.version && this.descriptor.versionUrlTemplate
        ? this.descriptor.versionUrlTemplate.replaceAll(
            '{version}',
            encodeURIComponent(query.version),
          )
        : this.descriptor.metadataUrl;
    const data = await this.fetchJson(url, {
      ...this.options,
      ...context,
      descriptor: this.descriptor,
    });
    let products;
    if (this.descriptor.kind === 'release-api') products = releaseProducts(data, this.descriptor);
    else {
      assertKeys(data, ['schemaVersion', 'products'], 'feed');
      if (data.schemaVersion !== 1 || !Array.isArray(data.products) || data.products.length > 1000)
        throw error(
          'INVALID_METADATA',
          'A software feed requires schemaVersion 1 and a bounded products list.',
        );
      products = data.products;
    }
    const results = [];
    for (const item of products) {
      assertKeys(
        item,
        [
          'id',
          'name',
          'publisher',
          'version',
          'edition',
          'aliases',
          'architecture',
          'platform',
          'installer',
          'privileges',
          'license',
          'reboot',
          'dependencies',
          'scope',
        ],
        'feed.product',
      );
      if (
        !this.descriptor.publishers.some(
          (p) => normalizeIdentity(p) === normalizeIdentity(item.publisher),
        )
      )
        throw error(
          'PUBLISHER_NOT_APPROVED',
          'The approved feed returned a publisher outside its trust anchors.',
        );
      const scope =
        this.descriptor.scope === 'operating-system' ||
        item.scope === 'operating-system' ||
        item.installer?.format === 'iso'
          ? 'operating-system'
          : query.scope;
      const plan = validateInstallerPlan({
        schemaVersion: 1,
        operation: query.operation,
        protocol: item.installer?.format === 'page' ? 'handoff' : 'download',
        scope,
        product: {
          id: item.id,
          name: item.name,
          publisher: item.publisher,
          version: item.version || '',
          ...(item.edition ? { edition: item.edition } : {}),
          ...(item.aliases ? { aliases: item.aliases } : {}),
        },
        source: sourceForDescriptor(this.descriptor, item.publisher),
        architecture: item.architecture || this.descriptor.architecture || 'any',
        platform: item.platform || {
          os: 'windows',
          ...(this.descriptor.minimumWindowsVersion
            ? { minimumVersion: this.descriptor.minimumWindowsVersion }
            : {}),
          ...(this.descriptor.maximumWindowsVersion
            ? { maximumVersion: this.descriptor.maximumWindowsVersion }
            : {}),
        },
        installer: item.installer,
        privileges: item.privileges || 'unknown',
        license: item.license || { required: 'unknown' },
        reboot: item.reboot || 'unknown',
        dependencies: item.dependencies || [],
      });
      results.push({
        providerId: this.id,
        id: item.id,
        name: item.name,
        publisher: item.publisher,
        version: item.version || '',
        edition: item.edition || '',
        architecture: plan.architecture,
        scope,
        trust: 'approved',
        aliases: item.aliases || [],
        identityVerified: plan.protocol !== 'handoff',
        handoff: plan.protocol === 'handoff',
        resolvedPlan: plan,
      });
    }
    return results.slice(0, 100);
  }
  async resolve(candidate) {
    if (!candidate.resolvedPlan)
      throw error('ONLINE_RESOLUTION_REQUIRED', 'Repeat the approved metadata discovery.');
    return candidate.resolvedPlan;
  }
}

function releaseProducts(data, descriptor) {
  if (
    !data ||
    typeof data !== 'object' ||
    data.draft === true ||
    data.prerelease === true ||
    !Array.isArray(data.assets) ||
    data.assets.length > 200
  )
    throw error(
      'INVALID_METADATA',
      'The release API did not return a stable release with a bounded asset list.',
    );
  const version = textValue(data.tag_name || data.version, 'release version', { max: 80 }).replace(
    /^v(?=\d)/,
    '',
  );
  const products = [];
  for (const asset of data.assets) {
    const name = String(asset.name || ''),
      format = name.split('.').pop().toLowerCase();
    if (
      !INSTALLER_FORMATS.includes(format) ||
      ['manager', 'page'].includes(format) ||
      /(?:linux|macos|darwin|uninstall|debug|symbols|source)/i.test(name)
    )
      continue;
    const architecture = /(?:arm64|aarch64)/i.test(name)
      ? 'arm64'
      : /(?:x64|amd64|win64)/i.test(name)
        ? 'x64'
        : /(?:x86|i[3-6]86|win32)/i.test(name)
          ? 'x86'
          : descriptor.architecture || 'any';
    const digest = /^sha256:([a-f0-9]{64})$/i.exec(String(asset.digest || ''))?.[1];
    products.push({
      ...descriptor.product,
      version,
      architecture,
      installer: {
        format,
        url: asset.browser_download_url || asset.url,
        ...(digest ? { sha256: digest } : {}),
        ...(Number.isSafeInteger(asset.size) && asset.size >= 0 ? { size: asset.size } : {}),
      },
    });
  }
  if (!products.length)
    throw error(
      'NO_COMPATIBLE_RELEASE_ASSET',
      'The approved release has no supported Windows installer asset. Use its official release page.',
    );
  return products;
}

export class OfficialPageProvider {
  constructor(descriptor) {
    this.descriptor = descriptor;
    this.id = descriptor.id;
    this.capabilities = { offline: true, network: false };
  }
  async isAvailable() {
    return true;
  }
  async search(query) {
    const product = this.descriptor.product || {
      id: query.product,
      name: query.product,
      publisher: this.descriptor.publishers[0],
    };
    const plan = validateInstallerPlan({
      schemaVersion: 1,
      operation: query.operation,
      protocol: 'handoff',
      product: { ...product, version: query.version || '' },
      source: sourceForDescriptor(this.descriptor, product.publisher),
      architecture: 'any',
      platform: { os: 'windows' },
      installer: { format: 'page', url: this.descriptor.origin },
      privileges: 'unknown',
      license: {
        required: 'unknown',
        userAction: 'Sign-in, entitlement, and installation remain controlled by the user.',
      },
      reboot: 'unknown',
      dependencies: [],
    });
    return [
      {
        ...product,
        providerId: this.id,
        version: query.version || '',
        architecture: 'any',
        trust: 'approved',
        identityVerified: !!this.descriptor.product,
        handoff: true,
        resolvedPlan: plan,
      },
    ];
  }
  async resolve(candidate) {
    return candidate.resolvedPlan;
  }
}
