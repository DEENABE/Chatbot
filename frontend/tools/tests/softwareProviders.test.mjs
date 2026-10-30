import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProviderRegistry } from '../software/ProviderRegistry.js';
import { SoftwareResolver } from '../software/SoftwareResolver.js';
import { sanitizeSoftwareQuery, validateInstallerPlan, planDigest } from '../software/contracts.js';
import {
  validateProviderDescriptor,
  MetadataProvider,
  fetchAuthorizedJson,
} from '../software/providers/MetadataProvider.js';
import { OfflineInstallerProvider } from '../software/providers/OfflineProvider.js';
import {
  discoverDefaultProviders,
  parseWingetSources,
} from '../software/providers/discoverDefaultProviders.js';
import { WingetProvider } from '../software/providers/WingetProvider.js';
import { executionContext } from '../ExecutionContext.js';

// Controlled adapters and metadata only. No network request, downloaded binary, installer, or package manager runs.
const fixture = () => {
  const token = crypto.randomBytes(5).toString('hex');
  return {
    id: `fixture.${token}`,
    name: `Product ${token}`,
    publisher: `Publisher ${token}`,
    version: '2.3.4',
  };
};
const descriptor = () => ({
  schemaVersion: 1,
  id: 'approved-feed',
  kind: 'json-feed',
  name: 'Operator approved feed',
  origin: 'https://publisher.example/',
  metadataUrl: 'https://publisher.example/catalog.json',
  allowedHosts: ['publisher.example'],
  publishers: ['Approved Publisher'],
});
const planFor = (product = fixture(), overrides = {}) => ({
  schemaVersion: 1,
  operation: 'install',
  protocol: 'download',
  product,
  source: {
    providerId: 'controlled',
    kind: 'metadata',
    origin: 'https://publisher.example/',
    trust: 'approved',
    publisher: product.publisher,
    allowedHosts: ['publisher.example'],
    publisherTrust: { publishers: [product.publisher] },
    evidence: 'operator-approved',
  },
  architecture: 'x64',
  platform: { os: 'windows' },
  installer: { format: 'exe', url: 'https://publisher.example/setup.exe', sha256: 'a'.repeat(64) },
  privileges: 'user',
  license: { required: false },
  reboot: 'possible',
  dependencies: [],
  ...overrides,
});
const candidateFor = (product, providerId = 'controlled') => ({
  ...product,
  providerId,
  architecture: 'x64',
  trust: 'approved',
  identityVerified: true,
  resolvedPlan: planFor(product, { source: { ...planFor(product).source, providerId } }),
});

test('query keeps arbitrary Unicode and punctuation identities but rejects executable model fields', () => {
  const query = sanitizeSoftwareQuery({
    product: "Ωmega & Co's Studio",
    publisher: 'A & B',
    operation: 'download',
    source: 'approved-feed',
  });
  assert.equal(query.product, "Ωmega & Co's Studio");
  assert.equal(query.sourceProviderId, 'approved-feed');
  assert.throws(() => sanitizeSoftwareQuery({ product: 'https://attacker.example/payload.exe' }), {
    code: 'INVALID_SOFTWARE_QUERY',
  });
  assert.throws(() => sanitizeSoftwareQuery({ product: 'powershell -EncodedCommand opaque' }), {
    code: 'INVALID_SOFTWARE_QUERY',
  });
  assert.throws(() => sanitizeSoftwareQuery({ product: 'Unseen Product', command: 'run' }), {
    code: 'INVALID_SOFTWARE_DATA',
  });
  assert.equal(sanitizeSoftwareQuery({ product: 'PowerShell' }).product, 'PowerShell');
});

