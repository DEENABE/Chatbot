import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { SoftwareService } from '../services/SoftwareService.js';
import { ProviderRegistry } from '../software/ProviderRegistry.js';
import { SoftwarePlanStore } from '../software/SoftwarePlanStore.js';
import { InstallerExecutor } from '../software/InstallerExecutor.js';
import { ConfirmationGate } from '../ConfirmationGate.js';
import { executionContext } from '../ExecutionContext.js';
import { createToolRegistry } from '../security/ToolRegistry.js';
import { ToolPermissionPolicy } from '../security/ToolPermissionPolicy.js';
import { OfflineInstallerProvider } from '../software/providers/OfflineProvider.js';
import {
  discoverDefaultProviders,
  StoreHandoffProvider,
} from '../software/providers/discoverDefaultProviders.js';

const owner = randomUUID(),
  otherOwner = randomUUID(),
  scope = `renderer:${owner}-3`;
const context = {
  authenticated: true,
  scope,
  origin: 'model',
  modelRoute: 'windows',
  taskId: 'software-fixture-task',
};
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chanakya-software-service-'));
const key = randomBytes(32),
  name = `Future Discovery Product ${randomUUID().slice(0, 8)}`,
  publisher = 'Fixture Publisher',
  version = '4.2.1';
const file = path.join(root, 'fixture.exe');
await fs.writeFile(file, Buffer.from([77, 90, 0, 0, 0, 0]));
const metadata = {
  format: 'exe',
  status: 'Valid',
  productName: name,
  productVersion: version,
  publisher,
  signerSubject: `O=${publisher}`,
  signerThumbprint: 'a'.repeat(40),
  sha256: 'b'.repeat(64),
  size: 6,
  architecture: 'x64',
  elevation: 'asInvoker',
  dependencies: [],
  capabilities: [],
};
const makePlan = (p = publisher, operation = 'install') => ({
  schemaVersion: 1,
  operation,
  protocol: 'local-installer',
  product: { id: name, name, publisher: p, version },
  source: {
    providerId: 'fixture-new-provider',
    kind: 'local',
    origin: 'Native selected fixture',
    trust: 'local-selection',
    publisher: p,
    allowedHosts: [],
    publisherTrust: { publishers: [p] },
    evidence: 'native-selection',
  },
  architecture: 'x64',
  platform: { os: 'windows' },
  installer: { format: 'exe', path: file, sha256: metadata.sha256, size: 6 },
  privileges: 'user',
  license: { required: false },
  reboot: 'none',
  dependencies: [],
});
let installRuns = 0,
  freshInventory = [],
  onlineCalls = 0;
function service({ ambiguous = false, online = false, handoff = false } = {}) {
  const registry = new ProviderRegistry();
  registry.register(
    {
      id: 'fixture-new-provider',
      capabilities: { offline: !online, network: online },
      descriptor: { kind: 'local', name: 'New test adapter', origin: 'Native selected fixture' },
      isAvailable: async () => true,
      search: async (query) => {
        if (online) onlineCalls++;
        return [publisher, ...(ambiguous ? ['Other Fixture Publisher'] : [])].map((p) => ({
          providerId: 'fixture-new-provider',
          id: name,
          name,
          publisher: p,
          version,
          architecture: 'x64',
          trust: 'local-selection',
          identityVerified: true,
          query,
          resolvedPlan: makePlan(p, query.operation),
        }));
      },
      resolve: async (candidate) => candidate.resolvedPlan,
    },
    { trusted: true },
  );
  if (handoff) registry.register(new StoreHandoffProvider(), { trusted: true });
  const gate = new ConfirmationGate();
  const result = new SoftwareService(gate, {
    directory: path.join(root, randomUUID()),
    key,
    providerFactory: async () => ({ registry, managerAdapters: new Map(), diagnostics: [] }),
    inspect: async () => metadata,
    executorFactory: (options) =>
      new InstallerExecutor({
        ...options,
        inspect: async () => metadata,
        run: async () => {
          installRuns++;
          return { code: 0 };
        },
        inventory: async () => freshInventory,
        refresh: async () => {},
        waits: [0],
      }),
  });
  return { result, gate };
}
test.after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
test('persistent software handles bind account, authenticated bytes and expiry across windows/restart', () => {
  const store = new SoftwarePlanStore({
    directory: path.join(root, 'persist'),
    key,
    now: () => 100,
  });
  const id = store.put('plan', scope, { fixture: true }, { expiresAt: 200 });
  assert.deepEqual(
    new SoftwarePlanStore({ directory: path.join(root, 'persist'), key, now: () => 101 }).get(
      'plan',
      `renderer:${owner}-5`,
      id,
    ),
    { fixture: true },
  );
  assert.throws(() => store.get('plan', `renderer:${otherOwner}-3`, id));
  assert.throws(() =>
    new SoftwarePlanStore({ directory: path.join(root, 'persist'), key, now: () => 201 }).get(
      'plan',
      scope,
      id,
    ),
  );
});
test('MAC tampering is rejected and API credentials are encrypted rather than saved or returned in clear', async () => {
  const store = new SoftwarePlanStore({ directory: path.join(root, 'secrets'), key });
  const credential = 'test-only-secret-token';
  const id = store.put('configuration', scope, { credential: store.sealSecret(credential) });
  const target = store.filename(id),
    raw = await fs.readFile(target, 'utf8');
  assert.equal(raw.includes(credential), false);
  assert.equal(store.openSecret(store.get('configuration', scope, id).credential), credential);
  const altered = JSON.parse(raw);
  altered.payload = altered.payload.replace('configuration', 'plan');
  await fs.writeFile(target, JSON.stringify(altered));
  assert.throws(() => store.get('configuration', scope, id), { code: 'SOFTWARE_RECORD_INVALID' });
});
test('a previously unknown arbitrary fixture product resolves through a new adapter with zero installations', async () =>
  executionContext.run(context, async () => {
    const { result } = service(),
      discovered = await result.discover({ operation: 'install', product: name }, false);
    assert.equal(discovered.candidates.length, 1);
    assert.equal(discovered.selectedCandidateId, discovered.candidates[0].candidateId);
    const plan = await result.resolve(discovered.selectedCandidateId);
    assert.equal(plan.status, 'PLAN_READY');
    assert.equal(plan.plan.name, name);
    assert.equal(plan.plan.publisher, publisher);
    assert.equal(installRuns, 0);
    const proposal = await result.execute('install', { planId: plan.plan.planId });
    assert.equal(proposal.needsConfirmation, true);
    assert.equal(installRuns, 0);
  }));
