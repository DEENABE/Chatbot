import { _electron, chromium } from 'playwright-core';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv.includes('--development') ? 'development' : 'electron';
const exeOption = process.argv.find((value) => value.startsWith('--exe='));
const packaged = !!exeOption;
const executablePath = exeOption
  ? path.resolve(exeOption.slice(6))
  : path.join(root, 'node_modules/electron/dist/electron.exe');
await fs.mkdir(path.join(root, '.qa'), { recursive: true });
const artifacts = await fs.mkdtemp(path.join(root, '.qa', `${packaged ? 'packaged' : mode}-`));
const profile = path.join(artifacts, 'profile');
const workspaceRoot = path.join(artifacts, 'workspace');
await fs.mkdir(path.join(workspaceRoot, 'nested/empty'), { recursive: true });
await fs.writeFile(
  path.join(workspaceRoot, 'nested', 'notes.txt'),
  'The workspace meeting is Tuesday.\n',
);
await fs.writeFile(path.join(workspaceRoot, 'unsupported.bin'), Buffer.from([0, 1, 2]));
const filePath = path.join(artifacts, 'cobalt-brief.txt');
await fs.writeFile(filePath, 'Cobalt project launch code is 73142. The launch owner is Meera.\n');
const credentials = {
  username: `qa${Date.now()}`,
  password: `Qa-${randomUUID()}`,
  displayName: 'QA User',
};
const docx = new JSZip();
docx.file(
  '[Content_Types].xml',
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
);
docx.file(
  '_rels/.rels',
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
);
docx.file(
  'word/document.xml',
  '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Indigo document extraction evidence.</w:t></w:r></w:p></w:body></w:document>',
);
const docxBytes = await docx.generateAsync({ type: 'nodebuffer' });
const results = [];
const children = [];
const errors = [];
let desktop, browser, page, apiBase, token, conversationId, workspaceId;
let preservedServer;
const env = {
  ...process.env,
  CHANAKYA_USER_DATA_DIR: profile,
  APP_DATA_PATH: path.join(artifacts, 'data'),
  INDICTRANS_AUTOSTART: '0',
};
delete env.ELECTRON_RUN_AS_NODE;
const check = (name, condition, detail) => {
  results.push({ name, pass: !!condition, ...(detail ? { detail } : {}) });
  if (!condition) throw new Error(name);
  console.log(`PASS :: ${name}`);
};
async function api(route, options = {}) {
  const response = await fetch(`${apiBase}${route}`, {
    ...options,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...options.headers,
    },
    signal: options.signal || AbortSignal.timeout(20000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${route}: ${response.status} ${data.error || 'failed'}`);
  return data;
}
async function waitUntil(fn, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('Acceptance condition timed out.');
}
async function login() {
  await page.getByRole('button', { name: 'Open Chanakya AI', exact: true }).press('Enter');
  await page.getByPlaceholder('Username', { exact: true }).fill(credentials.username);
  await page.getByPlaceholder('Password', { exact: true }).fill(credentials.password);
  await page
    .getByRole('button', { name: /Sign In|Login/i })
    .last()
    .click();
  await page.locator('textarea').waitFor();
}
async function launchElectron() {
  const start = Date.now();
  desktop = await _electron.launch({
    executablePath,
    args: packaged ? [] : [path.join(root, 'frontend')],
    env,
    timeout: 60000,
  });
  await waitUntil(() => {
    page = desktop.windows().find((candidate) => candidate.url().startsWith('file://'));
    return !!page;
  });
  page.on('pageerror', (error) => errors.push(error.message));
  page.setDefaultTimeout(20000);
  await page.getByRole('button', { name: 'Open Chanakya AI', exact: true }).waitFor();
  apiBase = await page.evaluate(() => window.electronAPI.getApiBaseUrl());
  results.push({
    name: 'Electron startup to interactive avatar',
    pass: true,
    milliseconds: Date.now() - start,
  });
}
async function stopChild(child) {
  if (child.exitCode !== null) return;
  try {
    execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 5000,
    });
  } catch {
    child.kill();
  }
}
async function screenshot(name) {
  if (desktop) {
    const encoded = await desktop.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((item) =>
        item.webContents.getURL().startsWith('file://'),
      );
      return (await window.webContents.capturePage()).toPNG().toString('base64');
    });
    await fs.writeFile(path.join(artifacts, name), Buffer.from(encoded, 'base64'));
  } else await page.screenshot({ path: path.join(artifacts, name), timeout: 60000 });
}

try {
  if (mode === 'development') {
    const backend = spawn(process.execPath, [path.join(root, 'backend/src/server.js')], {
      cwd: path.join(root, 'backend'),
      env: { ...env, PORT: '0', CHANAKYA_DESKTOP_CHILD: '1' },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.push(backend);
    let backendLog = '';
    backend.stdout.on('data', (data) => {
      backendLog += data;
      const match = backendLog.match(/CHANAKYA_BACKEND_READY (.+)/);
      if (match) apiBase = `http://127.0.0.1:${JSON.parse(match[1]).port}/api`;
    });
    backend.stderr.on('data', (data) => errors.push(data.toString().slice(0, 1000)));
    await waitUntil(() => !!apiBase);
    const vite = spawn(
      process.execPath,
      [
        path.join(root, 'node_modules/vite/bin/vite.js'),
        '--host',
        '127.0.0.1',
        '--port',
        '15173',
        '--strictPort',
      ],
      {
        cwd: path.join(root, 'frontend'),
        env: { ...env, CHANAKYA_DEV_API_URL: apiBase.replace(/\/api$/, '') },
        windowsHide: true,
        stdio: 'pipe',
      },
    );
    children.push(vite);
    let viteLog = '';
    vite.stdout.on('data', (data) => {
      viteLog += data;
      fs.appendFile(path.join(artifacts, 'vite.log'), data).catch(() => {});
    });
    vite.stderr.on('data', (data) => {
      fs.appendFile(path.join(artifacts, 'vite.log'), data).catch(() => {});
    });
    await waitUntil(() => viteLog.includes('15173'));
    const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
    browser = await chromium.launch({ executablePath: edge, headless: true });
    page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('response', (response) => {
      if (response.status() >= 400 && !response.url().includes('/api/auth/me'))
        fs.appendFile(
          path.join(artifacts, 'http-errors.log'),
          `${response.status()} ${response.url()}\n`,
        ).catch(() => {});
    });
    await page.goto('http://127.0.0.1:15173');
    check('Vite development page loads', (await page.title()) === 'CHANKYA AI');
  } else {
    // An actual independent process on the legacy port must survive desktop startup.
    preservedServer = http.createServer((_req, res) => res.end('unrelated test server'));
    await new Promise((resolve) => {
      preservedServer.once('error', () => {
        preservedServer = null;
        resolve();
      });
      preservedServer.listen(3001, '127.0.0.1', resolve);
    });
    await launchElectron();
    check(
      'Desktop uses its owned dynamic endpoint',
      apiBase !== 'http://127.0.0.1:3001/api',
      apiBase,
    );
    if (preservedServer)
      check(
        'An unrelated server on port 3001 survives startup',
        (await (await fetch('http://127.0.0.1:3001')).text()) === 'unrelated test server',
      );
  }
  const registered = await api('/auth/register', {
    method: 'POST',
    body: JSON.stringify(credentials),
  });
  token = registered.token;
  check('Real isolated account registration', !!registered.user?.id && !!token);
  const settings = await api('/models/settings');
  const general =
    settings.models.find((model) => model.id === 'qwen:latest') ||
    settings.models.find((model) => model.capabilities.includes('completion'));
  const windows = settings.models.find(
    (model) => /^qwen/i.test(model.id) && model.capabilities.includes('tools'),
  );
  if (general)
    await api('/models/settings', {
      method: 'PUT',
      body: JSON.stringify({
        generalModel: general.id,
        windowsModel: windows?.id || '',
        keepAlive: '30s',
        contextWindow: 2048,
      }),
    });
  await login();
  check('Actual renderer login and composer', await page.locator('textarea').isVisible());
  await page.getByTitle('Settings', { exact: true }).click();
  await page.getByLabel('Display name', { exact: true }).fill('QA Updated');
  await page.getByRole('button', { name: 'Save profile', exact: true }).click();
  await page.getByText('Profile saved on this device.', { exact: true }).waitFor();
  check(
    'Profile edits persist in authenticated API',
    (await api('/auth/me')).user.displayName === 'QA Updated',
  );
  await page.getByRole('tab', { name: 'models', exact: true }).click();
  await page.getByText('General and documents', { exact: true }).waitFor();
  check(
    'Two capability-filtered model selectors visible',
    (await page.locator('form select').count()) >= 3,
  );
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await page.locator('input[type="file"]').first().setInputFiles(filePath);
  await page.getByRole('button', { name: 'Remove cobalt-brief.txt', exact: true }).waitFor();
  await waitUntil(async () => (await page.locator('body').innerText()).includes('Ready'), 60000);
  check(
    'Attachment card appears before send',
    (await page.locator('body').innerText()).includes('cobalt-brief.txt'),
  );
  check(
    'Chat attachment never silently enters Knowledge',
    (await api('/documents')).documents.length === 0,
  );
  await page
    .locator('textarea')
    .fill(
      'What is the Cobalt project launch code? Answer in one short sentence with a source citation.',
    );
  await page.locator('textarea').press('Enter');
  await waitUntil(async () => {
    const history = await api('/history');
    const conversation = history.conversations.find((item) =>
      item.messages.some((message) => message.role === 'user' && message.attachments?.length),
    );
    if (conversation) conversationId = conversation.id;
    return !!conversation?.messages.some(
      (message) => message.role === 'assistant' && /73142/.test(message.content),
    );
  }, 120000);
  check(
    'Real local document answer uses attachment content',
    (await page.locator('body').innerText()).includes('73142'),
  );
  const history = await api('/history');
  const conversation = history.conversations.find((item) => item.id === conversationId);
  const userMessage = conversation.messages.find((message) => message.attachments?.length);
  const answer = conversation.messages.find(
    (message) => message.role === 'assistant' && /73142/.test(message.content),
  );
  check(
    'Document answer retains supporting filename references',
    JSON.parse(answer.sources || '[]').some((source) => source.filename === 'cobalt-brief.txt'),
  );
  check(
    'Exact message attachment metadata persisted',
    userMessage.attachments[0].name === 'cobalt-brief.txt',
  );
  check(
    'Ordinary attachment chat emits no OS tool message',
    conversation.messages.every((message) => message.role !== 'tool'),
  );
  await screenshot('chat.png');
  await page.getByTitle('Workspace files', { exact: true }).click();
  await page.getByLabel('Workspace name', { exact: true }).fill('QA Workspace');
  await page.getByLabel('Local root directory', { exact: true }).fill(workspaceRoot);
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await page.getByText('notes.txt', { exact: true }).waitFor();
  const workspaces = await api('/workspaces');
  workspaceId = workspaces.workspaces.find((workspace) => workspace.name === 'QA Workspace').id;
  const scan = await api(`/workspaces/${workspaceId}/files`);
  check(
    'Recursive workspace enumeration includes nested and empty directories',
    scan.entries.some((entry) => entry.relativePath === 'nested/empty') &&
      scan.files === 2 &&
      scan.supportedFiles === 1,
  );
  await page.getByRole('button', { name: 'Index new files', exact: true }).click();
  await waitUntil(
    async () =>
      (await api(`/documents?purpose=workspace&workspaceId=${workspaceId}`)).documents.length === 1,
    60000,
  );
  check(
    'Workspace indexing uses actual nested document',
    (await api(`/documents?purpose=workspace&workspaceId=${workspaceId}`)).documents[0].name ===
      'notes.txt',
  );
  await screenshot('workspace.png');
  const extractionUpload = new FormData();
  extractionUpload.append('purpose', 'workspace');
  extractionUpload.append('workspaceId', workspaceId);
  extractionUpload.append(
    'documents',
    new Blob([await fs.readFile(path.join(root, 'backend/test/fixtures/document-pages.pdf'))], {
      type: 'application/pdf',
    }),
    'pages.pdf',
  );
  extractionUpload.append(
    'documents',
    new Blob([docxBytes], {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }),
    'evidence.docx',
  );
  const extraction = await api('/upload', {
    method: 'POST',
    body: extractionUpload,
    signal: AbortSignal.timeout(90000),
  });
  check(
    'PDF and DOCX multipart extraction in this running runtime',
    extraction.documents.length === 2 &&
      extraction.documents.every((document) => document.characters > 20 && document.chunks > 0),
  );
  check(
    'No viewport horizontal overflow',
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  );
  if (desktop) {
    const metrics = await desktop.evaluate(({ app }) =>
      app.getAppMetrics().map((metric) => ({
        type: metric.type,
        pid: metric.pid,
        cpu: metric.cpu.percentCPUUsage,
        workingSetKB: metric.memory.workingSetSize,
      })),
    );
    results.push({ name: 'Measured Electron process metrics', pass: true, metrics });
    const oldApi = apiBase;
    await desktop.close();
    desktop = null;
    await waitUntil(async () => {
      try {
        await fetch(`${oldApi}/health`, { signal: AbortSignal.timeout(300) });
        return false;
      } catch {
        return true;
      }
    });
    check('Owned backend stops when the actual application closes', true);
    await launchElectron();
    const loginResponse = await api('/auth/login', {
      method: 'POST',
      body: JSON.stringify(credentials),
    });
    token = loginResponse.token;
    await login();
    check(
      'Profile and authentication preserved after restart',
      (await api('/auth/me')).user.displayName === 'QA Updated',
    );
    check(
      'Workspace selection preserved after restart',
      (await api('/workspaces')).workspaces.some(
        (workspace) => workspace.id === workspaceId && workspace.active,
      ),
    );
    check(
      'Attachment history preserved after restart',
      (await api('/history')).conversations.some(
        (item) =>
          item.id === conversationId &&
          item.messages.some((message) => message.attachments?.[0]?.name === 'cobalt-brief.txt'),
      ),
    );
  }
  if (process.argv.includes('--vision')) {
    const picture = await fs.readFile(path.join(root, 'backend/test/fixtures/image.png'));
    const imageUpload = new FormData();
    imageUpload.append('purpose', 'attachment');
    imageUpload.append('documents', new Blob([picture], { type: 'image/png' }), 'blue-image.png');
    const uploaded = await api('/upload', { method: 'POST', body: imageUpload });
    check(
      'Installed vision capability accepts private image attachment',
      uploaded.documents[0]?.kind === 'image' && uploaded.documents[0]?.width === 16,
    );
    const imageConversation = randomUUID(),
      started = Date.now();
    const response = await fetch(`${apiBase}/chat`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'What color is this image? Reply with one color word only.',
        attachmentIds: [uploaded.documents[0].id],
        userMessageId: randomUUID(),
        conversationId: imageConversation,
      }),
      signal: AbortSignal.timeout(180000),
    });
    const events = (await response.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const answer = events
      .filter((event) => event.type === 'token')
      .map((event) => event.text)
      .join('');
    check(
      'Actual local vision inference recognizes the blue image without OS tools',
      /blue/i.test(answer) && !events.some((event) => ['error', 'tool_call'].includes(event.type)),
      {
        answer: answer.slice(0, 200),
        elapsedMs: Date.now() - started,
        route: events.find((event) => event.type === 'route'),
      },
    );
  }
  check('No uncaught renderer error', errors.length === 0, errors);
} catch (error) {
  console.error(`FAIL :: ${error.message}`);
  results.push({ name: error.message, pass: false });
  if (page) await screenshot('failure.png').catch(() => {});
  process.exitCode = 1;
} finally {
  await desktop?.close().catch(() => {});
  await browser?.close().catch(() => {});
  for (const child of children.reverse()) await stopChild(child);
  if (preservedServer) {
    preservedServer.closeAllConnections();
    await new Promise((resolve) => preservedServer.close(resolve));
  }
  await fs.writeFile(
    path.join(artifacts, 'results.json'),
    JSON.stringify(
      { mode, packaged, executablePath, results, errors, finishedAt: new Date().toISOString() },
      null,
      2,
    ),
  );
  console.log(`Acceptance artifacts: ${artifacts}`);
}