test('immutable typed plans reject raw arguments, unknown publisher, and an unapproved origin', () => {
  const plan = validateInstallerPlan(planFor());
  assert.ok(Object.isFrozen(plan.installer));
  assert.equal(planDigest(plan), planDigest(structuredClone(plan)));
  assert.throws(
    () => validateInstallerPlan({ ...planFor(), installer: { format: 'exe', args: ['/quiet'] } }),
    { code: 'INVALID_SOFTWARE_DATA' },
  );
  const product = fixture();
  assert.throws(
    () =>
      validateInstallerPlan(
        planFor(product, {
          source: {
            ...planFor(product).source,
            publisherTrust: { publishers: ['Different Publisher'] },
          },
        }),
      ),
    { code: 'PUBLISHER_NOT_APPROVED' },
  );
  assert.throws(
    () =>
      validateInstallerPlan({
        ...planFor(),
        installer: { format: 'exe', url: 'https://attacker.example/setup.exe' },
      }),
    { code: 'UNTRUSTED_SOURCE' },
  );
  assert.throws(
    () =>
      validateInstallerPlan({
        ...planFor(),
        installer: {
          format: 'exe',
          url: 'https://publisher.example/setup.exe',
          path: 'C:\\cache\\setup.exe',
        },
      }),
    { code: 'INVALID_INSTALLER_PLAN' },
  );
});

test('new validated code adapter resolves previously unknown software without resolver edits', async () => {
  const product = fixture(),
    candidate = candidateFor(product, 'future-source'),
    registry = new ProviderRegistry();
  const adapter = {
    id: 'future-source',
    descriptor: { kind: 'controlled-test', origin: 'https://publisher.example/' },
    capabilities: { offline: true, network: false },
    isAvailable: async () => true,
    search: async () => [candidate],
    resolve: async () => candidate.resolvedPlan,
  };
  assert.throws(() => registry.register(adapter), { code: 'PROVIDER_NOT_AUTHORIZED' });
  registry.register(adapter, { trusted: true });
  const found = await registry.searchAll({ product: product.name });
  const ranked = new SoftwareResolver().rank({ product: product.name }, found.candidates);
  assert.equal(ranked.requiresChoice, false);
  assert.equal(ranked.selectedCandidate.id, product.id);
  assert.equal(
    (await registry.resolveCandidate(ranked.selectedCandidate, { product: product.name })).product
      .publisher,
    product.publisher,
  );
});

test('offline discovery does not touch network providers; approved metadata supplies an absent-manager alternative', async () => {
  const product = fixture(),
    data = descriptor();
  data.publishers = [product.publisher];
  let network = 0;
  const registry = new ProviderRegistry({
    fetchJson: async () => {
      network++;
      return {
        schemaVersion: 1,
        products: [
          {
            ...product,
            architecture: 'x64',
            installer: {
              format: 'msi',
              url: 'https://publisher.example/new.msi',
              sha256: 'b'.repeat(64),
            },
          },
        ],
      };
    },
  });
  registry.registerDescriptor(data, { approved: true, approvedBy: 'operator' });
  const offline = await registry.searchAll({ product: product.name });
  assert.equal(network, 0);
  assert.equal(offline.requiresOnline, true);
  assert.equal(offline.candidates.length, 0);
  const online = await registry.searchAll({ product: product.name }, { networkAllowed: true });
  assert.equal(network, 1);
  assert.equal(online.candidates.length, 1);
  await registry.resolveCandidate(online.candidates[0], { product: product.name });
  assert.equal(network, 1, 'resolve must not silently refresh online metadata');
});

test('independent source failures retain actionable diagnostics and an available source still wins', async () => {
  const product = fixture(),
    registry = new ProviderRegistry();
  for (const [id, behavior] of [
    ['missing-manager', 'unavailable'],
    ['broken-feed', 'throws'],
    ['offline', 'works'],
  ]) {
    registry.register(
      {
        id,
        descriptor: { kind: 'controlled-test' },
        capabilities: { offline: true, network: false },
        isAvailable: async () => behavior !== 'unavailable',
        search: async () => {
          if (behavior === 'throws')
            throw Object.assign(
              new Error('Approved repository unavailable; check its configuration.'),
              { code: 'SOURCE_TIMEOUT' },
            );
          return [candidateFor(product, id)];
        },
        resolve: async (candidate) => candidate.resolvedPlan,
      },
      { trusted: true },
    );
  }
  const found = await registry.searchAll({ product: product.name });
  assert.equal(found.candidates.length, 1);
  assert.equal(found.failures.length, 2);
  assert.ok(found.failures.some((failure) => failure.status === 'PROVIDER_UNAVAILABLE'));
  assert.ok(found.failures.some((failure) => failure.status === 'SOURCE_TIMEOUT'));
});

