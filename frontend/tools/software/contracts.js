import crypto from 'node:crypto';

/**
 * @typedef {Object} SoftwareSourceProvider
 * @property {string} id
 * @property {{offline:boolean,network:boolean}} capabilities
 * @property {Object} descriptor Backend-authorized source identity; never model text.
 * @property {() => Promise<boolean>} isAvailable
 * @property {(query:SoftwareQuery) => Promise<SoftwareCandidate[]>} search
 * @property {(candidate:SoftwareCandidate) => Promise<InstallerPlan>} resolve
 *
 * @typedef {{operation:'install'|'download'|'update'|'reinstall',product:string,version?:string,edition?:string,architecture?:'auto'|'x64'|'x86'|'arm64',scope?:'application'|'operating-system',sourceProviderId?:string,publisher?:string,language?:string}} SoftwareQuery
 * @typedef {{providerId:string,id:string,name:string,publisher:string,version:string,architecture:string,trust:string,aliases?:string[],query?:SoftwareQuery}} SoftwareCandidate
 * @typedef {{schemaVersion:1,operation:string,protocol:string,product:Object,source:Object,architecture:string,platform:Object,installer:Object,privileges:string,license:Object,reboot:string,dependencies:Object[]}} InstallerPlan
 */

export const PROVIDER_ID = /^[a-z0-9][a-z0-9._:-]{0,95}$/i;
export const INSTALLER_FORMATS = [
  'exe',
  'msi',
  'msix',
  'appx',
  'msixbundle',
  'appxbundle',
  'iso',
  'manager',
  'page',
];
export const OPERATIONS = ['install', 'download', 'update', 'reinstall'];
export const ARCHITECTURES = ['x64', 'x86', 'arm64', 'any'];
export const error = (code, message) => Object.assign(new Error(message), { code });
const BAD_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export function plainObject(value, label = 'value') {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw error('INVALID_SOFTWARE_DATA', `${label} must be a plain object.`);
  return value;
}

export function assertKeys(value, allowed, label) {
  plainObject(value, label);
  for (const key of Object.keys(value))
    if (BAD_KEYS.has(key) || !allowed.includes(key))
      throw error('INVALID_SOFTWARE_DATA', `${label}.${key} is not supported.`);
}

export function textValue(value, label, { optional = false, max = 240 } = {}) {
  if (optional && (value === undefined || value === null || value === '')) return '';
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    throw error(
      'INVALID_SOFTWARE_DATA',
      `${label} must be nonempty text of at most ${max} characters.`,
    );
  return value.trim();
}

export function safeHttpsUrl(value, label = 'source URL', { enterprise = false } = {}) {
  let url;
  try {
    url = new URL(textValue(value, label, { max: 2048 }));
  } catch {
    throw error('UNSAFE_SOURCE', `${label} must be an HTTPS URL.`);
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443') ||
    (!enterprise && !url.hostname.includes('.')) ||
    /^(?:localhost|\[|\d+\.)/i.test(url.hostname) ||
    /\.onion$/i.test(url.hostname) ||
    (!enterprise && /\.(?:local|lan|internal)$/i.test(url.hostname))
  )
    throw error('UNSAFE_SOURCE', `${label} must use HTTPS on an authorized public hostname.`);
  url.hash = '';
  return url.href;
}

export function hostNames(value, fallback = [], options = {}) {
  const names = value ?? fallback;
  if (!Array.isArray(names) || names.length > 32)
    throw error('INVALID_SOFTWARE_DATA', 'Allowed hosts must be a bounded hostname list.');
  return [
    ...new Set(
      names.map((host) => {
        const name = textValue(host, 'allowed host', { max: 253 }).toLowerCase();
        if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name))
          throw error(
            'UNSAFE_SOURCE',
            'Allowed hosts must be exact hostnames; wildcards are forbidden.',
          );
        safeHttpsUrl(`https://${name}/`, 'allowed host', options);
        return name;
      }),
    ),
  ];
}

export function sanitizeSoftwareQuery(value) {
  assertKeys(
    value,
    [
      'operation',
      'product',
      'version',
      'edition',
      'architecture',
      'scope',
      'sourceProviderId',
      'source',
      'publisher',
      'language',
    ],
    'query',
  );
  const operation = value.operation || 'install',
    architecture = value.architecture || 'auto',
    scope = value.scope || 'application';
  if (
    !OPERATIONS.includes(operation) ||
    !['auto', ...ARCHITECTURES.filter((x) => x !== 'any')].includes(architecture) ||
    !['application', 'operating-system'].includes(scope)
  )
    throw error(
      'INVALID_SOFTWARE_QUERY',
      'Unsupported operation, architecture, or software scope.',
    );
  const result = {
    operation,
    product: textValue(value.product, 'product', { max: 180 }),
    architecture,
    scope,
  };
  if (
    /^(?:https?:|file:|[a-z]:[\\/]|\\\\)|(?:^|\s)(?:powershell(?:\.exe)?\s+-|cmd(?:\.exe)?\s*\/c|invoke-expression\s|iex\s|curl\s+https?:|wget\s+https?:)/i.test(
      result.product,
    )
  )
    throw error(
      'INVALID_SOFTWARE_QUERY',
      'Provide a software product identity, not a URL, path, or command.',
    );
  for (const key of ['version', 'edition', 'publisher', 'language'])
    if (value[key]) result[key] = textValue(value[key], key, { max: key === 'version' ? 80 : 180 });
  const source = value.sourceProviderId || value.source;
  if (source) {
    if (!PROVIDER_ID.test(source))
      throw error('INVALID_SOFTWARE_QUERY', 'Invalid provider identity.');
    result.sourceProviderId = source;
  }
  return result;
}