test('ambiguous identities cannot resolve from forged model selection; a direct user choice remains discovery-bound', async () =>
  executionContext.run(context, async () => {
    const { result } = service({ ambiguous: true }),
      discovered = await result.discover({ operation: 'install', product: name }, false);
    assert.equal(discovered.requiresChoice, true);
    await assert.rejects(result.resolve(discovered.candidates[0].candidateId), {
      code: 'SOFTWARE_SELECTION_REQUIRED',
    });
    assert.throws(
      () => result.chooseCandidate(discovered.discoveryId, discovered.candidates[0].candidateId),
      { code: 'HUMAN_CHOICE_REQUIRED' },
    );
    const candidate = discovered.candidates[0];
    executionContext.run({ ...context, origin: 'operator', humanApproved: true }, () =>
      result.chooseCandidate(discovered.discoveryId, candidate.candidateId),
    );
    assert.equal((await result.resolve(candidate.candidateId)).plan.publisher, candidate.publisher);
    assert.throws(
      () =>
        executionContext.run({ ...context, origin: 'operator', humanApproved: true }, () =>
          result.chooseCandidate(discovered.discoveryId, discovered.candidates[1].candidateId),
        ),
      { code: 'SOFTWARE_CHOICE_USED' },
    );
  }));
test('online lookup first requests permission and a denied request performs no network work', async () =>
  executionContext.run(context, async () => {
    const { result, gate } = service({ online: true });
    onlineCalls = 0;
    const offline = await result.execute('discover', {
      query: { product: name, operation: 'install' },
    });
    assert.equal(offline.data.requiresOnline, true);
    assert.equal(onlineCalls, 0);
    const pending = await result.execute('discoverOnline', {
      query: { product: name, operation: 'install' },
    });
    assert.equal(pending.needsConfirmation, true);
    gate.cancel(pending.confirmationId);
    assert.equal(onlineCalls, 0);
    await assert.rejects(result.discover({ product: name }, true), {
      code: 'NETWORK_APPROVAL_REQUIRED',
    });
  }));
test('offline catalog handoff cannot stop discovery before eligible online installers are searched', async () =>
  executionContext.run(context, async () => {
    const { result } = service({ online: true, handoff: true });
    onlineCalls = 0;
    const offline = await result.discover({ product: name }, false);
    assert.equal(offline.requiresOnline, true);
    assert.equal(offline.candidates.length, 0);
    assert.equal(offline.handoffs.length, 1);
    assert.equal(onlineCalls, 0);
    const online = await executionContext.run({ ...context, humanApproved: true }, () =>
      result.discover({ product: name }, true),
    );
    assert.equal(onlineCalls, 1);
    const selected = online.candidates.find(
      (candidate) => candidate.candidateId === online.selectedCandidateId,
    );
    assert.equal(selected.handoff, false);
    assert.equal((await result.resolve(selected.candidateId)).status, 'PLAN_READY');
  }));
test('handoff discovery and resolution report provider diagnostics and actionable recovery', async () =>
  executionContext.run(context, async () => {
    const result = new SoftwareService(new ConfirmationGate(), {
      directory: path.join(root, randomUUID()),
      key,
      providerFactory: (options) =>
        discoverDefaultProviders({ ...options, probeManagers: async () => [] }),
    });
    const found = await result.discover({ product: name }, false);
    assert.ok(found.failures.some((item) => item.status === 'MANAGER_UNAVAILABLE'));
    assert.match(found.message, /App Installer/);
    const resolved = await result.resolve(found.selectedCandidateId);
    assert.equal(resolved.status, 'HANDOFF_REQUIRED');
    assert.match(resolved.message, /App Installer/);
    assert.match(resolved.message, /signed local installer/);
  }));