test('same product name from materially different publishers requires human selection', () => {
  const product = fixture(),
    candidates = [
      candidateFor(product),
      candidateFor({ ...product, id: 'other.identity', publisher: 'Another Publisher' }, 'other'),
    ];
  const result = new SoftwareResolver().rank({ product: product.name }, candidates);
  assert.equal(result.requiresChoice, true);
  assert.equal(result.selectedCandidate, undefined);
  const constrained = new SoftwareResolver().rank(
    { product: product.name, publisher: product.publisher },
    candidates,
  );
  assert.equal(constrained.requiresChoice, false);
  assert.equal(constrained.selectedCandidate.publisher, product.publisher);
});

test('resolver respects version/edition/architecture and prefers installers over user handoff', () => {
  const product = fixture(),
    resolver = new SoftwareResolver({ architecture: 'arm64' });
  const candidates = [
    candidateFor(product),
    {
      ...candidateFor({ ...product, version: '1.0' }, 'older'),
      architecture: 'arm64',
      edition: 'Community',
    },
    { ...candidateFor(product, 'native'), architecture: 'arm64', edition: 'Pro' },
  ];
  assert.equal(
    resolver.rank(
      { product: product.name, architecture: 'arm64', version: '1.0', edition: 'Community' },
      candidates,
    ).selectedCandidate.providerId,
    'older',
  );
  const handoff = {
    ...candidateFor(product, 'handoff'),
    architecture: 'any',
    handoff: true,
    identityVerified: false,
    publisher: '',
  };
  assert.equal(
    resolver.rank({ product: product.name }, [handoff, candidates[2]]).selectedCandidate.providerId,
    'native',
  );
  const weakInstaller = {
    ...candidateFor({ ...product, id: 'northwind.desktop', name: 'Northwimd' }, 'installer'),
    architecture: 'any',
    identityVerified: false,
  };
  const exactPage = { ...handoff, id: 'northwind.page', name: 'Northwind', version: '99.0' };
  const weakResult = resolver.rank({ product: 'Northwind' }, [exactPage, weakInstaller]);
  assert.equal(weakResult.candidates[0].providerId, 'installer');
  assert.ok(weakResult.candidates[0].score < weakResult.candidates[1].score);
  assert.equal(weakResult.requiresChoice, true);
  assert.equal(weakResult.selectedCandidate, undefined);
});

test('operator descriptors cannot register executable modules, wildcard domains, or unknown publishers', () => {
  const registry = new ProviderRegistry();
  assert.throws(() => registry.registerDescriptor(descriptor()), {
    code: 'SOURCE_APPROVAL_REQUIRED',
  });
  assert.throws(
    () => validateProviderDescriptor({ ...descriptor(), modulePath: 'C:\\payload.js' }),
    { code: 'INVALID_SOFTWARE_DATA' },
  );
  assert.throws(
    () => validateProviderDescriptor({ ...descriptor(), allowedHosts: ['*.example'] }),
    { code: 'UNSAFE_SOURCE' },
  );
  assert.throws(() => validateProviderDescriptor({ ...descriptor(), publishers: [] }), {
    code: 'PUBLISHER_NOT_APPROVED',
  });
  assert.throws(
    () =>
      validateProviderDescriptor({
        ...descriptor(),
        metadataUrl: 'https://unapproved.example/feed',
      }),
    { code: 'INVALID_PROVIDER_DESCRIPTOR' },
  );
});

test('authorized feed rejects publisher mismatches and arbitrary executable instructions', async () => {
  const data = validateProviderDescriptor(descriptor());
  const provider = new MetadataProvider(data, {
    fetchJson: async () => ({
      schemaVersion: 1,
      products: [
        {
          id: 'new.id',
          name: 'New Product',
          publisher: 'Unknown Publisher',
          version: '1',
          installer: { format: 'exe', url: 'https://publisher.example/setup.exe' },
        },
      ],
    }),
  });
  await assert.rejects(provider.search({ product: 'New Product', operation: 'install' }), {
    code: 'PUBLISHER_NOT_APPROVED',
  });
  provider.fetchJson = async () => ({
    schemaVersion: 1,
    products: [
      {
        id: 'new.id',
        name: 'New Product',
        publisher: 'Approved Publisher',
        version: '1',
        installer: {
          format: 'exe',
          url: 'https://publisher.example/setup.exe',
          arguments: ['/do-anything'],
        },
      },
    ],
  });
  await assert.rejects(provider.search({ product: 'New Product', operation: 'install' }), {
    code: 'INVALID_SOFTWARE_DATA',
  });
});

