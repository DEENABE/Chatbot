import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import {
  InstallerExecutor,
  allowedInstallerAddress,
  runValidatedInstaller,
  downloadTrustedInstaller,
} from '../software/InstallerExecutor.js';
import { TrustPolicy, samePublisher } from '../software/TrustPolicy.js';
import { inspectInstaller, installerHash } from '../software/InstallerMetadata.js';
import { executionContext } from '../ExecutionContext.js';
import { WingetService } from '../services/WingetService.js';
import { WebInstallService } from '../services/WebInstallService.js';
import { ConfirmationGate } from '../ConfirmationGate.js';

const trust = new TrustPolicy({
  platform: 'win32',
  architecture: 'x64',
  windowsVersion: '10.0.22631',
});
const plan = () => ({
  schemaVersion: 1,
  operation: 'install',
  protocol: 'local-installer',
  product: {
    id: 'new-fixture',
    name: 'Previously Unknown Fixture',
    publisher: 'Fixture Publisher',
    version: '2.1',
  },
  source: {
    providerId: 'fixture-source',
    kind: 'local',
    origin: 'native selected file',
    trust: 'local-selection',
    publisher: 'Fixture Publisher',
    publisherTrust: { publishers: ['Fixture Publisher'] },
    allowedHosts: [],
    evidence: 'native-selection',
  },
  architecture: 'x64',
  platform: { os: 'windows' },
  installer: { format: 'exe', path: 'C:\\fixture\\setup.exe', sha256: 'a'.repeat(64) },
  privileges: 'user',
  license: { required: 'unknown' },
  reboot: 'possible',
  dependencies: [],
});
const metadata = () => ({
  format: 'exe',
  status: 'Valid',
  publisher: 'Fixture Publisher',
  signerSubject: 'O=Fixture Publisher',
  productName: 'Previously Unknown Fixture',
  productVersion: '2.1.0',
  architecture: 'x64',
  sha256: 'a'.repeat(64),
  size: 123,
  elevation: 'asInvoker',
  privileges: 'user',
  dependencies: [],
  capabilities: [],
  restrictedCapabilities: [],
});
const repositoryPlan = ({ payload = true } = {}) => {
  const p = plan();
  p.protocol = 'package-manager';
  p.source.kind = 'package-manager';
  p.source.origin = 'https://repository.fixture.invalid';
  p.source.evidence = 'platform-repository';
  p.source.repository = 'fixture-repository';
  p.source.allowedHosts = ['downloads.fixture.invalid'];
  p.installer = {
    format: payload ? 'exe' : 'manager',
    payloadFormat: 'exe',
    manager: p.source.providerId,
    source: 'fixture-repository',
    packageId: p.product.id,
    sha256: 'a'.repeat(64),
    url: 'https://downloads.fixture.invalid/setup.exe',
  };
  return p;
};
const wrapperMetadata = () => ({
  ...metadata(),
  publisher: 'Fixture Publisher, Inc.',
  productName: 'Fixture Installation Bootstrapper',
  productVersion: '0.9.37',
  architecture: 'x86',
  signerThumbprint: '1'.repeat(40),
});
const approved = (callback) =>
  executionContext.run(
    {
      authenticated: true,
      scope: 'renderer:fixture',
      taskId: 'fixture-task',
      origin: 'operator',
      modelRoute: 'windows',
      humanApproved: true,
    },
    callback,
  );
const inventory = () => [
  {
    name: 'Previously Unknown Fixture',
    publisher: 'Fixture Publisher',
    version: '2.1.0',
    available: true,
  },
];

