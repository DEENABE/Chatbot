import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BaseToolService } from '../BaseToolService.js';
import {
  executionContext,
  checkCancellation,
  reportExecutionProgress,
} from '../ExecutionContext.js';
import { SoftwarePlanStore, softwareOwner } from '../software/SoftwarePlanStore.js';
import { SoftwareResolver } from '../software/SoftwareResolver.js';
import {
  sanitizeSoftwareQuery,
  validateInstallerPlan,
  planDigest,
  error,
} from '../software/contracts.js';
import { validateProviderDescriptor } from '../software/providers/MetadataProvider.js';
import { discoverDefaultProviders } from '../software/providers/discoverDefaultProviders.js';
import { InstallerExecutor } from '../software/InstallerExecutor.js';
import { inspectInstaller } from '../software/InstallerMetadata.js';
import { TrustPolicy, normalizePublisher } from '../software/TrustPolicy.js';
import { downloadTrustedInstaller } from '../software/InstallerExecutor.js';
import { installedSoftwareInventory } from '../software/InstalledSoftwareInventory.js';

const handleSchema = { type: 'string', required: true, pattern: '^[a-f0-9-]{36}$' };
const scope = () => executionContext.getStore()?.scope;
const fields = (plan) => ({
  planId: plan.planId,
  name: plan.product.name,
  publisher: plan.product.publisher,
  version: plan.product.version,
  edition: plan.product.edition || 'Not specified',
  operation: plan.operation,
  protocol: plan.protocol,
  architecture: plan.architecture,
  source: plan.source.origin,
  providerId: plan.source.providerId,
  format: plan.installer.format,
  size: plan.installer.size || null,
  sha256: plan.installer.sha256 || null,
  privileges: plan.privileges,
  license: plan.license,
  reboot: plan.reboot,
  dependencies: plan.dependencies,
  scope: plan.scope || 'application',
});
const publicCandidate = (candidate, id) => ({
  candidateId: id,
  name: candidate.name,
  publisher: candidate.publisher,
  version: candidate.version,
  edition: candidate.edition || '',
  architecture: candidate.architecture,
  providerId: candidate.providerId,
  source: candidate.resolvedPlan?.source?.origin || 'Registered source',
  trust: candidate.trust,
  handoff: !!candidate.handoff,
});
const truthful = (value) =>
  value?.needsConfirmation
    ? value
    : value?.data?.success === false
      ? {
          ...value,
          success: false,
          error: {
            code: value.data.status || 'SOFTWARE_OPERATION_FAILED',
            message: value.data.message || 'The software operation was not verified.',
          },
        }
      : value;

