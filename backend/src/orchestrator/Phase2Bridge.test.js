import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ExecutionLedger } from '../../../frontend/tools/ExecutionLedger.js';
import { executionContext } from '../../../frontend/tools/ExecutionContext.js';
import { createToolBridgeServer } from '../../../frontend/electron/ipc/toolBridgeServer.js';
import { callTool, inspectToolCall } from './ToolEngineBridge.js';
import { runOrchestrator, resumeOrchestrator } from './AgentOrchestrator.js';
import { createCheckpointStore } from './CheckpointStore.js';
import { executeStep } from './AgentExecutor.js';
import { verifyCapabilities } from './CapabilityContracts.js';

async function bridgeFor(t,dispatch) {
  const ledger=new ExecutionLedger({dispatch}); const bridge=await createToolBridgeServer(ledger);
  const oldUrl=process.env.TOOL_ENGINE_INTERNAL_URL, oldSecret=process.env.TOOL_ENGINE_SESSION_SECRET;
  process.env.TOOL_ENGINE_INTERNAL_URL=bridge.url;process.env.TOOL_ENGINE_SESSION_SECRET=bridge.secret;
  t.after(()=>{
    for(const [key,value] of [['TOOL_ENGINE_INTERNAL_URL',oldUrl],['TOOL_ENGINE_SESSION_SECRET',oldSecret]]) if(value===undefined) delete process.env[key];else process.env[key]=value;
    bridge.server.closeAllConnections();bridge.server.close();
  });
  return {ledger,bridge};
}
test('backend cancellation propagates over authenticated HTTP using the exact requestId',async t=>{
  let signal, started;const ready=new Promise(resolve=>started=resolve);
  await bridgeFor(t,()=>{signal=executionContext.getStore().signal;started();return new Promise(()=>{});});
  const abort=new AbortController();
  const request={tool:'hardware',action:'systemInfo',params:{},toolCallId:'model/id',requestId:'request-1',idempotencyKey:'key-1'};
  const pending=callTool(request,{ownerId:'alice',signal:abort.signal});await ready;abort.abort();
  const result=await pending;assert.equal(signal.aborted,true);assert.equal(result.error.code,'EXECUTION_UNCERTAIN');
  assert.equal((await inspectToolCall('key-1','alice')).status,'uncertain');
});
test('lost response preserves act checkpoint; explicit resume consumes result without replay',async t=>{
  let calls=0; await bridgeFor(t,()=>{calls++;return {success:true,data:{total:100,free:40,used:60,usagePercent:60}};});
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'phase2-disconnect-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const save=createCheckpointStore(dir);
  const dependencies={save,createLogger:()=>({log(){}}),routeTask:async()=>({mode:'agentic'}),createOrchestratorPlan:async()=>({steps:[{tool:'hardware',action:'memoryUsage',params:{}}]}),
    executeStep:async(s,options)=>{await executeStep(s,options);return {success:false,error:{code:'BRIDGE_NETWORK_ERROR',message:'Disconnected after dispatch'}};},verifyOutcome:async({steps})=>verifyCapabilities(steps)};
  const interrupted=await runOrchestrator({task:'memory',userId:'alice',dependencies});
  assert.equal(interrupted.phase,'act');assert.equal(interrupted.stopped,'recovery_required');assert.equal(calls,1);
  const saved=save.load(interrupted.sessionId,'alice');
  const resumed=await resumeOrchestrator({sessionId:interrupted.sessionId,userId:'alice',expectedRevision:saved.revision,dependencies:{...dependencies,executeStep}});
  assert.equal(resumed.success,true);assert.equal(calls,1);
});
test('bridge secret rotates and missing configuration fails closed',async t=>{
  const {bridge}=await bridgeFor(t,async()=>({success:true}));
  const second=await createToolBridgeServer(new ExecutionLedger({dispatch:async()=>({success:true})}));
  t.after(()=>{second.server.closeAllConnections();second.server.close();});assert.notEqual(second.secret,bridge.secret);
  delete process.env.TOOL_ENGINE_SESSION_SECRET;
  const result=await callTool({requestId:'r',idempotencyKey:'k',toolCallId:'id'},{ownerId:'alice'});assert.equal(result.success,false);
});