test('controlled signed fixture installation succeeds only with fresh identity/publisher/version evidence', async () =>
  executionContext.run(context, async () => {
    const { result, gate } = service();
    const found = await result.discover({ product: name }, false),
      resolved = await result.resolve(found.selectedCandidateId),
      planId = resolved.plan.planId;
    freshInventory = [];
    installRuns = 0;
    const pending = await result.execute('install', { planId }),
      snapshot = gate.getRecord(pending.confirmationId).metadata;
    const unverified = await executionContext.run({ ...context, humanApproved: true }, () =>
      result.executeConfirmed('install', { planId }, snapshot),
    );
    assert.equal(unverified.success, false);
    assert.equal(unverified.data.status, 'INSTALL_UNVERIFIED');
    assert.equal(installRuns, 1);
    freshInventory = [{ name, publisher, version }];
    const again = await result.execute('install', { planId });
    const verified = await executionContext.run({ ...context, humanApproved: true }, () =>
      result.executeConfirmed('install', { planId }, gate.getRecord(again.confirmationId).metadata),
    );
    assert.equal(verified.success, true);
    assert.equal(verified.data.verification.status, 'verified');
    assert.equal((await result.perform('verify', planId)).status, 'INSTALL_VERIFIED');
    freshInventory = [];
  }));
test('download-only plans and tampered approval digests cannot execute installers', async () =>
  executionContext.run(context, async () => {
    const { result } = service();
    const found = await result.discover({ product: name }, false),
      resolved = await result.resolve(found.selectedCandidateId),
      planId = resolved.plan.planId;
    await assert.rejects(
      executionContext.run({ ...context, humanApproved: true }, () =>
        result.executeConfirmed(
          'install',
          { planId },
          { softwarePlanId: planId, softwarePlanDigest: 'tampered' },
        ),
      ),
      { code: 'SOFTWARE_PLAN_CHANGED' },
    );
  }));
test('operator source enrollment is centrally dangerous; General/model callers cannot grant repository trust', async () =>
  executionContext.run(context, async () => {
    const { result } = service();
    const descriptor = {
      schemaVersion: 1,
      id: 'future-feed',
      kind: 'json-feed',
      name: 'Future publisher feed',
      origin: 'https://fixture.invalid/',
      publishers: [publisher],
      allowedHosts: ['fixture.invalid'],
      metadataUrl: 'https://fixture.invalid/products.json',
    };
    assert.throws(() => result.stageRegistration(descriptor), { code: 'SOURCE_APPROVAL_REQUIRED' });
    const id = executionContext.run({ ...context, origin: 'operator' }, () =>
      result.stageRegistration(descriptor),
    );
    const registry = createToolRegistry(new Map([['software', result]]));
    const policy = new ToolPermissionPolicy({ registry, available: () => true });
    assert.equal(
      policy.evaluate(
        { tool: 'software', action: 'registerProvider', params: { registrationId: id } },
        { ...context, origin: 'model' },
      ).decision,
      'DENY',
    );
    assert.equal(
      policy.evaluate(
        { tool: 'software', action: 'registerProvider', params: { registrationId: id } },
        { ...context, origin: 'operator' },
      ).decision,
      'REQUIRE_APPROVAL',
    );
  }));
test('verified offline cache remains discoverable after its original plan handle expires', async () =>
  executionContext.run(context, async () => {
    let now = 1000;
    const result = new SoftwareService(new ConfirmationGate(), {
      directory: path.join(root, 'long-lived-cache'),
      key,
      now: () => now,
      inspect: async () => metadata,
      providerFactory: async (options) => {
        const registry = new ProviderRegistry();
        registry.register(
          new OfflineInstallerProvider({
            entries: options.offlineEntries,
            inspect: async () => metadata,
          }),
          { trusted: true },
        );
        return { registry, managerAdapters: new Map(), diagnostics: [] };
      },
    });
    const planId = randomUUID(),
      plan = { ...makePlan(), planId };
    result.store.put(
      'plan',
      scope,
      { plan, digest: 'test-only-unused', downloadVerified: true },
      { id: planId },
    );
    result.rememberCache(plan);
    now += 2 * 24 * 60 * 60_000;
    assert.throws(() => result.store.get('plan', scope, planId));
    const found = await result.discover({ operation: 'install', product: name }, false);
    assert.equal(found.candidates.length, 1);
    assert.equal(found.candidates[0].version, version);
    result.inspect = async () => ({ ...metadata, sha256: 'c'.repeat(64) });
    result.environments.clear();
    const forged = new OfflineInstallerProvider({
      entries: (await result.store.list('cache', scope)).map((item) => item.data),
      inspect: result.inspect,
    });
    await assert.rejects(forged.search({ operation: 'install', product: name }), {
      code: 'OFFLINE_CACHE_CHANGED',
    });
  }));
