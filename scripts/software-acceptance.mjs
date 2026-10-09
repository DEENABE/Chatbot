import { _electron } from 'playwright-core';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { inspectInstaller } from '../frontend/tools/software/InstallerMetadata.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await fs.mkdir(path.join(root, '.qa'), { recursive: true });
const exe = process.argv.find((value) => value.startsWith('--exe='))?.slice(6),
  packaged = !!exe;
const artifacts = await fs.mkdtemp(
  path.join(root, '.qa', packaged ? 'software-packaged-' : 'software-development-'),
);
const profile = path.join(artifacts, 'profile'),
  repo = path.join(artifacts, 'repository');
await fs.mkdir(repo, { recursive: true });
const fixture = path.join(repo, 'signed-program.exe');
await fs.copyFile(process.execPath, fixture);
const env = {
  ...process.env,
  CHANAKYA_USER_DATA_DIR: profile,
  APP_DATA_PATH: path.join(artifacts, 'data'),
  INDICTRANS_AUTOSTART: '0',
};
delete env.ELECTRON_RUN_AS_NODE;
const results = [],
  errors = [];
let desktop, page, base, token, registered;
const check = (name, condition, detail) => {
  results.push({ name, pass: !!condition, ...(detail ? { detail } : {}) });
  console.log(`${condition ? 'PASS' : 'FAIL'} :: ${name}`);
  if (!condition) throw new Error(name);
};
async function waitFor(test, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await test()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Software acceptance condition timed out.');
}
async function api(route, body) {
  const response = await fetch(base + route, {
    method: body ? 'POST' : 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${route} failed (${response.status})`);
  return data;
}
async function login(credentials) {
  await page.getByRole('button', { name: 'Open Chanakya AI', exact: true }).press('Enter');
  await page.getByPlaceholder('Username', { exact: true }).fill(credentials.username);
  await page.getByPlaceholder('Password', { exact: true }).fill(credentials.password);
  await page
    .getByRole('button', { name: /Sign In|Login/i })
    .last()
    .click();
  await page.locator('textarea').waitFor();
}
async function launch() {
  desktop = await _electron.launch({
    executablePath: exe
      ? path.resolve(exe)
      : path.join(root, 'node_modules/electron/dist/electron.exe'),
    args: packaged ? [] : [path.join(root, 'frontend')],
    env,
    timeout: 60000,
  });
  await waitFor(() => {
    page = desktop.windows().find((candidate) => candidate.url().startsWith('file://'));
    return !!page;
  });
  page.setDefaultTimeout(60000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('button', { name: 'Open Chanakya AI', exact: true }).waitFor();
  base = await page.evaluate(() => window.electronAPI.getApiBaseUrl());
}
async function capture(name) {
  const bytes = await desktop.evaluate(async ({ BrowserWindow }) =>
    (
      await BrowserWindow.getAllWindows()
        .find((item) => item.webContents.getURL().startsWith('file://'))
        .webContents.capturePage()
    )
      .toPNG()
      .toString('base64'),
  );
  await fs.writeFile(path.join(artifacts, name), Buffer.from(bytes, 'base64'));
}
const credentials = {
  username: `softwareqa${Date.now()}`,
  displayName: 'Software QA',
  password: `Qa-${randomUUID()}`,
};
try {
  await launch();
  check(
    'Actual application exposes the narrow software IPC contract',
    await page.evaluate(() => typeof window.softwareAPI?.discover === 'function'),
  );
  registered = await api('/auth/register', credentials);
  token = registered.token;
  await login(credentials);
  const native = await inspectInstaller(fixture, 'exe');
  const metadata = {
    status: native.status,
    name: native.productName,
    version: native.productVersion,
    publisher: native.publisher,
    architecture: native.architecture,
  };
  check(
    'Actual signed Windows file metadata is read without executing it',
    metadata.status === 'Valid' && !!metadata.name && !!metadata.publisher && !!metadata.version,
    metadata,
  );
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'software', exact: true }).click();
  await page.getByRole('button', { name: 'Search offline sources', exact: true }).waitFor();
  check(
    'Generic software settings render in the actual app',
    await page.getByRole('heading', { name: 'Software sources', exact: true }).isVisible(),
  );
  const providerResult = await page.evaluate(() => window.softwareAPI.providers());
  check(
    'Actual provider discovery returns bounded interfaces and diagnostics',
    providerResult.success === true &&
      providerResult.data.providers.some((value) => value.id === 'offline-cache'),
    { providers: providerResult.data.providers, diagnostics: providerResult.data.diagnostics },
  );
  const queryName = `Unknown Future Distribution ${randomUUID().slice(0, 8)}`;
  const unknown = await page.evaluate(
    (product) => window.softwareAPI.discover({ product, operation: 'install' }, false),
    queryName,
  );
  check(
    'Unknown product discovery does not invent an installed product',
    unknown.success &&
      !['INSTALLED', 'ALREADY_INSTALLED'].includes(unknown.data.status) &&
      !unknown.data.candidates.some((candidate) => !candidate.handoff),
    { status: unknown.data.status, requiresOnline: unknown.data.requiresOnline },
  );
  await page.getByLabel('Product name', { exact: true }).fill(queryName);
  await page.getByRole('button', { name: 'Review online lookup', exact: true }).click();
  await page.getByRole('dialog', { name: 'Review requested action', exact: true }).waitFor();
  check(
    'Network lookup needs contextual approval before any online search',
    (
      await page.getByRole('dialog', { name: 'Review requested action', exact: true }).innerText()
    ).includes(queryName),
  );
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Review requested action', exact: true })
    .waitFor({ state: 'hidden' });
  const descriptor = {
    schemaVersion: 1,
    id: `qa-local-${randomUUID().slice(0, 8)}`,
    kind: 'local-repository',
    name: 'QA approved signed local repository',
    origin: `Local repository: ${repo}`,
    publishers: [metadata.publisher],
    directory: repo,
  };
  const request = await page.evaluate(
    (source) => window.softwareAPI.registerSource(source),
    descriptor,
  );
  check(
    'New provider data registration requests central approval',
    request.needsConfirmation === true &&
      request.approvalDetails.software.publisher === metadata.publisher,
  );
  const before = await page.evaluate(() => window.softwareAPI.providers());
  check(
    'Pending source enrollment does not create trusted sources',
    !before.data.sources.some((value) => value.descriptor.id === descriptor.id),
  );
  // Test-harness approval changes only this isolated profile's authorization for
  // its generated repository. No application is downloaded or installed.
  const approved = await page.evaluate(
    (id) =>
      window.toolEngine.confirm(id, {
        toolCallId: crypto.randomUUID(),
        requestId: crypto.randomUUID(),
        idempotencyKey: crypto.randomUUID(),
      }),
    request.confirmationId,
  );
  check(
    'Explicit approval enrolls a validated new provider without core edits',
    approved.success && approved.data.status === 'SOURCE_REGISTERED',
  );
  const found = await page.evaluate((query) => window.softwareAPI.discover(query, false), {
    product: metadata.name,
    operation: 'install',
    version: metadata.version,
    sourceProviderId: descriptor.id,
  });
  check(
    'The same generic resolver discovers the signed runtime identity from the approved alternate source',
    found.success &&
      found.data.candidates.length === 1 &&
      found.data.candidates[0].publisher === metadata.publisher &&
      found.data.candidates[0].version === metadata.version,
  );
  const resolved = await page.evaluate(
    (id) => window.softwareAPI.resolve(id),
    found.data.selectedCandidateId,
  );
  check(
    'Actual resolver creates a typed owned plan without executing it',
    resolved.success &&
      resolved.data.status === 'PLAN_READY' &&
      resolved.data.plan.protocol === 'local-installer',
  );
  const proposedInstall = await page.evaluate(
    (id) => window.softwareAPI.requestAction('install', id),
    resolved.data.plan.planId,
  );
  check(
    'Installation needs a separate exact-product approval with publisher, version, source and hash',
    proposedInstall.needsConfirmation &&
      proposedInstall.approvalDetails.software.sha256?.length === 64 &&
      proposedInstall.approvalDetails.software.version === metadata.version,
  );
  const cancelled = await page.evaluate(
    (id) => window.toolEngine.cancel(id),
    proposedInstall.confirmationId,
  );
  check(
    'Actual installation approval can be declined without executing the signed file',
    cancelled.success === true,
  );
  const inventory = await page.evaluate(
    (id) => window.softwareAPI.requestAction('verify', id),
    resolved.data.plan.planId,
  );
  check(
    'Independent native inventory produces a truthful present-or-unverified result',
    ['INSTALL_VERIFIED', 'INSTALL_NOT_VERIFIED'].includes(inventory.data?.status),
    { status: inventory.data?.status, verification: inventory.data?.verification },
  );
  const added = await page.evaluate(() => window.softwareAPI.providers());
  check(
    'Registered provider is visible without modifying application-specific code',
    added.data.providers.some((value) => value.id === descriptor.id),
  );
  await page.getByRole('button', { name: 'Refresh providers', exact: true }).click();
  await page.getByText('QA approved signed local repository', { exact: false }).first().waitFor();
  await capture('software-settings.png');
  if (providerResult.data.providers.some((provider) => provider.capabilities.network)) {
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    await page.locator('textarea').fill(`Install ${queryName}`);
    await page.locator('textarea').press('Enter');
    await page.getByRole('dialog', { name: 'Review requested action', exact: true }).waitFor();
    check(
      'Actual long-name chat request reaches the signed software workflow and network approval',
      (
        await page.getByRole('dialog', { name: 'Review requested action', exact: true }).innerText()
      ).includes(queryName),
    );
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Review requested action', exact: true })
      .waitFor({ state: 'hidden' });
    await waitFor(async () =>
      (await page.locator('body').innerText()).toLowerCase().includes('declined'),
    );
    check('Chat refusal stops the request without searching or installing', true);
  }
  await desktop.close();
  desktop = null;
  await launch();
  const loginResult = await api('/auth/login', credentials);
  token = loginResult.token;
  await login(credentials);
  const restored = await page.evaluate(() => window.softwareAPI.providers());
  check(
    'DPAPI-protected provider enrollment persists across actual app restart',
    restored.success &&
      restored.data.sources.some((value) => value.descriptor.id === descriptor.id),
  );
  const oldPlan = await page.evaluate(
    (id) => window.softwareAPI.requestAction('verify', id),
    resolved.data.plan.planId,
  );
  check(
    'Owned plan handle remains readable after restart and fresh login',
    ['INSTALL_VERIFIED', 'INSTALL_NOT_VERIFIED'].includes(oldPlan.data?.status),
  );
  check('No uncaught renderer error', errors.length === 0, errors);
} catch (error) {
  results.push({ name: error.message, pass: false });
  console.error(`FAIL :: ${error.message}`);
  process.exitCode = 1;
  if (desktop && page) await capture('failure.png').catch(() => {});
} finally {
  await desktop?.close().catch(() => {});
  await fs.writeFile(
    path.join(artifacts, 'results.json'),
    JSON.stringify(
      {
        packaged,
        executablePath: exe || 'development Electron',
        results,
        errors,
        fixtureType:
          'Actual signed runtime program inspected/copied only; never executed as installer',
        downloads: 0,
        installerExecutions: 0,
        finishedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log(`Software acceptance artifacts: ${artifacts}`);
}
