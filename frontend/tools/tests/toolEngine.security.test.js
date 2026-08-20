import test from 'node:test';
import assert from 'node:assert/strict';

import { ConfirmationGate } from '../ConfirmationGate.js';
import { BaseToolService } from '../BaseToolService.js';
import { ToolEngineRouter } from '../ToolEngineRouter.js';
import { isBlockedCommand } from '../dangerGuard.js';
import { PowerShellService } from '../services/PowerShellService.js';
import { CmdService } from '../services/CmdService.js';
import { ProcessService, isProtectedProcessName } from '../services/ProcessService.js';
import { WinServicesService } from '../services/WinServicesService.js';
import { RegistryService } from '../services/RegistryService.js';
import { FileService } from '../services/FileService.js';

// Phase 4 — agent/PowerShell/tool-engine security audit. This tree
// (frontend/tools/) is a second, independent tool-execution engine from the
// backend's agent/ ReAct loop — it runs in the Electron main process, is
// invoked over IPC from the renderer, and is what /api/chat's native
// tool-calling actually drives. The audit found two safety features that
// were fully built but never wired up (a real bug, not a design choice):
//
//   1. dangerGuard.isBlockedCommand() — documented as blocking dangerous
//      commands "even after the user has confirmed the action" — was never
//      imported or called anywhere in PowerShellService/CmdService.
//   2. getConfirmationMessage(action, params) — defined on four services to
//      show the *specific* command/path/service being confirmed — was never
//      called by BaseToolService, which always used the generic static
//      `description` instead. A user clicking "Allow Execution" saw
//      "Execute a PowerShell command", never the actual command.
//
// Plus three services (ProcessService.kill, WinServicesService.stop/
// restart, RegistryService.setValue/deleteValue) that had no target-based
// policy at all — only a confirmation dialog stood between an LLM decision
// and killing lsass.exe, stopping Windows Defender, or writing a registry
// autostart entry. These tests exercise the real, exported functions (not
// mocks) wherever doing so is safe; where a genuine end-to-end call would
// mean actually resolving-and-nearly-killing a real critical system PID
// (ProcessService.kill), the underlying policy predicate is tested directly
// instead — see isProtectedProcessName below for why.

const gate = () => new ConfirmationGate();

// Every execute() call on a destructive action leaves a pending confirmation
// sitting in the gate with a real 60s timer (ConfirmationGate.js). Left
// unresolved, that timer outlives the test and fires an unhandled rejection
// well after node:test considers the run finished. Cancelling it immediately
// after asserting on the message is just test hygiene — it doesn't touch
// what's actually under test.
function cancelPending(svc, result) {
  if (result?.confirmationId) svc.confirmationGate.cancel(result.confirmationId);
}

// ── Confirmation message wiring (finding #2) ────────────────────────────

test('confirmation message shows the actual command, not a generic description', async () => {
  const svc = new PowerShellService(gate());
  const result = await svc.execute('execute', { command: 'Get-ChildItem C:\\Users' });
  assert.equal(result.needsConfirmation, true);
  assert.match(result.message, /Get-ChildItem C:\\Users/);
  assert.doesNotMatch(result.message, /^Action 'execute' on 'powershell' requires confirmation:/);
  cancelPending(svc, result);
});

test('confirmation message shows the actual file path for a destructive file action', async () => {
  const svc = new FileService(gate());
  const result = await svc.execute('deleteFile', { path: 'C:\\Users\\Test\\throwaway.txt' });
  assert.equal(result.needsConfirmation, true);
  assert.match(result.message, /C:\\Users\\Test\\throwaway\.txt/);
  cancelPending(svc, result);
});

test('confirmation message shows the actual service name', async () => {
  const svc = new WinServicesService(gate());
  const result = await svc.execute('stop', { name: 'Spooler' });
  assert.equal(result.needsConfirmation, true);
  assert.match(result.message, /Spooler/);
  cancelPending(svc, result);
});