test('unknown software uses generic typed execution and independent publisher/version inventory', async () => {
  let executions = 0,
    inspections = 0;
  const executor = new InstallerExecutor({
    trust,
    inspect: async () => {
      inspections++;
      return metadata();
    },
    run: async (p) => {
      assert.equal(p.product.name, 'Previously Unknown Fixture');
      executions++;
      return { code: 0 };
    },
    inventory: async () => (executions ? inventory() : []),
    waits: [0],
  });
  const result = await approved(() => executor.install(plan()));
  assert.equal(executions, 1);
  assert.equal(inspections, 1);
  assert.equal(result.success, true);
  assert.equal(result.status, 'INSTALLED');
  assert.equal(result.verification.status, 'verified');
});
test('no installation approval prevents inspection and execution', async () => {
  let work = 0;
  const executor = new InstallerExecutor({
    trust,
    inspect: async () => {
      work++;
      return metadata();
    },
    run: async () => {
      work++;
      return { code: 0 };
    },
  });
  await assert.rejects(executor.install(plan()), { code: 'HUMAN_APPROVAL_REQUIRED' });
  assert.equal(work, 0);
  await assert.rejects(runValidatedInstaller(plan()), { code: 'HUMAN_APPROVAL_REQUIRED' });
});

test('publisher legal suffix equivalence is explicit, bounded and never matches an empty identity', () => {
  assert.equal(samePublisher(' FIXTURE PUBLISHER ', 'Fixture Publisher'), true);
  assert.equal(samePublisher('Fixture Publisher, Inc.', 'Fixture Publisher'), false);
  for (const actual of [
    'Fixture Publisher, Inc.',
    'Fixture Publisher Corporation',
    'Fixture Publisher Ltd.',
    'CN=Signing Certificate, O="Fixture Publisher, Inc.", C=US',
  ]) {
    assert.equal(samePublisher(actual, 'Fixture Publisher', { allowLegalSuffix: true }), true, actual);
  }
  for (const [actual, expected] of [
    ['Other Publisher Inc.', 'Fixture Publisher'],
    ['Fixture Publisher Software Inc.', 'Fixture Publisher'],
    ['Untrusted Fixture Publisher Inc.', 'Fixture Publisher'],
    ['Fixture Publishers Inc.', 'Fixture Publisher'],
    ['', 'Fixture Publisher'],
    ['Fixture Publisher', ''],
    ['', ''],
    ['Inc.', 'LLC'],
  ]) {
    assert.equal(samePublisher(actual, expected, { allowLegalSuffix: true }), false, actual);
  }
});

test('repository-pinned signed wrapper accepts catalog and legal publisher naming differences', () => {
  const p = repositoryPlan();
  p.source.publisherTrust.signatureThumbprints = ['1'.repeat(40)];
  const verified = trust.verifyRepositoryInstaller(p, wrapperMetadata());
  assert.equal(verified.publisher, 'Fixture Publisher, Inc.');
  assert.equal(verified.productName, 'Fixture Installation Bootstrapper');
  assert.equal(verified.productVersion, '0.9.37');
  assert.equal(verified.architecture, 'x86');
  const signedSubject = wrapperMetadata();
  delete signedSubject.publisher;
  signedSubject.signerSubject = 'CN=Signing Certificate, O="Fixture Publisher, Inc.", C=US';
  assert.equal(trust.verifyRepositoryInstaller(p, signedSubject).publisher, 'Fixture Publisher, Inc.');
});