export function validateInstallerPlan(value) {
  assertKeys(
    value,
    [
      'schemaVersion',
      'id',
      'planId',
      'operation',
      'protocol',
      'product',
      'source',
      'architecture',
      'platform',
      'installer',
      'privileges',
      'license',
      'reboot',
      'dependencies',
      'scope',
    ],
    'plan',
  );
  if (
    value.schemaVersion !== 1 ||
    !OPERATIONS.includes(value.operation) ||
    !['package-manager', 'local-installer', 'download', 'handoff'].includes(value.protocol)
  )
    throw error('INVALID_INSTALLER_PLAN', 'Unsupported installer plan version or protocol.');
  const handoff = value.protocol === 'handoff';
  assertKeys(
    value.product,
    ['id', 'name', 'publisher', 'version', 'edition', 'aliases'],
    'product',
  );
  const product = {
    id: textValue(value.product.id, 'product identity', { max: 180 }),
    name: textValue(value.product.name, 'product name', { max: 180 }),
    publisher: textValue(value.product.publisher, 'publisher', { optional: handoff }),
    version: textValue(value.product.version, 'version', { optional: handoff, max: 80 }),
  };
  if (value.product.edition)
    product.edition = textValue(value.product.edition, 'edition', { max: 180 });
  if (value.product.aliases) product.aliases = stringList(value.product.aliases, 'aliases', 30);
  assertKeys(
    value.source,
    [
      'providerId',
      'kind',
      'origin',
      'trust',
      'publisher',
      'allowedHosts',
      'publisherTrust',
      'evidence',
      'name',
      'metadataUrl',
      'approvedBy',
      'repository',
      'networkClass',
    ],
    'source',
  );
  if (
    !PROVIDER_ID.test(value.source.providerId) ||
    !['approved', 'official', 'local-selection'].includes(value.source.trust)
  )
    throw error('UNTRUSTED_SOURCE', 'The provider does not have a trusted source identity.');
  const publisherTrust = value.source.publisherTrust || {
    publishers: value.source.publisher ? [value.source.publisher] : [],
  };
  assertKeys(publisherTrust, ['publishers', 'signatureThumbprints'], 'publisherTrust');
  const source = {
    ...value.source,
    origin: textValue(value.source.origin, 'source origin', { max: 2048 }),
    publisher: textValue(value.source.publisher, 'source publisher', { optional: handoff }),
    allowedHosts: hostNames(value.source.allowedHosts, [], {
      enterprise: value.source.networkClass === 'enterprise',
    }),
    publisherTrust: {
      publishers: stringList(publisherTrust.publishers || [], 'publishers', 30),
      ...(publisherTrust.signatureThumbprints
        ? {
            signatureThumbprints: stringList(
              publisherTrust.signatureThumbprints,
              'signature thumbprints',
              20,
            ).map((x) => {
              if (!/^[a-f0-9]{40,128}$/i.test(x))
                throw error('INVALID_SOFTWARE_DATA', 'Invalid signature thumbprint.');
              return x.toUpperCase();
            }),
          }
        : {}),
    },
  };
  if (source.networkClass && !['public', 'enterprise'].includes(source.networkClass))
    throw error('INVALID_INSTALLER_PLAN', 'Invalid source network class.');
  if (source.networkClass === 'enterprise' && source.evidence !== 'operator-approved')
    throw error('UNTRUSTED_SOURCE', 'Enterprise networking requires an operator-approved source.');
  if (
    !handoff &&
    (!source.publisherTrust.publishers.length ||
      !source.publisherTrust.publishers.some(
        (p) => normalizeIdentity(p) === normalizeIdentity(product.publisher),
      ))
  )
    throw error(
      'PUBLISHER_NOT_APPROVED',
      'The product publisher is not authorized by this source.',
    );
  if (!ARCHITECTURES.includes(value.architecture))
    throw error('INCOMPATIBLE_ARCHITECTURE', 'A verified installer architecture is required.');
  assertKeys(
    value.platform || { os: 'windows' },
    ['os', 'minimumVersion', 'maximumVersion'],
    'platform',
  );
  const platform = { ...(value.platform || { os: 'windows' }) };
  if (platform.os !== 'windows')
    throw error('INCOMPATIBLE_PLATFORM', 'This installer does not target Windows.');
  for (const key of ['minimumVersion', 'maximumVersion'])
    if (platform[key]) platform[key] = textValue(platform[key], key, { max: 80 });
  assertKeys(
    value.installer,
    [
      'format',
      'payloadFormat',
      'url',
      'path',
      'localId',
      'sha256',
      'size',
      'manager',
      'source',
      'packageId',
      'scope',
      'signaturePublisher',
      'signatureThumbprints',
      'capabilities',
      'packageIdentity',
      'minimumWindowsVersion',
      'maximumWindowsVersion',
      'architecture',
      'elevation',
      'dependencies',
    ],
    'installer',
  );
  const installer = { ...value.installer };
  if (!INSTALLER_FORMATS.includes(installer.format))
    throw error('UNSUPPORTED_INSTALLER', 'Unsupported installer format.');
  if (
    installer.payloadFormat &&
    (!INSTALLER_FORMATS.includes(installer.payloadFormat) ||
      ['manager', 'page'].includes(installer.payloadFormat))
  )
    throw error('UNSUPPORTED_INSTALLER', 'Unsupported package-manager payload format.');
  if (installer.url) {
    installer.url = safeHttpsUrl(installer.url, 'installer URL', {
      enterprise: source.networkClass === 'enterprise',
    });
    if (!source.allowedHosts.includes(new URL(installer.url).hostname.toLowerCase()))
      throw error('UNTRUSTED_SOURCE', 'The installer hostname is outside the approved source.');
  }
  if (installer.sha256 && !/^[a-f0-9]{64}$/i.test(installer.sha256))
    throw error('INVALID_INSTALLER_PLAN', 'Invalid SHA-256 checksum.');
  if (installer.sha256) installer.sha256 = installer.sha256.toLowerCase();
  if (installer.size !== undefined && (!Number.isSafeInteger(installer.size) || installer.size < 0))
    throw error('INVALID_INSTALLER_PLAN', 'Invalid installer size.');
  for (const key of [
    'path',
    'localId',
    'manager',
    'source',
    'packageId',
    'scope',
    'signaturePublisher',
    'packageIdentity',
  ])
    if (installer[key])
      installer[key] = textValue(installer[key], key, { max: key === 'path' ? 1024 : 180 });
  if (
    value.protocol === 'package-manager' &&
    (!installer.manager ||
      !installer.source ||
      !installer.packageId ||
      installer.format !== 'manager')
  )
    throw error(
      'INVALID_INSTALLER_PLAN',
      'A package manager plan needs a manager, repository, and exact package identity.',
    );
  if (value.protocol === 'local-installer' && !installer.path && !installer.localId)
    throw error('INVALID_INSTALLER_PLAN', 'The verified local installer is missing.');
  if (value.protocol === 'download' && !installer.url)
    throw error('INVALID_INSTALLER_PLAN', 'The approved download URL is missing.');
  if (value.protocol === 'handoff' && installer.format !== 'page')
    throw error('INVALID_INSTALLER_PLAN', 'A handoff must identify an authorized page.');
  if (installer.localId && installer.url)
    throw error(
      'INVALID_INSTALLER_PLAN',
      'A local installer handle cannot replace remote provenance.',
    );
  if (installer.path && installer.url && !installer.sha256)
    throw error(
      'INVALID_INSTALLER_PLAN',
      'A staged remote installer needs its verified SHA-256 digest.',
    );
  const privileges = value.privileges || 'unknown',
    reboot = value.reboot || 'unknown';
  if (
    !['user', 'administrator', 'unknown'].includes(privileges) ||
    !['none', 'possible', 'required', 'unknown'].includes(reboot)
  )
    throw error('INVALID_INSTALLER_PLAN', 'Invalid privilege or reboot metadata.');
  const license = value.license || { required: 'unknown' };
  assertKeys(license, ['required', 'description', 'url', 'paid', 'userAction'], 'license');
  if (![true, false, 'unknown'].includes(license.required))
    throw error('INVALID_INSTALLER_PLAN', 'Invalid license metadata.');
  if (license.url) safeHttpsUrl(license.url, 'license URL');
  const dependencies = value.dependencies || [];
  if (!Array.isArray(dependencies) || dependencies.length > 50)
    throw error('INVALID_INSTALLER_PLAN', 'Invalid dependency metadata.');
  for (const dependency of dependencies) {
    assertKeys(
      dependency,
      ['id', 'name', 'publisher', 'version', 'minimumVersion', 'architecture', 'required'],
      'dependency',
    );
    textValue(dependency.id || dependency.name, 'dependency identity');
  }
  return deepFreeze(
    structuredClone({
      ...value,
      product,
      source,
      platform,
      installer,
      privileges,
      reboot,
      license,
      dependencies,
    }),
  );
}

export function stringList(value, label, max = 30) {
  if (!Array.isArray(value) || value.length > max)
    throw error('INVALID_SOFTWARE_DATA', `${label} must be a bounded text list.`);
  return value.map((x) => textValue(x, label));
}
export function normalizeIdentity(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
export function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
const stable = (value) =>
  Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, stable(value[key])]),
        )
      : value;
export function planDigest(plan) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(stable(validateInstallerPlan(plan))))
    .digest('hex');
}
