import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolEngineRouter } from '../ToolEngineRouter.js';
import { ExecutionLedger } from '../ExecutionLedger.js';
import { WingetService, parseWingetTable, classifyInstall, INSTALL_TIMEOUT_MS } from '../services/WingetService.js';
import { modelPolicy } from '../repair/contract.js';
import { capabilitySchemas, validateCapability, verificationPredicates } from '../../../backend/src/orchestrator/CapabilityContracts.js';

const TABLE = (width = 0) => [
  '\r   - \r   \\ \rName            Id                 Version  Source',
  '-------------------------------------------------------------',
  'Discord         Discord.Discord    1.0.9    winget',
  '7-Zip           7zip.7zip          24.08    winget',
  'LongNameTrunc…  Some.Very.Long.I…  1.0      winget',
  '',
].join(width ? '\r\n' : '\n');

test('table parser reads ids by header offsets, drops spinner noise and truncated ids', () => {
  const rows = parseWingetTable(TABLE());
  assert.deepEqual(rows.map(r => r.id), ['Discord.Discord', '7zip.7zip']);
  assert.equal(rows[0].version, '1.0.9');
  assert.deepEqual(parseWingetTable(TABLE(1)).map(r => r.id), ['Discord.Discord', '7zip.7zip']);
  // A different console width moves every column; offsets come from the header, not constants.
  const wide = ['Name                      Id                       Version', '-'.repeat(60), 'Blender                   BlenderFoundation.Blender 4.2'].join('\n');
  assert.equal(parseWingetTable(wide)[0].id, 'BlenderFoundation.Blender');
  assert.deepEqual(parseWingetTable('No package found matching input criteria.'), []);
});

test('install outcomes: success, already installed, reboot, admin, cancelled, timeout, hash, missing winget', () => {
  assert.equal(classifyInstall({ code: 0 }).status, 'INSTALLED');
  assert.equal(classifyInstall({ code: 0x8a15010d }).status, 'ALREADY_INSTALLED');
  assert.equal(classifyInstall({ code: 1, text: 'Package is already installed.' }).status, 'ALREADY_INSTALLED');
  assert.deepEqual([classifyInstall({ code: 3010 }).status, classifyInstall({ code: 3010 }).needsReboot], ['INSTALLED_REBOOT_REQUIRED', true]);
  assert.equal(classifyInstall({ code: 0, text: 'Please restart your PC' }).status, 'INSTALLED');
  assert.equal(classifyInstall({ code: 0x8a150019 }).adminRequired, true);
  assert.equal(classifyInstall({ code: 1223 }).status, 'INSTALL_CANCELLED');
  assert.equal(classifyInstall({ code: 0x8a150011 }).status, 'HASH_MISMATCH');
  assert.equal(classifyInstall({ timedOut: true }).status, 'INSTALL_TIMEOUT');
  assert.equal(classifyInstall({ missing: true }).status, 'WINGET_UNAVAILABLE');
  assert.equal(classifyInstall({ code: 77 }).ok, false);
});

/** Fake winget: records every argv so tests can prove what was (and was not) executed. */
function fakeWinget({ installCode = 0, listed = true, exists = ['Discord.Discord'] } = {}) {
  const calls = [];
  const run = async args => {
    calls.push(args);
    const id = args[args.indexOf('--id') + 1];
    if (args[0] === 'search') return { code: 0, out: TABLE() };
    if (args[0] === 'show') return exists.includes(id)
      ? { code: 0, out: `Found Discord [${id}]\nVersion: 1.0.9\nPublisher: Discord Inc.\n` } : { code: 0x8a150014, out: 'No package found' };
    if (args[0] === 'install') return { code: installCode, out: 'Found Discord [Discord.Discord]\nSuccessfully installed\n' };
    if (args[0] === 'list') return { code: listed ? 0 : 0x8a150014, out: listed ? 'Name     Id               Version\n---------------------------------\nDiscord  Discord.Discord  1.0.9\n' : 'No installed package' };
    throw new Error(`unexpected winget call ${args.join(' ')}`);
  };
  return { calls, run, installs: () => calls.filter(c => c[0] === 'install') };
}

function fixture(t, options) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'winget-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const router = new ToolEngineRouter({ pathOptions: { readRoots: [root], writeRoots: [root] } });
  const fake = fakeWinget(options);
  const refreshed = [];
  router.services.set('winget', new WingetService(router.gate, { run: fake.run, appService: { registry: { refresh: async () => { refreshed.push(1); } } } }));
  const ledger = new ExecutionLedger({ dispatch: r => router.dispatch(r) });
  ledger.toolRegistry = router.registry;
  let n = 0;
  const call = (r, trusted = {}) => ledger.execute('backend:alice', { ...r, toolCallId: 'task-1', requestId: `req-${++n}`, idempotencyKey: `key-${n}` }, null, { origin: 'model', ...trusted });
  const approve = id => call({ tool: '_system', action: 'confirm', params: { confirmationId: id } }, { humanApproved: true });
  return { router, fake, call, approve, refreshed };
}

