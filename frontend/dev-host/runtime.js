/**
 * @module dev-host/runtime
 * @description Builds the same ToolEngineRouter + ExecutionLedger the packaged
 * app builds in electron/ipc/tool.ipc.js, without importing Electron.
 *
 * Deliberate differences from the exe (all fail closed, none weaken a gate):
 *  - isPackaged is false, so the Program-Files-only Windows repair runner
 *    (createProtectedRunner) refuses to run: PROTECTED_INSTALL_REQUIRED.
 *  - No Electron safeStorage/DPAPI here, so the durable software-plan key is
 *    null and protected software installs stay unavailable.
 *  - State lives in a separate "Chanakya AI Dev" directory, never in the
 *    installed app's userData.
 * Everything else (permission levels, confirmation gate, danger classifier,
 * audit, ledger idempotency) is the shared code under ../tools.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configureDesktopRuntime } from '../tools/DesktopRuntime.js';
import { ToolEngineRouter } from '../tools/ToolEngineRouter.js';
import { ExecutionLedger } from '../tools/ExecutionLedger.js';
import { wireRepairLedger } from '../tools/repair/wireRepairLedger.js';
import { createProtectedRunner } from '../tools/repair/ProtectedRunner.js';

export function defaultUserDataDir(env = process.env) {
  if (env.CHANAKYA_USER_DATA_DIR) return path.resolve(env.CHANAKYA_USER_DATA_DIR);
  const base = env.APPDATA || path.join(os.homedir(), '.config');
  return path.join(base, 'Chanakya AI Dev');
}

export function createDevToolRuntime({
  userDataDir = defaultUserDataDir(),
  documentsDir = path.join(os.homedir(), 'Documents'),
} = {}) {
  configureDesktopRuntime({ isPackaged: false });
  const workspace = path.join(userDataDir, 'tool-workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const router = new ToolEngineRouter({
    softwareOptions: { directory: path.join(userDataDir, 'software'), key: null },
    appOptions: { directory: path.join(userDataDir, 'app-registry') },
    pathOptions: { readRoots: [workspace, documentsDir], writeRoots: [workspace] },
    auditDirectory: path.join(userDataDir, 'security-audit'),
    confirmationDirectory: path.join(userDataDir, 'tool-confirmations'),
    repairOptions: {
      directory: path.join(userDataDir, 'repair-journal'),
      runner: createProtectedRunner({ packaged: false }),
    },
  });
  const ledger = new ExecutionLedger({
    directory: path.join(userDataDir, 'tool-execution-ledger'),
    timeoutMs: 60000,
    timeoutFor: (request) => {
      const pending =
        request.tool === '_system' && request.action === 'confirm'
          ? router.gate.getRecord(request.params?.confirmationId)?.metadata
          : null;
      const name = `${pending?.tool || request.tool}.${pending?.action || request.action}`;
      return (router.registry.get(name)?.timeout || 60000) + 10000;
    },
    dispatch: (request, sender) => router.dispatch(request, sender),
  });
  wireRepairLedger(ledger, router);
  ledger.toolRegistry = router.registry;
  ledger.router = router;
  ledger.ready = router.ready;
  ledger.desktopDiagnostics = () => {
    router.getTools({ model: true });
    return router.desktopDiagnostics;
  };
  return { ledger, router, userDataDir };
}
