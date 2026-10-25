import { configureDesktopRuntime } from '../../tools/DesktopRuntime.js';
import { desktopDebugLines } from '../../tools/DesktopCapabilityDiagnostics.js';
import { ipcMain, app, dialog, safeStorage, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ToolEngineRouter } from '../../tools/ToolEngineRouter.js';
import { ExecutionLedger } from '../../tools/ExecutionLedger.js';
import { createToolBridgeServer } from './toolBridgeServer.js';
import { requireTrustedSender } from '../utils/ipcTrust.js';
import { wireRepairLedger } from '../../tools/repair/wireRepairLedger.js';
import { createProtectedRunner } from '../../tools/repair/ProtectedRunner.js';
import { executionContext, stopOwnedHelpers } from '../../tools/ExecutionContext.js';
import { resolveToolActor } from '../services/ToolActor.js';
import { verifyWindowsProposal } from '../../tools/security/ModelRouteAuthority.js';
import { protectedSoftwareKey } from '../services/SoftwareKey.js';

let ledger;
let bridge;
const executionProgressFor = (event) => (progress) => {
  if (!event.sender.isDestroyed()) event.sender.send('tool:progress', progress);
};
function getLedger() {
  if (!ledger) {
    configureDesktopRuntime({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
    });
    const workspace = path.join(app.getPath('userData'), 'tool-workspace');
    fs.mkdirSync(workspace, { recursive: true });
    let softwareKey = null;
    try {
      softwareKey = protectedSoftwareKey(
        path.join(app.getPath('userData'), 'software'),
        safeStorage,
      );
    } catch {
      console.warn(
        '[Software] Protected software storage is unavailable; existing desktop tools remain available.',
      );
    }
    const router = new ToolEngineRouter({
      softwareOptions: {
        directory: path.join(app.getPath('userData'), 'software'),
        key: softwareKey,
      },
      appOptions: {
        directory: path.join(app.getPath('userData'), 'app-registry'),
      },
      pathOptions: {
        readRoots: [workspace, app.getPath('documents')],
        writeRoots: [workspace],
      },
      auditDirectory: path.join(app.getPath('userData'), 'security-audit'),
      confirmationDirectory: path.join(app.getPath('userData'), 'tool-confirmations'),
      repairOptions: {
        directory: path.join(app.getPath('userData'), 'repair-journal'),
        runner: createProtectedRunner({ packaged: app.isPackaged }),
      },
    });
    ledger = new ExecutionLedger({
      directory: path.join(app.getPath('userData'), 'tool-execution-ledger'),
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
    const diagnostics = ledger.desktopDiagnostics();
    if (process.env.CHANAKYA_DEBUG_DESKTOP === '1') {
      console.info('[DesktopCapabilityDiagnostics]', JSON.stringify(diagnostics));
      console.info(desktopDebugLines(diagnostics));
    } else if (!diagnostics.desktopControl.ready)
      console.warn('[DesktopCapabilityDiagnostics]', diagnostics.desktopControl.reasons.join(', '));
  }
  return ledger;
}
export function registerToolIPCHandlers() {
  const operatorSoftware = async (event, action, params = {}) => {
    const current = getLedger();
    await current.ready;
    const id = randomUUID();
    return current.execute(
      await resolveToolActor(event.sender.id),
      { tool: 'software', action, params, toolCallId: id, requestId: id, idempotencyKey: id },
      event.sender,
      { origin: 'operator', modelRoute: 'windows' },
    );
  };
  ipcMain.handle(
    'software:providers',
    requireTrustedSender((event) => operatorSoftware(event, 'providers')),
  );
  ipcMain.handle(
    'software:discover',
    requireTrustedSender((event, query, online = false) =>
      operatorSoftware(event, online === true ? 'discoverOnline' : 'discover', { query }),
    ),
  );
  ipcMain.handle(
    'software:resolve',
    requireTrustedSender((event, candidateId) =>
      operatorSoftware(event, 'resolve', { candidateId }),
    ),
  );
  ipcMain.handle(
    'software:action',
    requireTrustedSender((event, action, planId) => {
      if (!['download', 'install', 'verify'].includes(action))
        throw new Error('Unsupported software action.');
      return operatorSoftware(event, action, { planId });
    }),
  );
  ipcMain.handle(
    'software:register-source',
    requireTrustedSender(async (event, descriptor, credential) => {
      const current = getLedger();
      await current.ready;
      const actor = await resolveToolActor(event.sender.id);
      const registrationId = executionContext.run(
        { authenticated: true, scope: actor, origin: 'operator' },
        () => current.router.services.get('software').stageRegistration(descriptor, credential),
      );
      return operatorSoftware(event, 'registerProvider', { registrationId });
    }),
  );
  ipcMain.handle(
    'software:remove-source',
    requireTrustedSender((event, registrationId) =>
      operatorSoftware(event, 'removeProvider', { registrationId }),
    ),
  );
  ipcMain.handle(
    'software:choose',
    requireTrustedSender(async (event, discoveryId, candidateId) => {
      const current = getLedger();
      await current.ready;
      const actor = await resolveToolActor(event.sender.id);
      return executionContext.run(
        { authenticated: true, scope: actor, origin: 'operator', humanApproved: true },
        () => current.router.services.get('software').chooseCandidate(discoveryId, candidateId),
      );
    }),
  );
  ipcMain.handle(
    'software:cancel-choice',
    requireTrustedSender(async (event, discoveryId) => {
      const current = getLedger();
      await current.ready;
      return executionContext.run(
        { authenticated: true, scope: await resolveToolActor(event.sender.id), origin: 'operator' },
        () => current.router.services.get('software').cancelChoice(discoveryId),
      );
    }),
  );
  ipcMain.handle(
    'software:pick-installer',
    requireTrustedSender(async (event, product) => {
      const current = getLedger();
      await current.ready;
      const actor = await resolveToolActor(event.sender.id);
      const selection = await dialog.showOpenDialog({
        title: 'Choose a signed offline software installer',
        properties: ['openFile', 'dontAddToRecent'],
        filters: [
          {
            name: 'Windows installers',
            extensions: ['exe', 'msi', 'msix', 'appx', 'msixbundle', 'appxbundle'],
          },
        ],
      });
      if (selection.canceled || selection.filePaths.length !== 1) return { cancelled: true };
      return executionContext.run({ authenticated: true, scope: actor, origin: 'operator' }, () =>
        current.router.services.get('software').stageOffline(selection.filePaths[0], product),
      );
    }),
  );
  ipcMain.handle(
    'software:pick-directory',
    requireTrustedSender(async (event) => {
      await resolveToolActor(event.sender.id);
      const selection = await dialog.showOpenDialog({
        title: 'Choose an offline installer repository',
        properties: ['openDirectory', 'dontAddToRecent'],
      });
      return {
        cancelled: selection.canceled,
        directory: selection.canceled ? null : selection.filePaths[0],
      };
    }),
  );
  ipcMain.handle(
    'software:reveal',
    requireTrustedSender(async (event, planId) => {
      const current = getLedger();
      await current.ready;
      const actor = await resolveToolActor(event.sender.id);
      const plan = executionContext.run(
        { authenticated: true, scope: actor, origin: 'operator' },
        () => current.router.services.get('software').activePlan(planId),
      );
      if (plan.protocol === 'handoff') {
        current.router.services.get('software').trust.assertUrl(plan.installer.url, plan);
        await shell.openExternal(plan.installer.url);
        return { revealed: true, handoff: true };
      }
      const cache = path.resolve(app.getPath('userData'), 'software', 'cache'),
        target = path.resolve(plan.installer.path || '');
      const relative = path.relative(cache, target);
      if (
        !relative ||
        relative.startsWith('..') ||
        path.isAbsolute(relative) ||
        !fs.existsSync(target) ||
        fs.lstatSync(target).isSymbolicLink()
      )
        throw new Error("The verified installer is unavailable in this app's private cache.");
      shell.showItemInFolder(target);
      return { revealed: true };
    }),
  );
  ipcMain.handle(
    'tool:desktop-status',
    requireTrustedSender(async () => {
      const current = getLedger();
      await current.ready;
      return { desktopControl: current.desktopDiagnostics().desktopControl };
    }),
  );
  ipcMain.handle(
    'tool:approve',
    requireTrustedSender(async (event, request) =>
      getLedger().execute(
        await resolveToolActor(event.sender.id),
        { ...request, tool: '_system', action: 'confirm' },
        event.sender,
        {
          humanApproved: true,
          onProgress: executionProgressFor(event),
          modelRoute: getLedger().router?.gate.getRecord(request.params?.confirmationId)?.metadata
            ?.authorization?.modelRoute,
          taskId: getLedger().router?.gate.getRecord(request.params?.confirmationId)?.metadata
            ?.authorization?.taskId,
          origin: getLedger().router?.gate.getRecord(request.params?.confirmationId)?.metadata
            ?.authorization?.origin,
        },
      ),
    ),
  );
  ipcMain.handle(
    'tool:app-permission',
    requireTrustedSender(async (event, params) => {
      const current = getLedger();
      await current.ready;
      const id = randomUUID();
      return current.execute(
        await resolveToolActor(event.sender.id),
        {
          tool: 'app',
          action: 'setAppPermission',
          params,
          toolCallId: id,
          requestId: id,
          idempotencyKey: id,
        },
        event.sender,
        { origin: 'operator', modelRoute: 'windows' },
      );
    }),
  );
  ipcMain.handle(
    'tool:select-offline-installer',
    requireTrustedSender(async (event, query) => {
      if (typeof query !== 'string' || !/^[^\x00-\x1f"'`$;&|<>^%*?\[\]{}\\!]{1,100}$/.test(query))
        throw new Error('Enter the application name first.');
      const current = getLedger();
      await current.ready;
      const scope = await resolveToolActor(event.sender.id);
      const selection = await dialog.showOpenDialog({
        title: 'Choose a signed offline Windows installer',
        properties: ['openFile'],
        filters: [{ name: 'Windows installers', extensions: ['exe', 'msi'] }],
      });
      if (selection.canceled || selection.filePaths.length !== 1) return { cancelled: true };
      return executionContext.run(
        {
          authenticated: true,
          origin: 'operator',
          scope,
          modelRoute: 'windows',
          taskId: randomUUID(),
        },
        () => current.router.services.get('webInstall').stageOffline(selection.filePaths[0], query),
      );
    }),
  );
  ipcMain.handle(
    'tool:request-offline-install',
    requireTrustedSender(async (event, downloadId) => {
      const current = getLedger();
      await current.ready;
      const scope = await resolveToolActor(event.sender.id);
      const record = current.router.services.get('webInstall').downloads.get(downloadId);
      if (!record || record.source !== 'offline' || record.owner !== scope)
        throw new Error('Choose and verify an offline installer in this account first.');
      const id = randomUUID();
      return current.execute(
        scope,
        {
          tool: 'webInstall',
          action: 'install',
          params: { downloadId },
          toolCallId: id,
          requestId: id,
          idempotencyKey: id,
        },
        event.sender,
        { origin: 'operator', modelRoute: 'windows' },
      );
    }),
  );
  // The user's answer to "which application?": a human-only system action, like an approval. The renderer sends ids, never paths.
  ipcMain.handle(
    'tool:choose-app',
    requireTrustedSender(async (event, request) =>
      getLedger().execute(
        await resolveToolActor(event.sender.id),
        { ...request, tool: '_system', action: 'chooseApp' },
        event.sender,
        { humanApproved: true, modelRoute: 'windows' },
      ),
    ),
  );
  ipcMain.handle(
    'tool:renew-confirmation',
    requireTrustedSender(async (event, request) =>
      getLedger().renewConfirmation(
        request.confirmationId,
        request.renewalId,
        await resolveToolActor(event.sender.id),
      ),
    ),
  );
  ipcMain.handle(
    'tool:execute',
    requireTrustedSender(async (event, request) => {
      const current = getLedger();
      await current.ready;
      const scope = await resolveToolActor(event.sender.id);
      if (request?.tool === '_system' && request.action === 'getTools') {
        return executionContext.run({ origin: 'model', scope }, () =>
          getLedger().dispatch(request, event.sender),
        );
      }
      // Older manual callers still work, while controlled calls provide stable identities.
      const id =
        request?.tool === '_system' && request.action === 'confirm'
          ? `confirm:${request.params?.confirmationId}`
          : randomUUID();
      const { routeGrant, ...typedRequest } = request || {};
      const authority = verifyWindowsProposal(routeGrant, typedRequest, scope, {
        secret: bridge?.secret,
      });
      // This fixed inventory API is used by the UI before chat, not offered to the model.
      const inventory =
        typedRequest.tool === 'app' &&
        ['listApps', 'refreshAppRegistry'].includes(typedRequest.action) &&
        !routeGrant;
      return getLedger().execute(
        scope,
        {
          ...typedRequest,
          toolCallId: request?.toolCallId || id,
          requestId: request?.requestId || id,
          idempotencyKey:
            request?.idempotencyKey ||
            (request?.action === 'confirm' ? `confirm:${request.params?.confirmationId}` : id),
        },
        event.sender,
        {
          modelRoute: authority?.route,
          onProgress: executionProgressFor(event),
          proposalId: authority?.toolCallId,
          proposalOwner: authority?.userId,
          ...(inventory ? { origin: 'operator' } : {}),
        },
      );
    }),
  );
  ipcMain.handle(
    'tool:cancel-request',
    requireTrustedSender(async (event, requestId) =>
      getLedger().cancel(await resolveToolActor(event.sender.id), requestId),
    ),
  );
}
export async function startInternalToolServer() {
  const current = getLedger();
  await current.ready;
  if (!bridge) bridge = await createToolBridgeServer(current);
  return { url: bridge.url, secret: bridge.secret };
}
export function stopInternalToolServer() {
  for (const active of ledger?.active?.values() || []) active.controller.abort();
  stopOwnedHelpers();
  bridge?.server.close();
  bridge = null;
}
