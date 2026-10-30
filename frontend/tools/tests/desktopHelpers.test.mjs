import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  desktopHelperArguments,
  desktopHelperEnvironment,
  powerShellPath,
} from '../DesktopRuntime.js';
import { AppDiscoveryService } from '../apps/AppDiscoveryService.js';
import { UIAutomationService } from '../services/UIAutomationService.js';

test('desktop helpers cannot select an arbitrary script', () => {
  assert.throws(() => desktopHelperArguments('../../untrusted.ps1'), {
    code: 'DESKTOP_HELPER_NOT_ALLOWED',
  });
});

test(
  'installed-app discovery and UI observation work under an inherited Restricted policy',
  { skip: process.platform !== 'win32', timeout: 60000 },
  async (t) => {
    const previous = process.env.PSExecutionPolicyPreference;
    process.env.PSExecutionPolicyPreference = 'Restricted';
    t.after(() => {
      if (previous === undefined) delete process.env.PSExecutionPolicyPreference;
      else process.env.PSExecutionPolicyPreference = previous;
    });
    const inheritedPolicy = () =>
      execFileSync(
        powerShellPath(),
        ['-NoProfile', '-NonInteractive', '-Command', 'Get-ExecutionPolicy -Scope Process'],
        {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 10000,
          env: desktopHelperEnvironment(),
        },
      ).trim();
    assert.equal(inheritedPolicy(), 'Restricted');

    const discovery = await new AppDiscoveryService().discover({ query: 'Notepad' });
    assert.notEqual(discovery.degraded, true, JSON.stringify(discovery.errors));
    assert.ok(!discovery.errors.includes('discovery_script_failed'));

    // Observe a deliberately nonexistent process: never focus or change a real window.
    const ui = new UIAutomationService(null, null);
    const result = await ui.run(
      { action: 'isWindowOpen', executablePath: 'C:\\__chanakya_absent_fixture__.exe' },
      'GenericUI.ps1',
    );
    assert.equal(result.success, true);
    assert.equal(result.open, false);
    assert.equal(inheritedPolicy(), 'Restricted', 'the helper changes only its own policy');
  },
);