test('repository wrapper exceptions preserve checksum, signature, publisher, signer and platform restrictions', () => {
  const p = repositoryPlan();
  p.source.publisherTrust.signatureThumbprints = ['1'.repeat(40)];
  for (const [mutation, code] of [
    [{ sha256: 'b'.repeat(64) }, 'HASH_MISMATCH'],
    [{ sha256: undefined }, 'HASH_MISMATCH'],
    [{ status: 'NotSigned' }, 'SIGNATURE_INVALID'],
    [{ status: 'HashMismatch' }, 'SIGNATURE_INVALID'],
    [{ publisher: 'Different Publisher Inc.' }, 'PUBLISHER_MISMATCH'],
    [{ publisher: 'Fixture Publisher Software Inc.' }, 'PUBLISHER_MISMATCH'],
    [{ signerThumbprint: '2'.repeat(40) }, 'SIGNER_MISMATCH'],
    [{ signerThumbprint: undefined }, 'SIGNER_MISMATCH'],
    [{ architecture: 'arm64' }, 'ARCHITECTURE_MISMATCH'],
    [{ architecture: undefined }, 'ARCHITECTURE_UNVERIFIED'],
    [{ architecture: 'unknown' }, 'ARCHITECTURE_UNVERIFIED'],
    [{ elevation: 'requireAdministrator' }, 'ELEVATION_CHANGED'],
    [{ elevation: 'administrator' }, 'ELEVATION_CHANGED'],
    [{ format: 'msi' }, 'INSTALLER_FORMAT_MISMATCH'],
    [{ minimumWindowsVersion: '10.0.99999' }, 'WINDOWS_VERSION_MISMATCH'],
    [{ restrictedCapabilities: ['broadFileSystemAccess'] }, 'PACKAGE_CAPABILITY_APPROVAL_REQUIRED'],
  ]) {
    assert.throws(
      () => trust.verifyRepositoryInstaller(p, { ...wrapperMetadata(), ...mutation }),
      { code },
      JSON.stringify(mutation),
    );
  }
  const unsupportedPlan = repositoryPlan();
  unsupportedPlan.architecture = 'arm64';
  assert.throws(() => trust.verifyRepositoryInstaller(unsupportedPlan, wrapperMetadata()), {
    code: 'ARCHITECTURE_MISMATCH',
  });
  const unapprovedHost = repositoryPlan();
  unapprovedHost.installer.url = 'https://other.fixture.invalid/setup.exe';
  assert.throws(() => trust.verifyRepositoryInstaller(unapprovedHost, wrapperMetadata()), {
    code: 'UNAPPROVED_ORIGIN',
  });
});

test('wrapper naming exceptions require repository, exact manager and package identities, and a published digest', () => {
  for (const mutate of [
    (p) => (p.protocol = 'local-installer'),
    (p) => (p.source.kind = 'local'),
    (p) => (p.source.evidence = 'native-selection'),
    (p) => delete p.source.repository,
    (p) => (p.source.repository = ''),
    (p) => delete p.installer.source,
    (p) => delete p.installer.manager,
    (p) => (p.installer.manager = 'other-source'),
    (p) => {
      delete p.installer.manager;
      delete p.source.providerId;
    },
    (p) => delete p.installer.packageId,
    (p) => (p.installer.packageId = 'Other.Product'),
    (p) => {
      delete p.installer.packageId;
      delete p.product.id;
    },
    (p) => delete p.installer.payloadFormat,
    (p) => (p.installer.payloadFormat = 'msi'),
    (p) => delete p.installer.sha256,
    (p) => (p.installer.sha256 = 'not-a-published-digest'),
    (p) => (p.installer.sha256 = 'a'.repeat(63)),
  ]) {
    const p = repositoryPlan();
    mutate(p);
    assert.throws(() => trust.verifyRepositoryInstaller(p, wrapperMetadata()), {
      code: 'PACKAGE_IDENTITY_UNVERIFIED',
    });
  }
});

test('local installer verification retains exact product, version, publisher and architecture requirements', () => {
  assert.doesNotThrow(() => trust.verifyInstaller(plan(), metadata()));
  for (const [mutation, code] of [
    [{ productName: 'Fixture Installation Bootstrapper' }, 'PACKAGE_IDENTITY_MISMATCH'],
    [{ productName: undefined, packageIdentity: undefined }, 'PACKAGE_IDENTITY_UNVERIFIED'],
    [{ productVersion: '0.9.37' }, 'VERSION_MISMATCH'],
    [{ publisher: 'Fixture Publisher Inc.' }, 'PUBLISHER_MISMATCH'],
    [{ architecture: 'x86' }, 'ARCHITECTURE_MISMATCH'],
  ]) {
    assert.throws(() => trust.verifyInstaller(plan(), { ...metadata(), ...mutation }), { code });
  }
  // A manager plan passed through the strict verifier must not gain wrapper exceptions.
  assert.throws(() => trust.verifyInstaller(repositoryPlan(), wrapperMetadata()), {
    code: 'PUBLISHER_MISMATCH',
  });
});