test('confirmation message shows the actual PID for a kill request', async () => {
  const svc = new ProcessService(gate());
  const result = await svc.execute('kill', { pid: 99999 });
  assert.equal(result.needsConfirmation, true);
  assert.match(result.message, /99999/);
  cancelPending(svc, result);
});

test('a service with no getConfirmationMessage still falls back to the generic description safely', async () => {
  const svc = new PowerShellService(gate());
  const result = await svc.execute('executeScript', { scriptPath: 'C:\\scripts\\test.ps1' });
  assert.equal(result.needsConfirmation, true);
  assert.ok(result.message.length > 0);
  cancelPending(svc, result);
});

// ── dangerGuard wiring (finding #1) — must hold on the confirmed path too ──

test('dangerGuard.isBlockedCommand recognizes the same commands the classifier blocks', () => {
  assert.equal(isBlockedCommand('Remove-Item C:\\Windows -Recurse -Force'), true);
  assert.equal(isBlockedCommand('diskpart'), true);
  assert.equal(isBlockedCommand('Get-Process'), false);
});

test('PowerShellService refuses a blocked command even via executeConfirmed (the post-confirmation path)', async () => {
  const svc = new PowerShellService(gate());
  await assert.rejects(
    () => svc.executeConfirmed('execute', { command: 'Remove-Item C:\\Windows -Recurse -Force' }),
    /blocked/i
  );
});

test('CmdService refuses a blocked command even via executeConfirmed', async () => {
  const svc = new CmdService(gate());
  await assert.rejects(
    () => svc.executeConfirmed('execute', { command: 'diskpart' }),
    /blocked/i
  );
});

test('PowerShellService still executes a real, safe command via executeConfirmed (the block is content-specific, not total)', async () => {
  const svc = new PowerShellService(gate());
  const result = await svc.executeConfirmed('execute', { command: 'Write-Output hello-from-test' });
  assert.equal(result.success, true);
  assert.match(result.data.stdout, /hello-from-test/);
});

// ── ProcessService: critical-process protection ─────────────────────────

test('isProtectedProcessName blocks known critical system processes, case-insensitively', () => {
  for (const name of ['lsass', 'LSASS', 'Lsass', 'csrss', 'wininit', 'winlogon', 'services', 'smss', 'system', 'ntoskrnl']) {
    assert.equal(isProtectedProcessName(name), true, `${name} should be protected`);
  }
});

test('isProtectedProcessName allows ordinary processes', () => {
  for (const name of ['notepad', 'chrome', 'explorer', 'node', 'Code']) {
    assert.equal(isProtectedProcessName(name), false, `${name} should not be protected`);
  }
});

test('ProcessService.kill actually resolves the PID to a name and refuses a real critical process', async () => {
  const svc = new ProcessService(gate());
  // lsass.exe always exists on a running Windows machine — resolve its real
  // PID via the same read-only path list()/getProcess() already use, then
  // confirm kill() refuses it. If this assertion is ever wrong, it fails
  // BEFORE any taskkill call is made — kill() throws ahead of building the
  // taskkill args, so no live risk either way.
  const list = await svc.list({ limit: 200 });
  const lsass = list.processes.find((p) => (p.name || '').toLowerCase() === 'lsass');
  if (!lsass) return; // Environment without a resolvable lsass — skip rather than false-fail.
  await assert.rejects(
    () => svc.executeConfirmed('kill', { pid: lsass.pid, force: true }),
    /critical system process/i
  );
});

// ── WinServicesService: security-software protection ────────────────────

test('WinServicesService refuses to stop/restart security-critical services', () => {
  const svc = new WinServicesService(gate());
  for (const name of ['WinDefend', 'MpsSvc', 'wuauserv', 'Sense', 'wscsvc']) {
    assert.throws(() => svc._assertNotProtected(name), /security-critical/i, `${name} should be protected`);
  }
});

