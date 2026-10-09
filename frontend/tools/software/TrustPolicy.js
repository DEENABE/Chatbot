import path from 'node:path';
import os from 'node:os';

export const softwareFailure = (code, message) =>
  Object.assign(new Error(message || code), { code });
export const normalizePublisher = (value) => {
  const text = String(value || ''),
    publisher = /(?:^|,\s*)(?:CN|O)=/i.test(text) ? signerPublisher(text) : text;
  return publisher
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
};
export function signerPublisher(subject) {
  const match =
    /(?:^|,\s*)O=(?:"([^"]+)"|((?:\\.|[^,])+))/i.exec(String(subject || '')) ||
    /(?:^|,\s*)CN=(?:"([^"]+)"|((?:\\.|[^,])+))/i.exec(String(subject || ''));
  return (match?.[1] || match?.[2] || '').replace(/\\,/g, ',').trim();
}
export const sameVersion = (actual, expected) => {
  if (!expected || ['latest', 'unknown'].includes(String(expected).toLowerCase())) return true;
  const a = String(actual || '')
      .trim()
      .replace(/^v/i, ''),
    b = String(expected).trim().replace(/^v/i, '');
  return (
    a === b ||
    (/^\d+(?:\.\d+)*$/.test(a) &&
      /^\d+(?:\.\d+)*$/.test(b) &&
      a.replace(/(?:\.0)+$/, '') === b.replace(/(?:\.0)+$/, ''))
  );
};
const compareVersion = (a, b) => {
  const left = String(a).split('.').map(Number),
    right = String(b).split('.').map(Number);
  for (let n = 0; n < Math.max(left.length, right.length); n++) {
    const d = (left[n] || 0) - (right[n] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
};
export const versionAtLeast = (actual, minimum) =>
  Boolean(actual) &&
  (!minimum ||
    (/^\d+(?:\.\d+)*$/.test(String(actual)) &&
      /^\d+(?:\.\d+)*$/.test(String(minimum)) &&
      compareVersion(actual, minimum) >= 0));
const currentArchitecture = () =>
  ({ ia32: 'x86', x64: 'x64', arm64: 'arm64' })[process.arch] || process.arch;
export function compatibleArchitecture(wanted, current = currentArchitecture()) {
  return (
    !wanted ||
    ['any', 'neutral', 'unknown'].includes(wanted) ||
    wanted === current ||
    (wanted === 'x86' && ['x64', 'arm64'].includes(current))
  );
}

/** Trusted code/provider registration supplies origins and publishers; product-name similarity never creates trust. */
export class TrustPolicy {
  constructor({
    architecture = currentArchitecture(),
    windowsVersion = os.release(),
    platform = process.platform,
    platformInterfaces = [
      {
        providerId: 'microsoft-store-handoff',
        origin: 'https://apps.microsoft.com/',
        allowedHosts: ['apps.microsoft.com'],
      },
    ],
  } = {}) {
    this.architecture = architecture;
    this.windowsVersion = windowsVersion;
    this.platform = platform;
    this.platformInterfaces = structuredClone(platformInterfaces);
  }
  assertPlan(plan) {
    if (
      !plan ||
      plan.schemaVersion !== 1 ||
      !plan.product?.name ||
      !plan.source ||
      !plan.installer ||
      !['package-manager', 'local-installer', 'download', 'handoff'].includes(plan.protocol)
    )
      throw softwareFailure('INVALID_INSTALLER_PLAN', 'A validated installation plan is required.');
    if (this.platform !== 'win32' || plan.platform?.os !== 'windows')
      throw softwareFailure('WINDOWS_REQUIRED', 'This installation plan requires Windows.');
    if (
      plan.scope === 'operating-system' ||
      plan.osInstaller ||
      plan.product.type === 'operating-system' ||
      plan.operation === 'os-download' ||
      ['iso', 'page'].includes(plan.installer.format)
    ) {
      if (!['download', 'handoff'].includes(plan.protocol))
        throw softwareFailure(
          'OS_EXECUTION_BLOCKED',
          'Operating system media can be downloaded or handed off only. Upgrade, formatting and boot-media operations need a separate authorized workflow.',
        );
    }
    if (
      Object.keys(plan.installer).some((key) =>
        /^(?:args|arguments|command|script|shell|switches|silentArgs)$/i.test(key),
      )
    )
      throw softwareFailure(
        'UNTRUSTED_EXECUTION_ARGUMENTS',
        'Installer commands and arguments cannot be supplied by a model or metadata feed.',
      );
    const evidence = plan.source.evidence;
    const officialInterface =
      evidence === 'platform-interface' &&
      plan.protocol === 'handoff' &&
      plan.source.kind === 'official-page' &&
      this.platformInterfaces.some(
        (item) =>
          item.providerId === plan.source.providerId &&
          item.origin === plan.source.origin &&
          JSON.stringify(item.allowedHosts.slice().sort()) ===
            JSON.stringify((plan.source.allowedHosts || []).slice().sort()),
      );
    if (
      !['operator-approved', 'platform-repository', 'native-selection'].includes(evidence) &&
      !officialInterface
    )
      throw softwareFailure(
        'SOURCE_NOT_APPROVED',
        'The distribution source has not been independently verified or approved.',
      );
    if (
      evidence === 'platform-repository' &&
      !['package-manager', 'handoff'].includes(plan.protocol)
    )
      throw softwareFailure(
        'SOURCE_NOT_APPROVED',
        'Repository evidence only authorizes its registered package-manager adapter or official handoff page.',
      );
    if (plan.source.networkClass === 'enterprise' && evidence !== 'operator-approved')
      throw softwareFailure(
        'SOURCE_NOT_APPROVED',
        'Internal network access requires an explicitly approved enterprise source.',
      );
    if (plan.protocol === 'handoff') {
      if (plan.installer.format !== 'page' || !plan.installer.url)
        throw softwareFailure(
          'INVALID_INSTALLER_PLAN',
          'A handoff requires a verified official page.',
        );
      this.assertUrl(plan.installer.url, plan);
      return plan;
    }
    if (!plan.product.publisher || !normalizePublisher(plan.product.publisher))
      throw softwareFailure('PUBLISHER_UNVERIFIED', 'The expected software publisher is unknown.');
    if (!plan.product.version || /^(?:latest|unknown|any)$/i.test(plan.product.version))
      throw softwareFailure(
        'VERSION_UNVERIFIED',
        'Resolve a concrete signed or repository-pinned version before download or installation.',
      );
    const publishers =
      plan.source.publisherTrust?.publishers ||
      (plan.source.publisher ? [plan.source.publisher] : []);
    if (
      evidence !== 'platform-repository' &&
      !publishers.some(
        (publisher) => normalizePublisher(publisher) === normalizePublisher(plan.product.publisher),
      )
    )
      throw softwareFailure(
        'PUBLISHER_UNVERIFIED',
        "The product publisher is outside this source's approved publisher policy.",
      );
    if (plan.installer.url) this.assertUrl(plan.installer.url, plan);
    if (!compatibleArchitecture(plan.architecture, this.architecture))
      throw softwareFailure(
        'ARCHITECTURE_MISMATCH',
        `This package targets ${plan.architecture}, while Windows uses ${this.architecture}.`,
      );
    const minimum = plan.platform?.minimumVersion || plan.platform?.minVersion,
      maximum = plan.platform?.maximumVersion || plan.platform?.maxVersion;
    if (
      (minimum && compareVersion(this.windowsVersion, minimum) < 0) ||
      (maximum && compareVersion(this.windowsVersion, maximum) > 0)
    )
      throw softwareFailure(
        'WINDOWS_VERSION_MISMATCH',
        'This package does not support the installed Windows version.',
      );
    return plan;
  }
  assertUrl(raw, plan) {
    let url;
    try {
      url = new URL(raw);
    } catch {
      throw softwareFailure('UNSAFE_URL', 'The provider returned an invalid distribution URL.');
    }
    const hosts = plan.source.allowedHosts || [];
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      (url.port && url.port !== '443') ||
      !hosts.some((host) => String(host).toLowerCase() === url.hostname.toLowerCase())
    )
      throw softwareFailure(
        'UNAPPROVED_ORIGIN',
        'The download or redirect host is outside the explicitly approved distribution origins.',
      );
    return url;
  }
  verifyInstaller(plan, metadata) {
    this.assertPlan(plan);
    if (!metadata || metadata.format !== plan.installer.format)
      throw softwareFailure(
        'INSTALLER_FORMAT_MISMATCH',
        'The installer format does not match the approved plan.',
      );
    if (
      plan.installer.sha256 &&
      metadata.sha256?.toLowerCase() !== plan.installer.sha256.toLowerCase()
    )
      throw softwareFailure(
        'HASH_MISMATCH',
        "The installer differs from the provider's published checksum.",
      );
    if (metadata.status !== 'Valid')
      throw softwareFailure(
        'SIGNATURE_INVALID',
        'The installer does not have a valid Windows signature. It was not executed.',
      );
    const actualPublisher =
      metadata.publisher || signerPublisher(metadata.signerSubject || metadata.signer);
    if (normalizePublisher(actualPublisher) !== normalizePublisher(plan.product.publisher))
      throw softwareFailure(
        'PUBLISHER_MISMATCH',
        `The installer signer does not match the expected publisher ${plan.product.publisher}.`,
      );
    const pins =
      plan.source.publisherTrust?.signatureThumbprints || plan.source.signatureThumbprints || [];
    if (
      pins.length &&
      !pins.some(
        (pin) =>
          String(pin).replace(/\s/g, '').toUpperCase() ===
          String(metadata.signerThumbprint || '')
            .replace(/\s/g, '')
            .toUpperCase(),
      )
    )
      throw softwareFailure(
        'SIGNER_MISMATCH',
        'The installer certificate does not match this approved source.',
      );
    if (!metadata.productName && !metadata.packageIdentity)
      throw softwareFailure(
        'PACKAGE_IDENTITY_UNVERIFIED',
        'The signed file does not expose an independently verifiable product identity.',
      );
    const expectedIdentity = plan.installer.packageIdentity || plan.product.packageIdentity;
    if (expectedIdentity && metadata.packageIdentity !== expectedIdentity)
      throw softwareFailure(
        'PACKAGE_IDENTITY_MISMATCH',
        'The signed package identity differs from the approved product.',
      );
    const name = String(metadata.productName || metadata.packageIdentity)
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]/gu, '');
    const expectedName = plan.product.name
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]/gu, '');
    if ((!expectedIdentity || ['exe', 'msi'].includes(metadata.format)) && name !== expectedName)
      throw softwareFailure(
        'PACKAGE_IDENTITY_MISMATCH',
        "The signed installer's product name differs from the approved software identity.",
      );
    if (!sameVersion(metadata.productVersion, plan.product.version))
      throw softwareFailure(
        'VERSION_MISMATCH',
        'The signed installer version differs from the approved version.',
      );
    if (
      !metadata.architecture ||
      !['x86', 'x64', 'arm64', 'neutral', 'any'].includes(metadata.architecture)
    )
      throw softwareFailure(
        'ARCHITECTURE_UNVERIFIED',
        'The signed installer does not expose a supported verifiable architecture. Use its official user-assisted interface.',
      );
    if (
      !compatibleArchitecture(metadata.architecture, this.architecture) ||
      (plan.architecture &&
        !['any', 'unknown', 'neutral'].includes(plan.architecture) &&
        metadata.architecture &&
        !['any', 'unknown', 'neutral', plan.architecture].includes(metadata.architecture))
    )
      throw softwareFailure(
        'ARCHITECTURE_MISMATCH',
        'The installer architecture does not match the approved compatible plan.',
      );
    if (
      metadata.minimumWindowsVersion &&
      compareVersion(this.windowsVersion, metadata.minimumWindowsVersion) < 0
    )
      throw softwareFailure(
        'WINDOWS_VERSION_MISMATCH',
        'The package manifest requires a newer Windows version.',
      );
    if (
      ['requireAdministrator', 'administrator'].includes(metadata.elevation) &&
      plan.privileges !== 'administrator'
    )
      throw softwareFailure(
        'ELEVATION_CHANGED',
        'This installer requires administrator privileges. Review a new plan showing this requirement.',
      );
    const approvedCapabilities = new Set(plan.installer.capabilities || []);
    if ((metadata.restrictedCapabilities || []).some((value) => !approvedCapabilities.has(value)))
      throw softwareFailure(
        'PACKAGE_CAPABILITY_APPROVAL_REQUIRED',
        'The package requests restricted capabilities that are not in the approved plan.',
      );
    return { ...metadata, publisher: actualPublisher };
  }
}