test('release API adapter resolves official assets of future unknown products using metadata and user constraints', async () => {
  const product = fixture(),
    data = validateProviderDescriptor({
      ...descriptor(),
      kind: 'release-api',
      product: { id: product.id, name: product.name, publisher: product.publisher },
      publishers: [product.publisher],
      versionUrlTemplate: 'https://publisher.example/releases/{version}',
    });
  let requested;
  const provider = new MetadataProvider(data, {
    fetchJson: async (url) => {
      requested = url;
      return {
        tag_name: 'v2.3.4',
        draft: false,
        prerelease: false,
        assets: [
          {
            name: 'windows-arm64.msix',
            browser_download_url: 'https://publisher.example/assets/installer.msix',
            digest: `sha256:${'c'.repeat(64)}`,
            size: 1024,
          },
        ],
      };
    },
  });
  const found = await provider.search({
    product: product.name,
    operation: 'download',
    version: '2.3.4',
  });
  assert.equal(requested, 'https://publisher.example/releases/2.3.4');
  assert.equal(found[0].version, '2.3.4');
  assert.equal(found[0].architecture, 'arm64');
  assert.equal(found[0].resolvedPlan.installer.sha256, 'c'.repeat(64));
});

test('explicit enterprise metadata authorization permits internal hostnames, public policy rejects them', () => {
  const internal = {
    ...descriptor(),
    origin: 'https://packages.enterprise.internal/',
    metadataUrl: 'https://packages.enterprise.internal/feed',
    allowedHosts: ['packages.enterprise.internal'],
    networkClass: 'enterprise',
  };
  assert.equal(validateProviderDescriptor(internal).networkClass, 'enterprise');
  assert.throws(() => validateProviderDescriptor({ ...internal, networkClass: 'public' }), {
    code: 'UNSAFE_SOURCE',
  });
  assert.throws(
    () =>
      validateProviderDescriptor({
        ...internal,
        origin: 'https://localhost/',
        allowedHosts: ['localhost'],
      }),
    { code: 'UNSAFE_SOURCE' },
  );
});

test('metadata DNS policy blocks loopback/cloud metadata before HTTPS connects, without exposing credentials', async () => {
  let secretLookups = 0;
  await assert.rejects(
    fetchAuthorizedJson('https://publisher.example/feed', {
      descriptor: validateProviderDescriptor(descriptor()),
      resolveAuthorization: async () => {
        secretLookups++;
        return 'Bearer confidential-test-token';
      },
      resolve: async () => [{ address: '169.254.169.254', family: 4 }],
    }),
    { code: 'UNSAFE_SOURCE' },
  );
  assert.equal(secretLookups, 1);
});

