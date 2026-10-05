import {configureDesktopRuntime} from '../../tools/DesktopRuntime.js';
import {desktopDebugLines} from '../../tools/DesktopCapabilityDiagnostics.js';
import { ipcMain, app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ToolEngineRouter } from '../../tools/ToolEngineRouter.js';
import { ExecutionLedger } from '../../tools/ExecutionLedger.js';
import { createToolBridgeServer } from './toolBridgeServer.js';
import { requireTrustedSender } from '../utils/ipcTrust.js';
import { wireRepairLedger } from '../../tools/repair/wireRepairLedger.js';
import { createProtectedRunner } from '../../tools/repair/ProtectedRunner.js';
import { executionContext } from '../../tools/ExecutionContext.js';
import { resolveToolActor } from '../services/ToolActor.js';

let ledger;
let bridge;
function getLedger() {
  if (!ledger) {
    configureDesktopRuntime({isPackaged:app.isPackaged,resourcesPath:process.resourcesPath});
    const workspace=path.join(app.getPath('userData'),'tool-workspace');
    fs.mkdirSync(workspace,{recursive:true});
    const router = new ToolEngineRouter({ appOptions:{directory:path.join(app.getPath('userData'),'app-registry')}, pathOptions:{readRoots:[workspace,app.getPath('documents')],writeRoots:[workspace]},auditDirectory:path.join(app.getPath('userData'),'security-audit'),confirmationDirectory: path.join(app.getPath('userData'), 'tool-confirmations'), repairOptions:{directory:path.join(app.getPath('userData'),'repair-journal'),runner:createProtectedRunner({packaged:app.isPackaged})} });
    ledger = new ExecutionLedger({
      directory: path.join(app.getPath('userData'), 'tool-execution-ledger'),
      timeoutMs:60000,
      dispatch: (request, sender) => router.dispatch(request, sender),

    });
    wireRepairLedger(ledger,router);
    ledger.toolRegistry=router.registry;
    ledger.ready=router.ready;
    ledger.desktopDiagnostics=()=>{router.getTools({model:true});return router.desktopDiagnostics;};
    const diagnostics=ledger.desktopDiagnostics();
    if(process.env.CHANAKYA_DEBUG_DESKTOP==='1'){console.info('[DesktopCapabilityDiagnostics]',JSON.stringify(diagnostics));console.info(desktopDebugLines(diagnostics));}
    else if(!diagnostics.desktopControl.ready)console.warn('[DesktopCapabilityDiagnostics]',diagnostics.desktopControl.reasons.join(', '));
  }
  return ledger;
}
export function registerToolIPCHandlers() {
  ipcMain.handle('tool:desktop-status',requireTrustedSender(async()=>{const current=getLedger();await current.ready;return {desktopControl:current.desktopDiagnostics().desktopControl};}));
  ipcMain.handle('tool:approve',requireTrustedSender(async(event,request)=>getLedger().execute(await resolveToolActor(event.sender.id),{...request,tool:'_system',action:'confirm'},event.sender,{humanApproved:true})));
  ipcMain.handle('tool:renew-confirmation', requireTrustedSender(async(event, request) =>
    getLedger().renewConfirmation(request.confirmationId, request.renewalId, await resolveToolActor(event.sender.id))));
  ipcMain.handle('tool:execute', requireTrustedSender(async (event, request) => {
    const current=getLedger();await current.ready;
    const scope = await resolveToolActor(event.sender.id);
    if (request?.tool === '_system' && request.action === 'getTools') {
      return executionContext.run({origin:'model',scope},()=>getLedger().dispatch(request,event.sender));
    }
    // Older manual callers still work, while controlled calls provide stable identities.
    const id = request?.tool === '_system' && request.action === 'confirm' ? `confirm:${request.params?.confirmationId}` : randomUUID();
    return getLedger().execute(scope, {
      ...request, toolCallId: request?.toolCallId || id,
      requestId: request?.requestId || id,
      idempotencyKey: request?.idempotencyKey || (request?.action === 'confirm' ? `confirm:${request.params?.confirmationId}` : id),
    }, event.sender);
  }));
  ipcMain.handle('tool:cancel-request', requireTrustedSender(async(event, requestId) =>
    getLedger().cancel(await resolveToolActor(event.sender.id), requestId)));
}
export async function startInternalToolServer() {
  const current=getLedger();await current.ready;
  if (!bridge) bridge = await createToolBridgeServer(current);
  return { url: bridge.url, secret: bridge.secret };
}
export function stopInternalToolServer() {
  bridge?.server.close();
  bridge = null;
}