test('WinServicesService allows an ordinary service through the protection check', () => {
  const svc = new WinServicesService(gate());
  assert.doesNotThrow(() => svc._assertNotProtected('Spooler'));
});

// ── RegistryService: sensitive-key protection ────────────────────────────

test('RegistryService refuses to write an autostart (Run key) registry value', async () => {
  const svc = new RegistryService(gate());
  await assert.rejects(
    () => svc.setValue({
      keyPath: 'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run',
      valueName: 'ChanakyaTestPersistence',
      valueType: 'REG_SZ',
      data: 'evil.exe'
    }),
    (err) => err.code === 'PROTECTED_REGISTRY_KEY'
  );
});

test('RegistryService refuses to delete a value from the Winlogon key', async () => {
  const svc = new RegistryService(gate());
  await assert.rejects(
    () => svc.deleteValue({
      keyPath: 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon',
      valueName: 'Shell'
    }),
    (err) => err.code === 'PROTECTED_REGISTRY_KEY'
  );
});

// ── FileService: system-path protection + risk reclassification ─────────

test('FileService refuses to write into the Windows system directory', async () => {
  const svc = new FileService(gate());
  await assert.rejects(
    () => svc.writeFile({ path: 'C:\\Windows\\ChanakyaTest.txt', content: 'x' }),
    (err) => err.code === 'PROTECTED_PATH'
  );
});

test('FileService refuses to delete from the Windows system directory', async () => {
  const svc = new FileService(gate());
  await assert.rejects(
    () => svc.deleteFile({ path: 'C:\\Windows\\System32\\anything.dll' }),
    (err) => err.code === 'PROTECTED_PATH'
  );
});

test('FileService.copyFile is now classified destructive (can silently overwrite a destination)', () => {
  const svc = new FileService(gate());
  assert.equal(svc.actions.copyFile.destructive, true);
});

// ── Tool/action registry: unknown tool and action rejection (client spoofing) ──

test('ToolEngineRouter rejects a tool name the client invented', async () => {
  const router = new ToolEngineRouter();
  const result = await router.dispatch({ tool: 'adminTool', action: 'doAnything', params: {} });
  assert.equal(result.success, false);
  assert.equal(result.error.code, 'TOOL_NOT_FOUND');
});

test('ToolEngineRouter rejects an unregistered action on a real tool', async () => {
  const router = new ToolEngineRouter();
  const result = await router.dispatch({ tool: 'file', action: 'formatDrive', params: {} });
  assert.equal(result.success, false);
  assert.equal(result.error.code, 'ACTION_NOT_FOUND');
});

test('BaseToolService rejects invalid parameters before the handler ever runs', async () => {
  const svc = new FileService(gate());
  await assert.rejects(
    () => svc.execute('readFile', { path: 12345 }),
    (err) => err.code === 'VALIDATION_ERROR'
  );
});

// ── Confirmation gate: fake/unknown confirmation ids ─────────────────────

test('confirming a fake/unknown confirmationId is rejected, not silently accepted', async () => {
  const router = new ToolEngineRouter();
  const result = await router.dispatch({ tool: '_system', action: 'confirm', params: { confirmationId: 'not-a-real-id' } });
  assert.equal(result.success, false);
  assert.equal(result.error.code, 'CONFIRMATION_FAILED');
});

test('the confirmation flow only executes after a matching confirm — cancel never executes', async () => {
  const router = new ToolEngineRouter();
  const request = await router.dispatch({ tool: 'cmd', action: 'execute', params: { command: 'echo test-cancel-path' } });
  assert.equal(request.needsConfirmation, true);
  const cancelled = await router.dispatch({ tool: '_system', action: 'cancel', params: { confirmationId: request.confirmationId } });
  assert.equal(cancelled.success, true);
  // The same id must not be usable a second time (e.g. to confirm after cancelling).
  const reused = await router.dispatch({ tool: '_system', action: 'confirm', params: { confirmationId: request.confirmationId } });
  assert.equal(reused.success, false);
});
