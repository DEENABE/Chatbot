import test from 'node:test';
import assert from 'node:assert/strict';
import { runPowerShell } from '../src/agent/powershellRunner.js';
const windows = process.platform === 'win32';
test(
  'hidden helper retains actual stdout and nonzero process exit code',
  { skip: !windows },
  async () => {
    const result = await runPowerShell("Write-Output 'LOCAL HELPER OK'; exit 7", {
      timeout: 10000,
    });
    assert.equal(result.stdout, 'LOCAL HELPER OK');
    assert.equal(result.exitCode, 7);
    assert.equal(result.timedOut, false);
  },
);
test(
  'PowerShell cancellation stops a harmless sleeping helper promptly',
  { skip: !windows },
  async () => {
    const controller = new AbortController(),
      started = Date.now();
    const timer = setTimeout(() => controller.abort(), 300);
    try {
      await assert.rejects(
        runPowerShell('Start-Sleep -Seconds 20', { timeout: 10000, signal: controller.signal }),
        { name: 'AbortError' },
      );
      assert.ok(Date.now() - started < 5000);
    } finally {
      clearTimeout(timer);
    }
  },
);
test(
  'PowerShell deadline stops a harmless sleeping helper and reports timeout',
  { skip: !windows },
  async () => {
    const result = await runPowerShell('Start-Sleep -Seconds 20', { timeout: 300 });
    assert.equal(result.timedOut, true);
  },
);