test('manager execution verifies legal publisher inventory only with the exact package identity and version', async () => {
  const p = repositoryPlan({ payload: false });
  let executions = 0;
  const adapter = {
    prepare: async () => ({ ...p.product, sha256: p.installer.sha256 }),
    execute: async () => {
      executions++;
      return { code: 0 };
    },
    inventory: async () =>
      executions
        ? [{ ...inventory()[0], packageId: p.product.id, publisher: 'Fixture Publisher Inc.' }]
        : [],
  };
  const executor = new InstallerExecutor({
    trust,
    managerAdapters: new Map([[p.installer.manager, adapter]]),
    inspect: async () => assert.fail('manager execution uses the registered adapter'),
    run: async () => assert.fail('manager execution uses the registered adapter'),
    waits: [0],
  });
  const result = await approved(() => executor.install(p));
  assert.equal(executions, 1);
  assert.equal(result.success, true);
  assert.equal(result.status, 'INSTALLED');
  assert.equal(result.verification.status, 'verified');
  assert.equal(result.verification.criterion, 'provider_inventory');
  assert.equal(result.verification.identity.publisher, 'Fixture Publisher Inc.');
  for (const mutation of [
    { packageId: 'Other.Product' },
    { version: '9.0' },
    { publisher: 'Other Publisher Inc.' },
    { publisher: '' },
  ]) {
    adapter.inventory = async () => [
      { ...inventory()[0], packageId: p.product.id, publisher: 'Fixture Publisher Inc.', ...mutation },
    ];
    assert.equal((await executor.verify(p)).status, 'unverified', JSON.stringify(mutation));
  }
  const local = new InstallerExecutor({
    trust,
    inventory: async () => [{ ...inventory()[0], publisher: 'Fixture Publisher Inc.' }],
  });
  assert.equal((await local.verify(plan())).status, 'unverified');
});
test('exit zero and empty or different publisher/version inventory never become installed', async () => {
  for (const items of [
    [],
    [{ ...inventory()[0], publisher: 'Other Publisher' }],
    [{ ...inventory()[0], version: '1.0' }],
  ]) {
    const executor = new InstallerExecutor({
      trust,
      inspect: async () => metadata(),
      run: async () => ({ code: 0 }),
      inventory: async () => items,
      waits: [0],
    });
    const result = await approved(() => executor.install(plan()));
    assert.equal(result.success, false);
    assert.equal(result.status, 'INSTALL_UNVERIFIED');
    assert.equal(result.verification.status, 'unverified');
  }
});
test('reboot receipt stays pending even if current inventory matches', async () => {
  let ran = false;
  const executor = new InstallerExecutor({
    trust,
    inspect: async () => metadata(),
    run: async () => {
      ran = true;
      return { code: 3010 };
    },
    inventory: async () => (ran ? inventory() : []),
    waits: [0],
  });
  const result = await approved(() => executor.install(plan()));
  assert.equal(result.success, false);
  assert.equal(result.status, 'INSTALL_PENDING_RESTART');
  assert.equal(result.needsReboot, true);
});
test('controlled installer failure, UAC cancellation, timeout and uncertainty retain truthful status', async () => {
  for (const [receipt, status] of [
    [{ code: 1603 }, 'INSTALL_FAILED'],
    [{ code: 1223 }, 'INSTALL_CANCELLED'],
    [{ code: null, timedOut: true }, 'INSTALL_TIMEOUT'],
    [{ code: null, cancelled: true, uncertain: true }, 'EXECUTION_UNCERTAIN'],
  ]) {
    let reads = 0;
    const executor = new InstallerExecutor({
      trust,
      inspect: async () => metadata(),
      run: async () => receipt,
      inventory: async () => {
        reads++;
        return [];
      },
      waits: [0],
    });
    const result = await approved(() => executor.install(plan()));
    assert.equal(result.success, false);
    assert.equal(result.status, status);
    assert.equal(reads, 1);
  }
});
test('origin appearance, unknown publisher and raw shell fields cannot establish trust', () => {
  const unapproved = plan();
  unapproved.source.evidence = 'name-looks-official';
  assert.throws(() => trust.assertPlan(unapproved), { code: 'SOURCE_NOT_APPROVED' });
  const unknown = plan();
  unknown.product.publisher = '';
  assert.throws(() => trust.assertPlan(unknown), { code: 'PUBLISHER_UNVERIFIED' });
  const command = plan();
  command.installer.arguments = ['/run', 'remote.ps1'];
  assert.throws(() => trust.assertPlan(command), { code: 'UNTRUSTED_EXECUTION_ARGUMENTS' });
  const remote = plan();
  remote.installer.url = 'https://product-looking.attacker.invalid/setup.exe';
  remote.source.allowedHosts = ['approved.fixture.invalid'];
  assert.throws(() => trust.assertPlan(remote), { code: 'UNAPPROVED_ORIGIN' });
});
test('signature, expected publisher, hash, version, architecture and privilege changes are rejected before runner', async () => {
  for (const [mutation, code] of [
    [{ status: 'NotSigned' }, 'SIGNATURE_INVALID'],
    [{ publisher: 'Different Publisher' }, 'PUBLISHER_MISMATCH'],
    [{ sha256: 'b'.repeat(64) }, 'HASH_MISMATCH'],
    [{ productVersion: '3.0' }, 'VERSION_MISMATCH'],
    [{ architecture: 'arm64' }, 'ARCHITECTURE_MISMATCH'],
    [{ elevation: 'requireAdministrator' }, 'ELEVATION_CHANGED'],
    [{ restrictedCapabilities: ['broadFileSystemAccess'] }, 'PACKAGE_CAPABILITY_APPROVAL_REQUIRED'],
  ]) {
    let runs = 0;
    const executor = new InstallerExecutor({
      trust,
      inspect: async () => ({ ...metadata(), ...mutation }),
      run: async () => {
        runs++;
        return { code: 0 };
      },
    });
    await assert.rejects(
      approved(() => executor.install(plan())),
      { code },
    );
    assert.equal(runs, 0);
  }
});
test('declared package dependencies require independent installed publisher and minimum version', async () => {
  const p = plan();
  p.installer.format = 'msix';
  p.installer.path = 'C:\\fixture\\setup.msix';
  const m = {
    ...metadata(),
    format: 'msix',
    dependencies: [
      { name: 'Unknown.Framework', publisher: 'Fixture Publisher', minimumVersion: '4.0' },
    ],
  };
  let runs = 0;
  const executor = new InstallerExecutor({
    trust,
    inspect: async () => m,
    run: async () => {
      runs++;
      return { code: 0 };
    },
    inventory: async () => [],
    waits: [0],
  });
  await assert.rejects(
    approved(() => executor.install(p)),
    { code: 'DEPENDENCIES_REQUIRED' },
  );
  assert.equal(runs, 0);
  executor.inventory = async () => [
    ...(runs ? inventory() : []),
    { packageIdentity: 'Unknown.Framework', publisher: 'Fixture Publisher', version: '4.1' },
  ];
  assert.equal((await approved(() => executor.install(p))).success, true);
  assert.equal(runs, 1);
});
test('OS and download-only plans cannot execute installation', async () => {
  const executor = new InstallerExecutor({
    trust,
    inspect: async () => metadata(),
    run: async () => assert.fail('must not execute'),
  });
  const osPlan = plan();
  osPlan.scope = 'operating-system';
  await assert.rejects(
    approved(() => executor.install(osPlan)),
    { code: 'OS_EXECUTION_BLOCKED' },
  );
  const download = plan();
  download.operation = 'download';
  await assert.rejects(
    approved(() => executor.install(download)),
    { code: 'INSTALL_ACTION_NOT_ALLOWED' },
  );
});
test('an exact installed identity is reported already present without rerunning software', async () => {
  let runs = 0;
  const executor = new InstallerExecutor({
    trust,
    inspect: async () => metadata(),
    run: async () => {
      runs++;
      return { code: 0 };
    },
    inventory: async () => inventory(),
    waits: [0],
  });
  const result = await approved(() => executor.install(plan()));
  assert.equal(result.status, 'ALREADY_INSTALLED');
  assert.equal(result.verification.status, 'verified');
  assert.equal(runs, 0);
});
test('private origin exceptions apply only to approved enterprise networks and never metadata/loopback', () => {
  for (const address of ['10.20.30.40', '172.20.1.2', '192.168.1.2', 'fd00::123', '::ffff:a14:1']) {
    assert.equal(allowedInstallerAddress(address), false);
    assert.equal(allowedInstallerAddress(address, 'enterprise'), true);
  }
  for (const address of [
    '127.0.0.1',
    '169.254.169.254',
    '::1',
    'fe80::1',
    '224.1.2.3',
    '192.0.2.1',
    '::ffff:127.0.0.1',
  ]) {
    assert.equal(allowedInstallerAddress(address, 'enterprise'), false);
  }
  assert.equal(allowedInstallerAddress('8.8.8.8'), true);
});
test('cancelled network download never resolves DNS or starts a request', async () => {
  const controller = new AbortController();
  controller.abort();
  let lookups = 0;
  const p = plan();
  p.protocol = 'download';
  delete p.installer.path;
  p.installer.url = 'https://approved.fixture.invalid/setup.exe';
  p.source.allowedHosts = ['approved.fixture.invalid'];
  await executionContext.run({ signal: controller.signal }, () =>
    assert.rejects(
      downloadTrustedInstaller(p, 'unused-fixture-directory', {
        trust,
        resolve: async () => {
          lookups++;
          return [{ address: '8.8.8.8', family: 4 }];
        },
      }),
      { name: 'AbortError' },
    ),
  );
  assert.equal(lookups, 0);
});
test('application downloads accept distributions over 800 MiB and reject headers over 2 GiB before staging', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chanakya-download-limit-'));
  const bytes = Buffer.from('small controlled installer fixture');
  const declaredSizes = [900 * 1024 * 1024, 2 * 1024 * 1024 * 1024 + 1];
  const responses = [];
  let requests = 0,
    lookups = 0;
  const get = t.mock.method(https, 'get', (url, options, receive) => {
    assert.equal(url.hostname, 'approved.fixture.invalid');
    assert.equal(typeof options.lookup, 'function');
    const response = Readable.from([bytes]);
    response.statusCode = 200;
    response.headers = {
      'content-type': 'application/octet-stream',
      'content-length': String(declaredSizes[requests++]),
    };
    responses.push(response);
    const request = new EventEmitter();
    queueMicrotask(() => receive(response));
    return request;
  });
  try {
    const p = plan();
    p.protocol = 'download';
    delete p.installer.path;
    p.installer.url = 'https://approved.fixture.invalid/setup.exe';
    p.source.allowedHosts = ['approved.fixture.invalid'];
    p.installer.sha256 = createHash('sha256').update(bytes).digest('hex');
    const options = {
      trust,
      resolve: async (host, settings) => {
        lookups++;
        assert.equal(host, 'approved.fixture.invalid');
        assert.equal(settings.all, true);
        return [{ address: '8.8.8.8', family: 4 }];
      },
    };
    const accepted = await downloadTrustedInstaller(p, path.join(root, 'accepted'), options);
    assert.equal(accepted.size, bytes.length);
    assert.equal(accepted.sha256, p.installer.sha256);
    assert.deepEqual(fs.readFileSync(accepted.file), bytes);
    const rejectedDirectory = path.join(root, 'rejected');
    await assert.rejects(downloadTrustedInstaller(p, rejectedDirectory, options), {
      code: 'DOWNLOAD_TOO_LARGE',
    });
    assert.equal(fs.existsSync(rejectedDirectory), false);
    assert.equal(responses[1].destroyed, true);
    assert.equal(requests, 2);
    assert.equal(lookups, 2);
  } finally {
    get.mock.restore();
    for (const response of responses) response.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('download quarantine pins bytes and preserves future installation approval boundaries', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chanakya-executor-fixture-'));
  try {
    const selected = path.join(root, 'source.exe');
    fs.writeFileSync(selected, 'controlled unsigned fixture bytes');
    const p = plan();
    p.installer.path = selected;
    p.installer.sha256 = await installerHash(selected);
    p.privileges = 'unknown';
    const executor = new InstallerExecutor({
      root: path.join(root, 'quarantine'),
      trust,
      inspect: async (file) => ({
        ...metadata(),
        sha256: await installerHash(file),
        elevation: 'requireAdministrator',
        privileges: 'administrator',
        size: fs.statSync(file).size,
      }),
      run: async () => assert.fail('download cannot execute'),
    });
    const result = await executor.download(p);
    assert.equal(result.status, 'DOWNLOADED_VERIFIED');
    assert.equal(result.plan.privileges, 'administrator');
    assert.notEqual(result.plan.installer.path, selected);
    fs.appendFileSync(result.plan.installer.path, 'changed');
    await assert.rejects(
      approved(() => executor.install(result.plan)),
      { code: 'HASH_MISMATCH' },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('format-specific inspector parses metadata without executing fixture bytes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chanakya-metadata-fixture-'));
  try {
    const file = path.join(root, 'fixture.msi');
    fs.writeFileSync(file, 'controlled MSI metadata fixture');
    let calls = 0;
    const result = await inspectInstaller(file, 'msi', {
      run: async (p, format) => {
        calls++;
        assert.equal(p, file);
        assert.equal(format, 'msi');
        return {
          ...metadata(),
          format: 'msi',
          signerSubject: 'CN=Fixture Publisher, O=Fixture Publisher',
          productVersion: '2.1',
          packageIdentity: '{AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA}',
        };
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.publisher, 'Fixture Publisher');
    assert.equal(result.format, 'msi');
    assert.equal(result.sha256.length, 64);
    assert.equal(result.productId, '{AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA}');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('legacy winget exit zero without independent exact version verification is unverified', async () => {
  const info = {
    id: 'Fixture.Unknown',
    name: 'Unknown',
    version: '2.1',
    publisher: 'Fixture Publisher',
    source: 'winget',
    installerUrl: 'https://fixture.invalid/setup.exe',
    installerSha256: 'a'.repeat(64),
  };
  const service = new WingetService(new ConfirmationGate(), {
    run: async (args) =>
      args[0] === 'show'
        ? {
            code: 0,
            out: `Found ${info.name} [${info.id}]\nVersion: ${info.version}\nPublisher: ${info.publisher}\nInstaller Url: ${info.installerUrl}\nInstaller SHA256: ${info.installerSha256}`,
          }
        : { code: 0, out: '' },
  });
  const result = await executionContext.run({ packageIdentity: info }, () =>
    service.install({ packageId: info.id }),
  );
  assert.equal(result.success, false);
  assert.equal(result.status, 'INSTALL_UNVERIFIED');
  assert.equal(result.verification.status, 'unverified');
});
test('legacy web search clues never authorize a download', async () => {
  let downloads = 0;
  const service = new WebInstallService(new ConfirmationGate(), {
    download: async () => {
      downloads++;
    },
  });
  service.candidates.set('a'.repeat(16), {
    owner: 'renderer:fixture',
    official: true,
    url: 'https://product-looking.invalid/setup.exe',
    query: 'Unknown',
  });
  await executionContext.run({ scope: 'renderer:fixture' }, () =>
    assert.rejects(service.downloadCandidate({ candidateId: 'a'.repeat(16) }), {
      code: 'SOURCE_NOT_APPROVED',
    }),
  );
  assert.equal(downloads, 0);
});
