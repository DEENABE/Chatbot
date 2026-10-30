import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WingetService } from '../services/WingetService.js';
import { WebInstallService } from '../services/WebInstallService.js';
import { ConfirmationGate } from '../ConfirmationGate.js';
import { executionContext } from '../ExecutionContext.js';

const context = {
  authenticated: true,
  scope: 'renderer:fixture-1',
  origin: 'model',
  taskId: 'task',
  modelRoute: 'windows',
};
test('online install discovery and download request approval before network work', async () => {
  let network = 0;
  const gate = new ConfirmationGate();
  const winget = new WingetService(gate, {
    run: async () => {
      network++;
      throw new Error('must not run');
    },
  });
  const web = new WebInstallService(gate, {
    search: async () => {
      network++;
    },
    download: async () => {
      network++;
    },
  });
  await executionContext.run(context, async () => {
    assert.equal((await winget.execute('search', { query: 'Fixture' })).needsConfirmation, true);
    assert.equal((await web.execute('find', { query: 'Fixture' })).needsConfirmation, true);
    assert.equal(
      (await web.execute('download', { candidateId: 'a'.repeat(16) })).needsConfirmation,
      true,
    );
  });
  assert.equal(network, 0);
  for (const id of Object.keys(gate.records)) gate.cancel(id);
});
test('unknown Winget ids cannot perform unapproved manifest fetch before confirmation', async () => {
  let network = 0;
  const service = new WingetService(new ConfirmationGate(), {
    run: async () => {
      network++;
    },
  });
  await assert.rejects(
    executionContext.run(context, () => service.execute('install', { packageId: 'Fixture.App' })),
    { code: 'PACKAGE_NOT_VERIFIED' },
  );
  assert.equal(network, 0);
});
test('Winget rejects changed publisher after approval before any install process starts', async () => {
  const calls = [],
    gate = new ConfirmationGate();
  const service = new WingetService(gate, {
    run: async (args) => {
      calls.push(args);
      return {
        code: 0,
        out:
          'Found Fixture [Fixture.App]\nVersion: 1.0\nPublisher: Changed Publisher\nInstaller Url: https://fixture.example/setup.exe\nInstaller SHA256: ' +
          'a'.repeat(64),
      };
    },
  });
  const info = {
    id: 'Fixture.App',
    name: 'Fixture',
    version: '1.0',
    publisher: 'Original Publisher',
    source: 'winget',
    installerUrl: 'https://fixture.example/setup.exe',
    installerSha256: 'a'.repeat(64),
  };
  service.known.set('winget:fixture.app', info);
  await executionContext.run(context, async () => {
    const proposal = await service.execute('install', { packageId: info.id });
    const metadata = gate.getRecord(proposal.confirmationId).metadata;
    await assert.rejects(service.executeConfirmed('install', { packageId: info.id }, metadata), {
      code: 'PACKAGE_CHANGED',
    });
    assert.equal(
      calls.some((args) => args[0] === 'install'),
      false,
    );
    assert.ok(calls[0].includes('--version'));
    gate.cancel(proposal.confirmationId);
  });
});
test('offline picker pipeline rejects unsigned, wrong-identity and changed installers', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chanakya-install-test-'));
  try {
    const file = path.join(root, 'setup.exe');
    fs.writeFileSync(file, Buffer.from([0x4d, 0x5a, 0, 0, 0, 0]));
    let runs = 0;
    const service = new WebInstallService(new ConfirmationGate(), {
      root: path.join(root, 'quarantine'),
      verify: async () => ({ status: 'NotSigned' }),
      run: async () => {
        runs++;
      },
    });
    await executionContext.run(context, async () => {
      await assert.rejects(service.stageOffline(file, 'Fixture'), {
        code: 'UNSIGNED_INSTALLER',
      });
      service.verify = async () => ({
        status: 'Valid',
        signer: 'CN=Fixture Publisher, O=Fixture Publisher',
        product: 'Other Application',
      });
      await assert.rejects(service.stageOffline(file, 'Different Product'), {
        code: 'IDENTITY_MISMATCH',
      });
      service.verify = async () => ({
        status: 'Valid',
        signer: 'CN=Fixture Publisher, O=Fixture Publisher',
        product: 'Fixture App',
      });
      const staged = await service.stageOffline(file, 'Fixture App');
      assert.equal(staged.source, 'offline');
      assert.equal(staged.sha256.length, 64);
      const record = service.downloads.get(staged.downloadId);
      fs.appendFileSync(record.file, 'changed');
      await assert.rejects(service.install({ downloadId: staged.downloadId }), {
        code: 'INSTALLER_CHANGED',
      });
      assert.equal(runs, 0);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