test('offline signed cache uses fresh inspector identity and refuses another scope or tampered signature', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'software-provider-test-')),
    product = fixture(),
    file = path.join(directory, 'installer.exe');
  try {
    await fs.writeFile(file, Buffer.from([0x4d, 0x5a, 0, 0]));
    let status = 'Valid';
    const provider = new OfflineInstallerProvider({
      entries: [{ ...product, file, owner: 'account-a' }],
      inspect: async () => ({
        status,
        publisher: product.publisher,
        productName: product.name,
        productVersion: product.version,
        architecture: 'x64',
        sha256: 'd'.repeat(64),
        size: 4,
        elevation: 'asInvoker',
      }),
    });
    assert.equal(
      (
        await provider.search(
          { product: product.name, operation: 'install' },
          { scope: 'account-b' },
        )
      ).length,
      0,
    );
    const found = await provider.search(
      { product: product.name, operation: 'install' },
      { scope: 'account-a' },
    );
    assert.equal(found[0].resolvedPlan.source.trust, 'local-selection');
    assert.equal(found[0].publisher, product.publisher);
    status = 'HashMismatch';
    await assert.rejects(
      provider.search({ product: product.name, operation: 'install' }, { scope: 'account-a' }),
      { code: 'UNVERIFIED_INSTALLER' },
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test('missing manager factory remains usable for offline and legitimate official Store handoff', async () => {
  let nativeCalls = 0;
  const found = await discoverDefaultProviders({
    probeManagers: async () => [],
    run: async () => {
      nativeCalls++;
      throw new Error('unexpected process');
    },
  });
  assert.ok(found.registry.get('offline-cache'));
  assert.ok(found.registry.get('microsoft-store-handoff'));
  assert.equal(nativeCalls, 0);
  const query = { product: fixture().name, operation: 'install' };
  const candidates = await found.registry.searchAll(query);
  const handoff = candidates.candidates[0];
  assert.equal(handoff.handoff, true);
  assert.equal(handoff.publisher, '');
  assert.equal((await found.registry.resolveCandidate(handoff, query)).protocol, 'handoff');
});

test('manager discovery binds signed binary and exact repository evidence, rejects arbitrary configured sources', async () => {
  const source = {
    Name: 'custom-display-name',
    Arg: 'https://cdn.winget.microsoft.com/cache',
    Type: 'Microsoft.PreIndexed.Package',
    Identifier: 'Microsoft.Winget.Source_8wekyb3d8bbwe',
  };
  let calls = [];
  const factory = await discoverDefaultProviders({
    probeManagers: async () => [
      {
        manager: 'winget',
        path: 'C:\\signed\\winget.exe',
        signature: 'Valid',
        publisher: 'CN=Microsoft Corporation, O=Microsoft Corporation, C=US',
      },
    ],
    run: async (exe, args) => {
      calls.push({ exe, args });
      return args[0] === '--version'
        ? { code: 0, out: 'v1.10' }
        : {
            code: 0,
            out: JSON.stringify([
              source,
              {
                ...source,
                Name: 'unapproved',
                Arg: 'https://attacker.example/repo',
                Identifier: 'other',
              },
            ]),
          };
    },
  });
  assert.equal(calls.length, 2);
  assert.ok(factory.registry.get('winget:custom-display-name'));
  assert.ok(factory.diagnostics.some((failure) => failure.status === 'SOURCE_APPROVAL_REQUIRED'));
  assert.equal(factory.managerAdapters.size, 1);
  calls = [];
  const rejected = await discoverDefaultProviders({
    probeManagers: async () => [
      {
        manager: 'winget',
        path: 'C:\\unverified\\winget.exe',
        signature: 'NotSigned',
        publisher: '',
      },
    ],
    run: async () => {
      calls.push(1);
    },
  });
  assert.equal(calls.length, 0);
  assert.ok(
    rejected.diagnostics.some((failure) => failure.status === 'MANAGER_SIGNATURE_UNVERIFIED'),
  );
  assert.equal(
    parseWingetSources(JSON.stringify(source) + '\n' + JSON.stringify({ ...source, Name: 'next' }))
      .length,
    2,
  );
});

test('pinned manager plan refuses changed payload before download or installation', async () => {
  const product = fixture();
  let changed = false,
    installs = 0,
    downloads = 0;
  const provider = new WingetProvider({
    source: {
      Name: 'runtime-repo',
      Arg: 'https://cdn.winget.microsoft.com/cache',
      Identifier: 'Microsoft.Winget.Source_8wekyb3d8bbwe',
    },
    executable: 'C:\\signed\\winget.exe',
    run: async (_exe, args) => {
      if (args[0] === 'install') installs++;
      return {
        code: 0,
        out: `Found ${product.name} [${product.id}]\nVersion: ${product.version}\nPublisher: ${product.publisher}\nInstaller Type: exe\nInstaller Url: https://publisher.example/setup.exe\nInstaller SHA256: ${(changed ? 'b' : 'a').repeat(64)}\nScope: user`,
      };
    },
    download: async () => {
      downloads++;
    },
    inspect: async () => ({}),
  });
  const plan = provider.plan(await provider.show(product.id, { operation: 'install' }), {
    operation: 'install',
  });
  changed = true;
  await assert.rejects(provider.execute(plan), { code: 'PACKAGE_PAYLOAD_CHANGED' });
  assert.equal(downloads, 0);
  assert.equal(installs, 0);
});

const managerTable = (rows) =>
  [
    `${'Name'.padEnd(56)}${'Id'.padEnd(48)}Version`,
    '-'.repeat(116),
    ...rows.map((row) => `${row.name.padEnd(56)}${row.id.padEnd(48)}${row.version || '2.3.4'}`),
  ].join('\n');
const searchProvider = (run) =>
  new WingetProvider({
    source: {
      Name: 'runtime-repo',
      Arg: 'https://cdn.winget.microsoft.com/cache',
      Identifier: 'Microsoft.Winget.Source_8wekyb3d8bbwe',
    },
    executable: 'C:\\signed\\winget.exe',
    run,
  });
const managerDetails = (product) =>
  `Found ${product.name} [${product.id}]\nVersion: 2.3.4\nPublisher: Northwind Corporation\nInstaller Type: exe\nInstaller Url: https://publisher.example/setup.exe\nInstaller SHA256: ${'a'.repeat(64)}\nScope: user`;

test('approved manager installs use silent mode with exact pinned identity and preserve cancellation', async () => {
  const product = { id: 'Northwind.Reader', name: 'Northwind Reader' };
  let invocation,
    exitCode = 0;
  const provider = searchProvider(async (_exe, args) => {
    if (args[0] === 'show') return { code: 0, out: managerDetails(product) };
    invocation = args;
    return { code: exitCode, out: '' };
  });
  const plan = provider.plan(
    {
      ...product,
      publisher: 'Northwind Corporation',
      version: '2.3.4',
      installerUrl: 'https://publisher.example/setup.exe',
      sha256: 'a'.repeat(64),
      installerType: 'exe',
      scope: 'user',
    },
    { operation: 'install' },
  );
  provider.download = async () => ({ success: true });
  assert.equal((await provider.execute(plan)).code, 0);
  assert.ok(invocation.includes('--silent'));
  assert.ok(!invocation.includes('--interactive'));
  assert.ok(invocation.includes('--disable-interactivity'));
  assert.equal(invocation[invocation.indexOf('--id') + 1], product.id);
  assert.equal(invocation[invocation.indexOf('--version') + 1], '2.3.4');
  exitCode = 0x8a15010c;
  assert.equal((await provider.execute(plan)).cancelled, true);
});

test('manager searches query tokens when catalog words are separated and deduplicates returned identities', async () => {
  const product = { id: 'Northwind.DocumentReader', name: 'Northwind Document Reader' },
    searches = [],
    lookups = [];
  const provider = searchProvider(async (_exe, args) => {
    assert.equal(args[args.indexOf('--source') + 1], 'runtime-repo');
    if (args[0] === 'search') {
      const query = args[args.indexOf('--query') + 1];
      searches.push(query);
      return query === 'Northwind Reader'
        ? { code: 0x8a150014, out: 'No package found matching input criteria.' }
        : {
            code: 0,
            out: managerTable([{ id: 'Other.Reader', name: 'Another Reader' }, product]),
          };
    }
    assert.equal(args[0], 'show');
    const id = args[args.indexOf('--id') + 1];
    lookups.push(id);
    assert.equal(id, product.id);
    return { code: 0, out: managerDetails(product) };
  });
  const found = await provider.search({ product: 'Northwind Reader', operation: 'install' });
  assert.deepEqual(searches, ['Northwind Reader', 'northwind', 'reader']);
  assert.deepEqual(lookups, [product.id]);
  assert.equal(found.length, 1);
  assert.equal(found[0].resolvedPlan.protocol, 'package-manager');
});

test('manager ranks the full result table before bounded exact lookups', async () => {
  const product = { id: 'Northwind.Editor', name: 'Northwind Editor' },
    lookups = [];
  let searches = 0;
  const provider = searchProvider(async (_exe, args) => {
    if (args[0] === 'search') {
      searches++;
      return {
        code: 0,
        out: managerTable([
          ...Array.from({ length: 10 }, (_, index) => ({
            id: `Other.Unrelated${index}`,
            name: `Unrelated Product ${index}`,
          })),
          product,
        ]),
      };
    }
    const id = args[args.indexOf('--id') + 1];
    lookups.push(id);
    assert.equal(id, product.id);
    return { code: 0, out: managerDetails(product) };
  });
  assert.equal(
    (await provider.search({ product: product.name, operation: 'install' }))[0].id,
    product.id,
  );
  assert.equal(searches, 1);
  assert.deepEqual(lookups, [product.id]);
});

test('manager auto discovery pins host architecture and excludes packages with no applicable payload', async () => {
  const architecture = process.arch === 'arm64' ? 'arm64' : process.arch === 'ia32' ? 'x86' : 'x64',
    unavailable = { id: 'Northwind.ReaderLegacy', name: 'Northwind Reader Legacy' },
    compatible = { id: 'Northwind.ReaderNative', name: 'Northwind Reader Native' },
    lookups = [];
  const provider = searchProvider(async (_exe, args) => {
    if (args[0] === 'search') return { code: 0, out: managerTable([unavailable, compatible]) };
    const id = args[args.indexOf('--id') + 1];
    lookups.push(id);
    assert.equal(args[args.indexOf('--architecture') + 1], architecture);
    return {
      code: 0,
      out:
        id === unavailable.id
          ? `Found ${unavailable.name} [${unavailable.id}]\nVersion: 2.3.4\nPublisher: Northwind Corporation\nNo applicable installer found.`
          : managerDetails(compatible),
    };
  });
  const found = await provider.search({
    product: 'Northwind Reader',
    architecture: 'auto',
    operation: 'install',
  });
  assert.deepEqual(lookups, [unavailable.id, compatible.id]);
  assert.deepEqual(
    found.map((candidate) => candidate.id),
    [compatible.id],
  );
  assert.equal(found[0].resolvedPlan.architecture, architecture);
  await provider.show(compatible.id, { operation: 'install' });
  const explicit = searchProvider(async (_exe, args) => {
    assert.equal(args[args.indexOf('--architecture') + 1], 'x86');
    return { code: 0, out: managerDetails(unavailable) };
  });
  const identity = await explicit.show(unavailable.id, {
    operation: 'install',
    architecture: 'x86',
  });
  assert.equal(
    explicit.plan(identity, { operation: 'install', architecture: 'x86' }).architecture,
    'x86',
  );
});

test('manager fallback stays bounded when initial results lack relevant identities', async () => {
  const requested = 'Northwind Central Document Reader',
    products = Array.from({ length: 15 }, (_, index) => ({
      id: `Northwind.Reader${index}`,
      name: `Northwind Central Document Advanced Reader ${index}`,
    })),
    searches = [],
    lookups = [];
  const provider = searchProvider(async (_exe, args) => {
    if (args[0] === 'search') {
      const query = args[args.indexOf('--query') + 1];
      searches.push(query);
      return {
        code: 0,
        out: managerTable(
          query === requested ? [{ id: 'Other.Editor', name: 'Unrelated Editor' }] : products,
        ),
      };
    }
    const id = args[args.indexOf('--id') + 1];
    lookups.push(id);
    return { code: 0, out: managerDetails(products.find((product) => product.id === id)) };
  });
  const found = await provider.search({ product: requested, operation: 'install' });
  assert.equal(searches.length, 4);
  assert.deepEqual(searches.slice(1), ['northwind', 'document', 'central']);
  assert.equal(lookups.length, 8);
  assert.equal(new Set(lookups).size, 8);
  assert.equal(found.length, 8);
});

test('manager does not treat source errors or cancellation as empty token searches', async () => {
  let calls = 0;
  const provider = searchProvider(async (_exe, args) => {
    calls++;
    assert.equal(args[0], 'search');
    return { code: 0x8a15003a, out: 'Blocked by policy.' };
  });
  await assert.rejects(provider.search({ product: 'Northwind Reader', operation: 'install' }), {
    code: 'SOURCE_SEARCH_FAILED',
  });
  assert.equal(calls, 1);
  const controller = new AbortController();
  const cancelled = searchProvider(async () => {
    controller.abort();
    return { code: 0x8a150014, out: '' };
  });
  await executionContext.run({ signal: controller.signal }, async () =>
    assert.rejects(cancelled.search({ product: 'Northwind Reader', operation: 'install' }), {
      name: 'AbortError',
    }),
  );
});

test('manager verifies independently registered identity using the exact package row display name', async () => {
  const product = { id: 'Northwind.DocumentReader', name: 'Northwind Document Reader (64-bit)' },
    installedName = 'Northwind Reader (64-bit)',
    good = {
      id: 'registry-product-code',
      name: installedName,
      publisher: 'Northwind Corporation',
      version: '2.3.4.0',
    },
    provider = searchProvider(async (_exe, args) => {
      assert.equal(args[0], 'list');
      assert.equal(args[args.indexOf('--id') + 1], product.id);
      assert.equal(args[args.indexOf('--source') + 1], 'runtime-repo');
      assert.ok(args.includes('--exact'));
      return {
        code: 0,
        out: managerTable([{ id: product.id, name: installedName, version: '2.3.4' }]),
      };
    });
  provider.installedInventory = async () => ({
    entries: [
      { ...good, id: 'wrong-publisher', publisher: 'Other Corporation' },
      { ...good, id: 'wrong-version', version: '1.0.0' },
      { ...good, id: 'similar-name', name: `${installedName} Plus` },
      good,
    ],
  });
  const plan = provider.plan(
    {
      ...product,
      publisher: 'Northwind',
      version: '2.3.4',
      installerUrl: 'https://publisher.example/setup.exe',
      sha256: 'a'.repeat(64),
      installerType: 'exe',
      scope: 'user',
    },
    { operation: 'install' },
  );
  const found = await provider.inventory(plan);
  assert.deepEqual(found, [{ ...good, packageId: product.id }]);
});

test('manager inventory requires the pinned package id and version before registry corroboration', async () => {
  const product = { id: 'Northwind.DocumentReader', name: 'Northwind Document Reader' };
  let inventoryCalls = 0,
    row = { ...product, id: 'Other.DocumentReader', version: '2.3.4' };
  const provider = searchProvider(async () => ({ code: 0, out: managerTable([row]) }));
  provider.installedInventory = async () => {
    inventoryCalls++;
    return [{ ...product, publisher: 'Northwind Corporation', version: '2.3.4' }];
  };
  const plan = provider.plan(
    {
      ...product,
      publisher: 'Northwind Corporation',
      version: '2.3.4',
      installerUrl: 'https://publisher.example/setup.exe',
      sha256: 'a'.repeat(64),
      installerType: 'exe',
      scope: 'user',
    },
    { operation: 'install' },
  );
  assert.deepEqual(await provider.inventory(plan), []);
  row = { ...product, version: '1.0.0' };
  assert.deepEqual(await provider.inventory(plan), []);
  assert.equal(inventoryCalls, 0);
  await assert.rejects(
    provider.inventory({
      ...structuredClone(plan),
      installer: { ...structuredClone(plan.installer), source: 'different-repository' },
    }),
    { code: 'PACKAGE_SOURCE_CHANGED' },
  );
});

test('source search cancellation propagates and bounded search concurrency stays within three', async () => {
  const registry = new ProviderRegistry();
  let active = 0,
    peak = 0;
  for (let index = 0; index < 8; index++)
    registry.register(
      {
        id: `controlled-${index}`,
        descriptor: { kind: 'controlled-test' },
        capabilities: { offline: true, network: false },
        isAvailable: async () => true,
        search: async () => {
          peak = Math.max(peak, ++active);
          await new Promise((done) => setTimeout(done, 5));
          active--;
          return [];
        },
        resolve: async () => {},
      },
      { trusted: true },
    );
  await registry.searchAll({ product: 'Any Unknown Identity' });
  assert.equal(peak, 3);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    registry.searchAll({ product: 'Any Unknown Identity' }, { signal: controller.signal }),
    { name: 'AbortError' },
  );
});
