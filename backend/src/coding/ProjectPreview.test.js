import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ProjectRuntime } from './ProjectRuntime.js';
import { WorkspaceFiles, fileVersion } from './WorkspaceFiles.js';

async function fixture(t, native = false) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'chanakya-html-preview-'));
  const root = path.join(temporary, 'project');
  await fs.mkdir(path.join(root, 'public'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'public/index.html'),
    '<h1>Hello World</h1><link rel="stylesheet" href="style.css">',
  );
  await fs.writeFile(path.join(root, 'public/style.css'), 'h1{color:blue}');
  const files = native
    ? new WorkspaceFiles({ root })
    : {
        list: async () => ({ entries: [] }),
        read: async ({ path: name }) => {
          const content = await fs.readFile(path.join(root, name), 'utf8');
          return { path: name, content, version: fileVersion(content) };
        },
      };
  const runtime = new ProjectRuntime({
    storage: path.join(temporary, 'runtime'),
    processStart: async () => assert.fail('Static HTML cannot launch a project command'),
  });
  const context = {
    root,
    userId: 'owner',
    workspaceId: 'project',
    files,
    approved: true,
    executionPolicy: { commands: true, downloads: false },
  };
  t.after(async () => {
    await runtime.stopWorkspace(context);
    await fs.rm(temporary, { recursive: true, force: true });
  });
  return { temporary, root, files, runtime, context };
}

test('approved HTML preview serves real entry/assets on loopback and stops without npm or Python', async (t) => {
  const { runtime, context } = await fixture(t);
  const params = { path: 'public/index.html' };
  await assert.rejects(runtime.run('preview.start', params, { ...context, approved: false }), {
    code: 'COMMAND_APPROVAL_REQUIRED',
  });
  await assert.rejects(
    runtime.preview('preview.start', params, { ...context, executionPolicy: { commands: false } }),
    { code: 'EXECUTION_GRANT_REQUIRED' },
  );
  const preview = await runtime.preview('preview.start', params, context);
  const app = await runtime.run('preview.start', params, { ...context, executionPreview: preview });
  assert.equal(app.status, 'running');
  const page = await fetch(app.previewUrl);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Hello World/);
  const css = await fetch(new URL('style.css', app.previewUrl));
  assert.equal(css.status, 200);
  assert.equal(await css.text(), 'h1{color:blue}');
  assert.equal((await fetch(app.previewUrl, { method: 'HEAD' })).status, 200);
  assert.equal((await fetch(app.previewUrl, { method: 'POST' })).status, 405);
  assert.equal((await fetch(new URL('.env', app.previewUrl))).status, 403);
  assert.equal((await fetch(new URL('%2e%2e%2fsecret.js', app.previewUrl))).status, 403);
  assert.equal((await fetch(new URL('/', app.previewUrl))).status, 404);
  assert.equal(
    (await fetch(app.previewUrl, { headers: { Origin: 'https://foreign.example' } })).status,
    403,
  );
  assert.throws(() => runtime.output({ ...context, userId: 'other' }, app.jobId), {
    code: 'PROCESS_NOT_FOUND',
  });
  assert.equal((await runtime.stop(context, app.jobId)).status, 'stopped');
  await assert.rejects(fetch(app.previewUrl));
});

test('HTML preview approvals bind to the entry version and npm scripts are inspected before launch', async (t) => {
  const { root, runtime, context } = await fixture(t);
  const params = { path: 'public/index.html' };
  const preview = await runtime.preview('preview.start', params, context);
  await fs.writeFile(path.join(root, params.path), '<h1>Outside edit</h1>');
  await assert.rejects(
    runtime.run('preview.start', params, { ...context, executionPreview: preview }),
    { code: 'FILE_CONFLICT' },
  );
  await fs.writeFile(path.join(root, 'package.json'), '{"scripts":{"dev":"vite"}}');
  await assert.rejects(
    runtime.preview('exec.run', { executable: 'npm', args: ['start'] }, context),
    (error) => error.code === 'NPM_SCRIPT_MISSING' && /Available scripts: dev/.test(error.message),
  );
});

test(
  'native Windows HTML preview uses guarded reads and rejects linked assets',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const { root, temporary, runtime, context } = await fixture(t, true);
    const app = await runtime.run('preview.start', { path: 'public/index.html' }, context);
    assert.match(await (await fetch(app.previewUrl)).text(), /Hello World/);
    const outside = path.join(temporary, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'private.js'), 'private_marker');
    await fs.symlink(outside, path.join(root, 'public/linked'), 'junction');
    assert.equal((await fetch(new URL('linked/private.js', app.previewUrl))).status, 403);
  },
);