test('registry: search is READ, install needs approval and a long timeout, models may call both', t => {
  const { router } = fixture(t);
  assert.equal(router.registry.get('winget.search').risk, 'READ');
  const install = router.registry.get('winget.install');
  assert.equal(install.risk, 'DANGEROUS');
  assert.equal(install.requiresApproval, true);
  assert.ok(install.timeout >= INSTALL_TIMEOUT_MS);
  assert.equal(modelPolicy('winget', 'search'), null);
  assert.equal(modelPolicy('winget', 'install'), null);
  assert.equal(modelPolicy('winget', 'uninstall'), 'MODEL_CAPABILITY_DENIED');
});

test('search runs without confirmation and ranks the best match first', async t => {
  const { call, fake } = fixture(t);
  const r = await call({ tool: 'winget', action: 'search', params: { query: 'discord' } });
  assert.equal(r.success, true);
  assert.equal(r.data.results[0].id, 'Discord.Discord');
  assert.deepEqual(fake.calls[0].slice(0, 3), ['search', '--query', 'discord']);
});

test('search rejects shell metacharacters before winget is ever started', async t => {
  const { call, fake } = fixture(t);
  for (const query of ['x; calc', 'a|b', '$(whoami)', 'a`b', 'x"y', '*', '']) {
    const r = await call({ tool: 'winget', action: 'search', params: { query } });
    assert.equal(r.success, false, query);
  }
  assert.equal(fake.calls.length, 0);
});

test('install is confirmation-gated: nothing is installed until a human approves', async t => {
  const { call, approve, fake, refreshed } = fixture(t);
  const asked = await call({ tool: 'winget', action: 'install', params: { packageId: 'Discord.Discord' } });
  assert.equal(asked.needsConfirmation, true);
  assert.match(asked.message, /Discord Inc\./);
  assert.match(asked.message, /UAC/);
  assert.equal(fake.installs().length, 0, 'no install may run before approval');

  const done = await approve(asked.confirmationId);
  assert.equal(done.success, true);
  assert.equal(done.data.status, 'INSTALLED');
  assert.equal(done.data.verification.status, 'verified');
  assert.equal(done.data.verification.criterion, 'winget_list');
  assert.equal(done.data.registryRefreshed, true);
  assert.equal(refreshed.length, 1);
  assert.deepEqual(fake.installs(), [['install', '--id', 'Discord.Discord', '--exact', '--silent', '--accept-package-agreements', '--source', 'winget', '--accept-source-agreements', '--disable-interactivity']]);

  // The approval is single-use.
  const replay = await approve(asked.confirmationId);
  assert.equal(replay.success, false);
  assert.equal(fake.installs().length, 1);
});

test('install refuses ids that do not exist or are malformed, and never asks a human about them', async t => {
  const { call, fake, router } = fixture(t);
  const ghost = await call({ tool: 'winget', action: 'install', params: { packageId: 'Made.Up' } });
  assert.equal(ghost.success, false);
  assert.ok(!ghost.needsConfirmation);
  for (const packageId of ['Discord.Discord; calc', '..\\evil', 'a b', '', 'x'.repeat(200)]) {
    const r = await call({ tool: 'winget', action: 'install', params: { packageId } });
    assert.equal(r.success, false, packageId);
    assert.ok(!r.needsConfirmation, packageId);
  }
  assert.equal(fake.installs().length, 0);
  assert.equal(Object.keys(router.gate.records).length, 0, 'no confirmation record may be created');
});

test('a declined or failed install is reported honestly, never as success', async t => {
  for (const [installCode, status] of [[1223, 'INSTALL_CANCELLED'], [0x8a150019, 'ADMIN_REQUIRED'], [0x8a150011, 'HASH_MISMATCH']]) {
    const { call, approve } = fixture(t, { installCode });
    const asked = await call({ tool: 'winget', action: 'install', params: { packageId: 'Discord.Discord' } });
    const done = await approve(asked.confirmationId);
    assert.equal(done.data.success, false, status);
    assert.equal(done.data.status, status);
  }
  // Exit code 0 but winget does not list the package: success is reported, verification is not.
  const { call, approve } = fixture(t, { listed: false });
  const asked = await call({ tool: 'winget', action: 'install', params: { packageId: 'Discord.Discord' } });
  const done = await approve(asked.confirmationId);
  assert.equal(done.data.verification.status, 'unverified');
  assert.equal(verificationPredicates['winget.install'](done.data, { packageId: 'Discord.Discord' }), false);
});

test('orchestrator contracts accept only well-formed winget steps and verified evidence', () => {
  assert.ok(capabilitySchemas['winget.search'] && capabilitySchemas['winget.install']);
  assert.equal(validateCapability('winget', 'search', { query: 'Blender' }), null);
  assert.equal(validateCapability('winget', 'install', { packageId: 'BlenderFoundation.Blender' }), null);
  assert.ok(validateCapability('winget', 'install', {}));
  assert.ok(validateCapability('winget', 'install', { packageId: 'x; calc' }));
  assert.ok(validateCapability('winget', 'search', { query: 'a|b' }));
  const ok = { success: true, status: 'INSTALLED', packageId: 'A.B', verification: { status: 'verified', criterion: 'winget_list', observedAt: new Date().toISOString() } };
  assert.equal(verificationPredicates['winget.install'](ok, { packageId: 'A.B' }), true);
  assert.equal(verificationPredicates['winget.install']({ ...ok, packageId: 'X.Y' }, { packageId: 'A.B' }), false);
});
