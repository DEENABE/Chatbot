import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

test('workspace ownership, active selection and restart persistence use real SQLite', async (t) => {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'chanakya-workspace-store-test-'));
  assert(path.resolve(fixtureRoot).startsWith(path.resolve(os.tmpdir()) + path.sep));
  process.env.APP_DATA_PATH = fixtureRoot;
  const { saveWorkspace, listWorkspaces, activateWorkspace, getWorkspaceForUser } =
    await import('./workspaceService.js');
  const { db } = await import('./db.js');
  t.after(async () => {
    db.close();
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });
  const directoryOne = path.join(fixtureRoot, 'root-one');
  const directoryTwo = path.join(fixtureRoot, 'root-two');
  await fs.mkdir(directoryOne);
  await fs.mkdir(directoryTwo);
  const { registerUser } = await import('./authService.js');
  const user = (
    await registerUser(
      `workspace_${randomUUID().slice(0, 8)}`,
      'Workspace test',
      'Fixture-password-123',
    )
  ).id;
  const { updateUserProfile, getUserById } = await import('./authService.js');
  await updateUserProfile(user, {
    displayName: 'Updated profile',
    email: 'local@example.test',
    department: 'QA',
  });
  assert.equal((await getUserById(user)).displayName, 'Updated profile');
  await updateUserProfile(user, {
    email: '',
    department: '',
    role: 'Admin',
    permissions: ['admin'],
  });
  const profile = await getUserById(user);
  assert.equal(profile.email, null);
  assert.equal(profile.department, null);
  assert.equal(profile.displayName, 'Updated profile');
  assert.equal(profile.role, 'Employee');
  await assert.rejects(updateUserProfile(user, { displayName: ' ' }), /required/);
  await assert.rejects(updateUserProfile(user, { email: 'invalid email' }), /valid email/);
  const stranger = randomUUID();
  const first = await saveWorkspace(user, { name: 'One', root: directoryOne });
  const second = await saveWorkspace(user, { name: 'Two', root: directoryTwo });
  assert.equal(first.active, true);
  assert.equal(second.active, true);
  assert.equal((await listWorkspaces(user)).filter((entry) => entry.active).length, 1);
  assert.throws(() => getWorkspaceForUser(stranger, first.id), /not found/);
  assert.deepEqual(await listWorkspaces(stranger), []);
  activateWorkspace(user, first.id);
  const moduleUrl = new URL('./workspaceService.js', import.meta.url).href;
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const service=await import(${JSON.stringify(moduleUrl)}); const list=await service.listWorkspaces(${JSON.stringify(user)}); console.log(JSON.stringify(list.map(({id,active})=>({id,active}))));`,
    ],
    {
      env: { ...process.env, APP_DATA_PATH: fixtureRoot },
      windowsHide: true,
      encoding: 'utf8',
      timeout: 15000,
    },
  );
  assert.equal(child.status, 0, child.stderr);
  const restored = JSON.parse(child.stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(restored.find((entry) => entry.id === first.id).active, true);
  assert.equal(restored.find((entry) => entry.id === second.id).active, false);
  await fs.writeFile(path.join(directoryOne, 'original.txt'), 'Preserve this original');
  const { appendDocuments, getDocuments } = await import('./documentsStore.js');
  await appendDocuments(
    [
      {
        id: randomUUID(),
        name: 'original.txt',
        size: 22,
        purpose: 'workspace',
        workspaceId: first.id,
        relativePath: 'original.txt',
      },
    ],
    user,
  );
  await saveWorkspace(user, { name: 'One', root: directoryTwo }, first.id);
  assert.equal(
    (await getDocuments(user, { purpose: 'workspace', workspaceId: first.id })).length,
    0,
  );
  assert.equal(
    await fs.readFile(path.join(directoryOne, 'original.txt'), 'utf8'),
    'Preserve this original',
  );
  await saveWorkspace(user, { name: 'One', root: directoryOne }, first.id);
  await fs.rename(directoryOne, `${directoryOne}-renamed`);
  const unavailable = (await listWorkspaces(user)).find((entry) => entry.id === first.id);
  assert.equal(unavailable.available, false);
  assert.match(unavailable.error, /unavailable/);
});