/** One application-independent facade. Model calls contain requirements/owned IDs; providers and permissions own execution. */
export class SoftwareService extends BaseToolService {
  constructor(
    gate,
    {
      directory,
      key,
      appService,
      inspect = inspectInstaller,
      providerFactory = discoverDefaultProviders,
      executorFactory,
      inventory = installedSoftwareInventory,
      run,
      now = Date.now,
    } = {},
  ) {
    super('software', gate);
    Object.assign(this, {
      directory,
      appService,
      inspect,
      providerFactory,
      executorFactory,
      inventory,
      run,
      now,
    });
    this.store =
      directory && key
        ? new SoftwarePlanStore({ directory: path.join(directory, 'records'), key, now })
        : null;
    this.resolver = new SoftwareResolver();
    this.trust = new TrustPolicy();
    this.environments = new Map();
    this.installActive = false;
    this.activeDownloads = 0;
  }
  get actions() {
    return {
      providers: {
        handler: () => this.providers(),
        schema: {},
        destructive: false,
        description:
          'Read actual available software providers and approved offline sources. Does not access online catalogs.',
      },
      discover: {
        handler: ({ query }) => this.discover(query, false),
        schema: { query: { type: 'object', required: true } },
        destructive: false,
        description:
          'Find matching software in approved offline repositories/cache using typed product requirements.',
      },
      discoverOnline: {
        handler: ({ query }) => this.discover(query, true),
        schema: { query: { type: 'object', required: true } },
        destructive: true,
        description:
          'Search available approved online providers for product identity and verifiable installation methods. Needs internet approval.',
      },
      resolve: {
        handler: ({ candidateId }) => this.resolve(candidateId),
        schema: { candidateId: handleSchema },
        destructive: false,
        description:
          'Resolve an owned selected candidate into a typed immutable installation plan. No new online lookup.',
      },
      download: {
        handler: ({ planId }) => this.perform('download', planId),
        schema: { planId: handleSchema },
        destructive: true,
        description:
          'Download/copy and verify only the exact product and distribution source in an owned plan. Never executes it.',
      },
      install: {
        handler: ({ planId }) => this.perform('install', planId),
        schema: { planId: handleSchema },
        destructive: true,
        description:
          'Install the exact approved product through a validated provider and code-owned Windows protocol; success requires independent inventory verification.',
      },
      verify: {
        handler: ({ planId }) => this.perform('verify', planId),
        schema: { planId: handleSchema },
        destructive: false,
        description:
          'Refresh and independently match actual installed product identity, publisher and version.',
      },
      registerProvider: {
        handler: ({ registrationId }) => this.registerSource(registrationId),
        schema: { registrationId: handleSchema },
        destructive: true,
        description:
          'Approve a repository origin/publisher policy selected by the user. Models cannot enroll software sources.',
      },
      removeProvider: {
        handler: ({ registrationId }) => this.removeSource(registrationId),
        schema: { registrationId: handleSchema },
        destructive: true,
        description:
          'Disable a user-approved software source without deleting original installers or installed applications.',
      },
    };
  }
  configured() {
    if (executionContext.getStore()?.authenticated !== true)
      throw error('AUTH_CONTEXT_REQUIRED', 'An authenticated software session is required.');
    if (!this.store)
      throw error(
        'SOFTWARE_STORAGE_UNAVAILABLE',
        'Protected per-user software storage is unavailable. Restart the desktop app.',
      );
    softwareOwner(scope());
  }
  async execute(action, params = {}) {
    return truthful(await super.execute(action, params));
  }
  async executeConfirmed(action, params = {}, metadata = {}) {
    this.configured();
    if (['download', 'install'].includes(action)) {
      const current = this.activePlan(params.planId);
      if (
        metadata.softwarePlanDigest !== planDigest(current) ||
        metadata.softwarePlanId !== params.planId
      )
        throw error(
          'SOFTWARE_PLAN_CHANGED',
          'The software plan changed since approval. Review a fresh plan; no installer was run.',
        );
    }
    return truthful(await super.executeConfirmed(action, params));
  }
  configurations() {
    this.configured();
    return this.store
      .list('configuration', scope())
      .filter((record) => record.data.approved === true && record.data.disabled !== true);
  }
  async environment({ refresh = false } = {}) {
    this.configured();
    const owner = softwareOwner(scope());
    const cached = this.environments.get(owner);
    if (!refresh && cached && this.now() - cached.at < 30000) return cached.value;
    const records = this.configurations(),
      descriptors = records.map((record) => validateProviderDescriptor(record.data.descriptor));
    const offlineEntries = async () =>
      [
        ...this.store.list('cache', scope()).map((record) => ({ ...record.data, owner: scope() })),
        ...this.store.list('plan', scope()).flatMap((record) => {
          const p = record.data.stagedPlan || record.data.plan;
          return p.installer.path && record.data.downloadVerified
            ? [
                {
                  id: p.product.id,
                  name: p.product.name,
                  publisher: p.product.publisher,
                  version: p.product.version,
                  architecture: p.architecture,
                  scope: p.scope,
                  file: p.installer.path,
                  sha256: p.installer.sha256,
                  owner: scope(),
                },
              ]
            : [];
        }),
      ]
        .filter(
          (item, index, entries) =>
            entries.findIndex((candidate) => candidate.file === item.file) === index,
        )
        .slice(0, 500);
    const inventory = async () => (await this.inventory()).entries;
    const resolveAuthorization = (providerId) => {
      const configuration = records.find(
        (record) => record.data.descriptor.id === providerId,
      )?.data;
      return configuration?.credential
        ? this.store.openSecret(configuration.credential)
        : undefined;
    };
    const value = await this.providerFactory({
      descriptors,
      offlineEntries,
      inspect: this.inspect,
      inventory,
      root: path.join(this.directory, 'cache', 'manager'),
      ...(this.run ? { run: this.run } : {}),
      resolveAuthorization,
      download: (plan, directory, options) =>
        downloadTrustedInstaller(plan, directory, { ...options, resolveAuthorization }),
    });
    const options = {
      root: path.join(this.directory, 'cache'),
      inspect: this.inspect,
      managerAdapters: value.managerAdapters,
      refresh: async () => this.appService?.registry?.refresh(),
      inventory,
      trust: this.trust,
      now: this.now,
      resolveAuthorization,
    };
    value.executor = this.executorFactory
      ? this.executorFactory(options)
      : new InstallerExecutor(options);
    this.environments.set(owner, { at: this.now(), value });
    return value;
  }
  async providers() {
    const { registry, diagnostics } = await this.environment();
    return {
      success: true,
      status: 'PROVIDERS_READY',
      providers: registry.list(),
      diagnostics: diagnostics || [],
      sources: this.configurations().map((record) => ({
        registrationId: record.id,
        descriptor: record.data.descriptor,
        authenticated: !!record.data.credential,
      })),
      cachedInstallers: this.store.list('cache', scope()).length,
    };
  }
  rememberCache(plan) {
    this.store.put(
      'cache',
      scope(),
      {
        id: plan.product.id,
        name: plan.product.name,
        publisher: plan.product.publisher,
        version: plan.product.version,
        architecture: plan.architecture,
        scope: plan.scope,
        file: plan.installer.path,
        sha256: plan.installer.sha256,
      },
      { expiresAt: this.now() + 3650 * 24 * 60 * 60_000 },
    );
  }
  async discover(rawQuery, online) {
    const query = sanitizeSoftwareQuery(rawQuery);
    this.configured();
    checkCancellation();
    if (online && executionContext.getStore()?.humanApproved !== true)
      throw error(
        'NETWORK_APPROVAL_REQUIRED',
        'An online software lookup needs explicit user approval.',
      );
    const { registry, diagnostics = [] } = await this.environment(),
      found = await registry.searchAll(query, {
        networkAllowed: online,
        signal: executionContext.getStore()?.signal,
        scope: scope(),
      });
    const failures = [...diagnostics, ...(found.failures || [])];
    const ranked = this.resolver.rank(query, found.candidates),
      discoveryId = randomUUID();
    const handoffs = ranked.candidates
      .filter((candidate) => candidate.handoff)
      .map((candidate) => ({
        name: candidate.name,
        providerId: candidate.providerId,
        source: candidate.resolvedPlan?.source?.origin,
      }));
    // A catalog search page is a useful fallback, not proof that software is
    // unavailable from other eligible sources. Search those before handoff.
    if (
      !online &&
      found.requiresOnline &&
      !ranked.candidates.some((candidate) => !candidate.handoff)
    ) {
      ranked.candidates = [];
      ranked.selectedCandidate = undefined;
      ranked.requiresChoice = false;
    }
    const candidates = ranked.candidates.slice(0, 30).map((candidate) => {
      const id = this.store.put('candidate', scope(), { discoveryId, query, candidate });
      return publicCandidate(candidate, id);
    });
    const selectedCandidateId = ranked.selectedCandidate
      ? candidates[ranked.candidates.indexOf(ranked.selectedCandidate)]?.candidateId ||
        candidates[0]?.candidateId
      : undefined;
    const data = {
      query,
      discoveryId,
      candidates,
      handoffs,
      requiresChoice: ranked.requiresChoice,
      selectedCandidateId,
      requiresOnline: !online && found.requiresOnline,
      failures,
      status: ranked.requiresChoice
        ? 'SOFTWARE_SELECTION_REQUIRED'
        : candidates.length
          ? 'CANDIDATES_FOUND'
          : 'SOFTWARE_NOT_FOUND',
    };
    this.store.put('discovery', scope(), data, { id: discoveryId });
    return {
      success: true,
      ...data,
      message: candidates.length
        ? candidates.every((candidate) => candidate.handoff)
          ? this.handoffMessage(failures)
          : ranked.requiresChoice
            ? 'Several products or publishers match. Choose the exact identity.'
            : 'Matching software sources were found. Installation still requires approval.'
        : `No verified offline${online ? ' or approved online' : ''} method was found.${data.requiresOnline ? ' Approve online discovery or add an approved source.' : ' Select a signed offline installer or register an authorized publisher repository.'}`,
    };
  }
  handoffMessage(failures = []) {
    const reasons = failures
      .slice(0, 3)
      .map((failure) => `${failure.providerId}: ${failure.message || failure.status}`)
      .join(' ');
    return `No verified installation package was found in the available sources.${reasons ? ` ${reasons}` : ''} Search online installation sources, open the official page, or choose a signed local installer.`;
  }
  chooseCandidate(discoveryId, candidateId) {
    this.configured();
    if (
      executionContext.getStore()?.origin !== 'operator' ||
      executionContext.getStore()?.humanApproved !== true
    )
      throw error('HUMAN_CHOICE_REQUIRED', 'Only the user can resolve a software identity choice.');
    const discovery = this.store.get('discovery', scope(), discoveryId);
    if (
      discovery.cancelled ||
      !discovery.candidates.some((candidate) => candidate.candidateId === candidateId)
    )
      throw error(
        'SOFTWARE_CHOICE_INVALID',
        'Choose one of the software identities originally offered in this account.',
      );
    if (discovery.selectedByUser && discovery.selectedCandidateId !== candidateId)
      throw error('SOFTWARE_CHOICE_USED', 'This software choice has already been answered.');
    this.store.update('discovery', scope(), discoveryId, {
      ...discovery,
      selectedCandidateId: candidateId,
      selectedByUser: true,
    });
    return {
      success: true,
      status: 'SOFTWARE_SELECTED',
      discoveryId,
      candidateId,
      selectedCandidateId: candidateId,
    };
  }
  cancelChoice(discoveryId) {
    const discovery = this.store.get('discovery', scope(), discoveryId);
    this.store.update('discovery', scope(), discoveryId, { ...discovery, cancelled: true });
    return { cancelled: true };
  }
  async resolve(candidateId) {
    this.configured();
    const item = this.store.get('candidate', scope(), candidateId),
      discovery = this.store.get('discovery', scope(), item.discoveryId);
    if (
      discovery.cancelled ||
      (discovery.requiresChoice &&
        (!discovery.selectedByUser || discovery.selectedCandidateId !== candidateId))
    )
      throw error(
        'SOFTWARE_SELECTION_REQUIRED',
        'The user must choose the exact software identity before resolving it.',
      );
    const { registry, executor } = await this.environment(),
      planId = randomUUID();
    const plan = validateInstallerPlan({
      ...(await registry.resolveCandidate(item.candidate, item.query)),
      planId,
    });
    this.assertRegisteredSource(plan);
    const prepared = plan.protocol === 'package-manager' ? { plan } : await executor.prepare(plan);
    this.store.put(
      'plan',
      scope(),
      {
        plan,
        digest: planDigest(plan),
        downloadVerified: false,
        candidateId,
        discoveryId: item.discoveryId,
      },
      { id: planId },
    );
    return {
      success: true,
      status: prepared.handoff || plan.protocol === 'handoff' ? 'HANDOFF_REQUIRED' : 'PLAN_READY',
      plan: fields(plan),
      message:
        plan.protocol === 'handoff'
          ? this.handoffMessage(discovery.failures)
          : 'A validated product-specific plan is ready for review.',
    };
  }
  activePlan(planId) {
    this.configured();
    const record = this.store.get('plan', scope(), planId);
    if (record.digest !== planDigest(record.plan))
      throw error('SOFTWARE_PLAN_CHANGED', 'The saved software plan failed its integrity check.');
    return validateInstallerPlan(record.stagedPlan || record.plan);
  }
  assertRegisteredSource(plan) {
    this.trust.assertPlan(plan);
    if (plan.source.evidence === 'operator-approved') {
      const anchor = this.configurations().find(
        (record) => record.data.descriptor.id === plan.source.providerId,
      )?.data.descriptor;
      if (
        !anchor ||
        anchor.origin !== plan.source.origin ||
        !anchor.publishers.some(
          (publisher) =>
            normalizePublisher(publisher) === normalizePublisher(plan.product.publisher),
        ) ||
        (plan.source.allowedHosts || []).some((host) => !(anchor.allowedHosts || []).includes(host))
      )
        throw error(
          'SOFTWARE_SOURCE_CHANGED',
          'The repository authorization changed. Discover and approve a new plan.',
        );
      if ((plan.source.networkClass || 'public') !== (anchor.networkClass || 'public'))
        throw error('SOFTWARE_SOURCE_CHANGED', 'The repository network authorization changed.');
      const pins = (values) => (values || []).map((value) => String(value).toUpperCase()).sort();
      if (
        JSON.stringify(pins(plan.source.publisherTrust?.signatureThumbprints)) !==
        JSON.stringify(pins(anchor.signatureThumbprints))
      )
        throw error(
          'SOFTWARE_SOURCE_CHANGED',
          'The repository certificate authorization changed. Review a fresh plan.',
        );
    }
  }
  async perform(action, planId) {
    reportExecutionProgress('preparing', 'Checking the approved software plan…');
    const plan = this.activePlan(planId);
    this.assertRegisteredSource(plan);
    const { executor } = await this.environment();
    if (action === 'install' && plan.operation === 'download')
      throw error(
        'DOWNLOAD_ONLY_PLAN',
        'This plan authorizes downloading only. Request a new installation plan and approval to run it.',
      );
    if (action === 'verify') {
      const verification = await executor.verify(plan);
      const verified = verification.status === 'verified';
      return {
        success: verified,
        status: verified ? 'INSTALL_VERIFIED' : 'INSTALL_NOT_VERIFIED',
        planId,
        name: plan.product.name,
        publisher: plan.product.publisher,
        version: plan.product.version,
        verification,
        message: verified
          ? `${plan.product.name} is verified in fresh installed-software inventory.`
          : 'The exact approved identity, publisher and version could not be confirmed installed.',
      };
    }
    if (executionContext.getStore()?.humanApproved !== true)
      throw error(
        'INSTALL_APPROVAL_REQUIRED',
        'A product-specific approval is required for this software action.',
      );
    if (action === 'install' && this.installActive)
      throw error(
        'SOFTWARE_INSTALL_BUSY',
        'Another approved installer is active. Wait for it to finish or cancel it before starting a new one.',
      );
    if (action === 'download' && this.activeDownloads >= 2)
      throw error(
        'SOFTWARE_DOWNLOAD_BUSY',
        'Two approved installer downloads are already active. Wait for one to finish.',
      );
    if (action === 'install') this.installActive = true;
    else this.activeDownloads++;
    let result;
    try {
      result = await executor[action](plan);
    } finally {
      if (action === 'install') this.installActive = false;
      else this.activeDownloads--;
    }
    const record = this.store.get('plan', scope(), planId);
    if (action === 'download' && result.success) {
      const stagedPlan = validateInstallerPlan({
        ...result.plan,
        planId,
        ...(plan.protocol !== 'package-manager' &&
        plan.operation !== 'download' &&
        plan.scope !== 'operating-system'
          ? { protocol: 'local-installer' }
          : {}),
      });
      this.store.update('plan', scope(), planId, { ...record, stagedPlan, downloadVerified: true });
      this.rememberCache(stagedPlan);
      return {
        ...result,
        plan: fields(stagedPlan),
        planId,
        status: 'DOWNLOADED_VERIFIED',
        sha256: result.sha256 || stagedPlan.installer.sha256,
        verification: {
          status: 'verified',
          criterion: 'signature_hash_identity',
          observedAt: new Date(this.now()).toISOString(),
        },
        message:
          'The exact installer is verified in the private offline cache. It has not been run.',
      };
    }
    this.store.put('result', scope(), { planId, action, result: { ...result, plan: undefined } });
    return {
      ...result,
      plan: fields(plan),
      planId,
      status: result.needsReboot ? 'INSTALLED_REBOOT_REQUIRED' : result.status,
    };
  }
  stageRegistration(descriptor, credential) {
    this.configured();
    if (executionContext.getStore()?.origin !== 'operator')
      throw error(
        'SOURCE_APPROVAL_REQUIRED',
        'Models cannot register software distribution sources.',
      );
    const normalized = validateProviderDescriptor(descriptor);
    if (['offline-cache', 'microsoft-store-handoff'].includes(normalized.id))
      throw error(
        'RESERVED_PROVIDER_ID',
        'Choose a distinct provider ID; built-in source identities cannot be replaced.',
      );
    for (const value of [
      normalized.origin,
      normalized.metadataUrl,
      normalized.versionUrlTemplate,
    ].filter(Boolean)) {
      if (!/^https:/i.test(value)) continue;
      const address = new URL(value.replaceAll('{version}', '1.0'));
      if (
        [...address.searchParams.keys()].some((name) =>
          /^(?:access_token|token|api[_-]?key|password|secret|sig|signature|authorization)$/i.test(
            name,
          ),
        )
      )
        throw error(
          'SOURCE_CREDENTIAL_IN_URL',
          'Put provider credentials in the protected token field rather than a source URL.',
        );
    }
    if (
      credential &&
      (typeof credential !== 'string' || credential.length > 8192 || /[\r\n]/.test(credential))
    )
      throw error(
        'INVALID_PROVIDER_AUTHORIZATION',
        'Enter a valid single-line provider credential.',
      );
    return this.store.put(
      'configuration',
      scope(),
      {
        descriptor: normalized,
        approved: false,
        ...(credential ? { credential: this.store.sealSecret(`Bearer ${credential}`) } : {}),
      },
      { expiresAt: this.now() + 3650 * 24 * 60 * 60_000 },
    );
  }
  registerSource(registrationId) {
    this.configured();
    const context = executionContext.getStore();
    if (context?.origin !== 'operator' || context.humanApproved !== true)
      throw error('SOURCE_APPROVAL_REQUIRED', 'Repository trust requires a direct user approval.');
    const record = this.store.get('configuration', scope(), registrationId);
    if (
      this.configurations().some(
        (item) => item.id !== registrationId && item.data.descriptor.id === record.descriptor.id,
      )
    )
      throw error(
        'DUPLICATE_PROVIDER',
        'That provider identity is already approved. Remove it before replacing its policy.',
      );
    this.store.update(
      'configuration',
      scope(),
      registrationId,
      { ...record, approved: true },
      { expiresAt: this.now() + 3650 * 24 * 60 * 60_000 },
    );
    this.environments.delete(softwareOwner(scope()));
    return {
      success: true,
      status: 'SOURCE_REGISTERED',
      providerId: record.descriptor.id,
      message: 'This repository origin and publisher policy were approved for your account.',
    };
  }
  removeSource(registrationId) {
    if (
      executionContext.getStore()?.origin !== 'operator' ||
      executionContext.getStore()?.humanApproved !== true
    )
      throw error('SOURCE_APPROVAL_REQUIRED', 'Source removal requires the user.');
    const record = this.store.get('configuration', scope(), registrationId);
    this.store.update('configuration', scope(), registrationId, { ...record, disabled: true });
    this.environments.delete(softwareOwner(scope()));
    return {
      success: true,
      status: 'SOURCE_REMOVED',
      message: 'The source is disabled. Original files and installed software were preserved.',
    };
  }
  async stageOffline(file, requestedProduct) {
    this.configured();
    if (executionContext.getStore()?.origin !== 'operator')
      throw error(
        'NATIVE_SELECTION_REQUIRED',
        'Choose an offline installer through the native file picker.',
      );
    const format = path.extname(file).slice(1).toLowerCase(),
      metadata = await this.inspect(file, format);
    if (
      metadata.status !== 'Valid' ||
      !metadata.publisher ||
      !metadata.productName ||
      !metadata.productVersion
    )
      throw error(
        'OFFLINE_IDENTITY_UNVERIFIED',
        'The selected installer needs a valid signature, known publisher, product identity and version.',
      );
    const query = sanitizeSoftwareQuery({
      operation: 'install',
      product: requestedProduct,
      publisher: metadata.publisher,
    });
    const candidate = {
      name: metadata.productName,
      id: metadata.packageIdentity || metadata.productName,
      publisher: metadata.publisher,
      version: metadata.productVersion,
      architecture: metadata.architecture || 'any',
      trust: 'local-selection',
      providerId: 'offline-cache',
      identityVerified: true,
    };
    if (this.resolver.rank(query, [candidate]).candidates.length === 0)
      throw error(
        'OFFLINE_IDENTITY_MISMATCH',
        "The signed installer's actual identity does not match the requested product.",
      );
    const planId = randomUUID(),
      directory = path.join(this.directory, 'cache', planId),
      target = path.join(directory, `installer.${format}`);
    try {
      await fs.mkdir(directory, { recursive: true });
      await fs.copyFile(file, target, 1);
      const plan = validateInstallerPlan({
        schemaVersion: 1,
        planId,
        operation: 'install',
        protocol: 'local-installer',
        product: {
          id: candidate.id,
          name: candidate.name,
          publisher: candidate.publisher,
          version: candidate.version,
        },
        source: {
          providerId: 'offline-cache',
          kind: 'local',
          origin: 'Native-selected offline installer',
          trust: 'local-selection',
          publisher: candidate.publisher,
          allowedHosts: [],
          publisherTrust: {
            publishers: [candidate.publisher],
            signatureThumbprints: metadata.signerThumbprint ? [metadata.signerThumbprint] : [],
          },
          evidence: 'native-selection',
        },
        architecture: candidate.architecture,
        platform: {
          os: 'windows',
          ...(metadata.minimumWindowsVersion
            ? { minimumVersion: metadata.minimumWindowsVersion }
            : {}),
        },
        installer: {
          format,
          path: target,
          sha256: metadata.sha256,
          size: metadata.size,
          ...(metadata.packageIdentity ? { packageIdentity: metadata.packageIdentity } : {}),
          capabilities: metadata.restrictedCapabilities || [],
        },
        privileges:
          metadata.privileges ||
          (['requireAdministrator', 'administrator'].includes(metadata.elevation)
            ? 'administrator'
            : 'unknown'),
        license: { required: 'unknown' },
        reboot: 'possible',
        dependencies: metadata.dependencies || [],
        scope: 'application',
      });
      await (await this.environment()).executor.prepare(plan);
      this.store.put(
        'plan',
        scope(),
        { plan, digest: planDigest(plan), downloadVerified: true },
        { id: planId },
      );
      this.rememberCache(plan);
      return {
        success: true,
        status: 'OFFLINE_INSTALLER_VERIFIED',
        plan: fields(plan),
        planId,
        message:
          'The native-selected installer is verified. Review a separate approval before installation.',
      };
    } catch (failure) {
      await fs
        .rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
        .catch((cleanupError) =>
          console.warn('[software] Private staging cleanup deferred:', cleanupError.code),
        );
      throw failure;
    }
  }
  _requestConfirmation(action, params, description) {
    this.configured();
    let details, digest;
    if (['download', 'install'].includes(action)) {
      const plan = this.activePlan(params.planId);
      this.assertRegisteredSource(plan);
      if (action === 'install' && plan.operation === 'download')
        throw error(
          'DOWNLOAD_ONLY_PLAN',
          'This plan authorizes a download only. Request a new installation plan.',
        );
      details = {
        ...fields(plan),
        operation: action,
        requestedOperation: plan.operation,
        executionMode:
          action !== 'install'
            ? 'Download only; the installer will not run'
            : plan.protocol === 'package-manager'
              ? 'Automatic installation; Windows may ask for administrator approval'
              : 'Publisher installer; it may require your input',
      };
      digest = planDigest(plan);
    } else if (action === 'discoverOnline') {
      const query = sanitizeSoftwareQuery(params.query);
      details = {
        operation: 'online discovery',
        name: query.product,
        publisher: query.publisher || 'To be resolved',
        version: query.version || 'Latest compatible',
        source: 'Registered eligible online providers',
        privileges: 'none',
        license: { required: 'unknown' },
        reboot: 'none',
      };
    } else {
      const record = this.store.get('configuration', scope(), params.registrationId);
      if (executionContext.getStore()?.origin !== 'operator')
        throw error('SOURCE_APPROVAL_REQUIRED', 'Only the user can manage software sources.');
      details = {
        operation:
          action === 'registerProvider' ? 'approve repository trust' : 'disable repository',
        name: record.descriptor.name,
        publisher: record.descriptor.publishers.join(', '),
        source: record.descriptor.origin,
        privileges: 'none',
        license: { required: 'not applicable' },
        reboot: 'none',
      };
    }
    const message = `${details.operation === 'install' || ['install', 'update', 'reinstall'].includes(details.operation) ? 'Review software installation' : 'Review software action'}: ${details.name} · ${details.publisher} · ${details.version || 'version unknown'}. Source: ${details.source}. This approval applies only to this action and identity.`;
    const { confirmationId, expiresAt } = this.confirmationGate.request({
      tool: this.name,
      action,
      params,
      scope: scope(),
      message,
      ...(digest ? { softwarePlanDigest: digest, softwarePlanId: params.planId } : {}),
      softwareApproval: details,
    });
    return {
      success: true,
      needsConfirmation: true,
      confirmationId,
      expiresAt,
      message,
      approvalDetails: {
        action: details.operation,
        reason: 'Exact software/source approval',
        software: details,
      },
    };
  }
}
