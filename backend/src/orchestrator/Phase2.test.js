import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ExecutionController } from './ExecutionController.js';
import { createCheckpointStore } from './CheckpointStore.js';
import { checkpoint, updateCurrentStep } from './AgentState.js';
import { reconcileCheckpoint, loadResumeController } from './CheckpointRecovery.js';
import { resumeOrchestrator } from './AgentOrchestrator.js';
import { claimSession, cancelSessionRequest } from './ExecutionSessions.js';
import { validateAndNormaliseLLMSteps } from './OrchestratorPlanner.js';
import { executeStep } from './AgentExecutor.js';
import { verificationPredicates, verifyCapabilities, validateCapability } from './CapabilityContracts.js';
import { executeCancellableTool } from '../../../frontend/src/services/chatExecution.js';

const step={tool:'hardware',action:'memoryUsage',params:{},toolCallId:'exact-model-id'};
const data={total:100,free:40,used:60,usagePercent:60};
function setup(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'phase2-checkpoint-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const save=createCheckpointStore(dir);
  const c=new ExecutionController('memory diagnostics',{ownerId:'alice',save}); c.plan([step]);
  return {save,c};
}
function evidence(c) {
  const s=c.state.plan[0];
  const identity={requestId:s.requestId,idempotencyKey:s.idempotencyKey,toolCallId:s.toolCallId};
  return {status:'completed',...identity,result:{success:true,data,...identity}};
}
test('checkpoint round trip enforces owner, path, revision, terminal state', t=>{
  const {c,save}=setup(t);
  assert.deepEqual(save.load(c.state.sessionId,'alice'),checkpoint(c.state));
  assert.throws(()=>save.load(c.state.sessionId,'bob'),{status:404});
  assert.throws(()=>save.load('../secret','alice'));
  assert.throws(()=>loadResumeController(save,c.state.sessionId,'alice',0),{status:409});
  c.stop('cancelled','test');
  assert.throws(()=>loadResumeController(save,c.state.sessionId,'alice',c.state.revision),{status:409});
});
for(const phase of ['act','observe']) test(`crash at ${phase}: ledger result resumes without duplicate dispatch`,async t=>{
  const {c,save}=setup(t); c.move('act'); if(phase==='observe') c.move('observe');
  const expected=evidence(c); let calls=0;
  const result=await resumeOrchestrator({sessionId:c.state.sessionId,userId:'alice',expectedRevision:c.state.revision,dependencies:{save,
    inspectToolCall:async()=>expected,executeStep:async()=>{calls++;throw new Error('duplicate');},verifyOutcome:async({steps})=>verifyCapabilities(steps)}});
  assert.equal(result.success,true); assert.equal(calls,0); assert.equal(result.stepCount,1);
  assert.equal(save.load(c.state.sessionId,'alice').state.attempts[0].observation.toolCallId,'exact-model-id');
});
for(const status of ['unknown','running','uncertain']) test(`${status} side effects block resume without changing checkpoint`,async t=>{
  const {c,save}=setup(t);c.move('act');const before=save.load(c.state.sessionId,'alice');
  await assert.rejects(resumeOrchestrator({sessionId:c.state.sessionId,userId:'alice',expectedRevision:c.state.revision,dependencies:{save,inspectToolCall:async()=>({status})}}),{status:409});
  assert.deepEqual(save.load(c.state.sessionId,'alice'),before);
});
test('wrong result identity cannot reconcile',async t=>{
  const {c}=setup(t);c.move('act');const record=evidence(c);record.result.toolCallId='another';
  await assert.rejects(reconcileCheckpoint(c,async()=>record),{status:409});assert.equal(c.state.phase,'act');
});
test('crash after persisted observation advances without querying or replaying',async t=>{
  const {c}=setup(t);c.move('act');c.move('observe');
  c.commit(updateCurrentStep(c.state,'done',{success:true,data,toolCallId:'exact-model-id'}));
  await reconcileCheckpoint(c,()=>{throw new Error('unexpected');});assert.equal(c.state.phase,'decide');
});
test('explicit confirmation resume retains model identity and uses a stable continuation key',async t=>{
  const {c,save}=setup(t);
  await c.execute(async()=>({needsConfirmation:true,confirmationId:'approval-1'}));
  await assert.rejects(resumeOrchestrator({sessionId:c.state.sessionId,userId:'alice',expectedRevision:c.state.revision,dependencies:{save}}),{status:409});
  let received;
  const result=await resumeOrchestrator({sessionId:c.state.sessionId,userId:'alice',expectedRevision:c.state.revision,confirmationId:'approval-1',dependencies:{save,
    executeStep:async s=>{received=s;return {success:true,data,toolCallId:s.toolCallId};},verifyOutcome:async({steps})=>verifyCapabilities(steps)}});
  assert.equal(result.success,true);assert.equal(received.toolCallId,'exact-model-id');assert.equal(received.confirmationId,'approval-1');
  assert.equal(received.idempotencyKey,`${c.state.sessionId}:confirm:approval-1`);assert.equal(result.stepCount,2);
  await assert.rejects(resumeOrchestrator({sessionId:c.state.sessionId,userId:'alice',expectedRevision:c.state.revision,confirmationId:'approval-1',dependencies:{save}}),{status:409});
});
test('session lock and requestId cancellation enforce ownership',t=>{
  const {c}=setup(t);c.move('act');const lease=claimSession(c);
  try {
    assert.throws(()=>claimSession(c),{status:409});
    assert.equal(cancelSessionRequest(c.state.sessionId,'bob',c.state.plan[0].requestId),false);
    assert.equal(cancelSessionRequest(c.state.sessionId,'alice','invented'),false);
    assert.equal(lease.signal.aborted,false);
    assert.equal(cancelSessionRequest(c.state.sessionId,'alice',c.state.plan[0].requestId),true);assert.equal(lease.signal.aborted,true);
  } finally {lease.release();}
});
test('chat cancellation forwards exact requestId and removes its listener',async()=>{
  const abort=new AbortController();let cancelled;let finish;
  const engine={execute:()=>new Promise(resolve=>finish=resolve),cancelRequest:async id=>{cancelled=id;}};
  const result=executeCancellableTool(engine,'hardware','memoryUsage',{},'model',{requestId:'request-exact',idempotencyKey:'key',signal:abort.signal});
  abort.abort();assert.equal(cancelled,'request-exact');finish({success:false});await result;
});
test('missing required parameter is rejected by planner and executor',async()=>{
  const bad={tool:'app',action:'openApp',params:{}};
  assert.deepEqual(validateAndNormaliseLLMSteps([bad]),[]);
  assert.equal((await executeStep(bad)).error.code,'VALIDATION_ERROR');
  for(const params of [{command:' '},{command:'app',extra:true},{command:'app',args:[7]},[]]) assert.ok(validateCapability('process','startProcess',params));
  assert.equal(validateCapability('process','startProcess',{command:'app',args:['--help'],detached:true}),null);
});
const fixtures={
  'process.startProcess':{pid:123,command:'notepad',readiness:{status:'ready',pid:123,criterion:'responding_window',windowTitle:'Untitled - Notepad',observedAt:'2026-09-19T00:00:00.000Z'}},
  'hardware.systemInfo':{hostname:'pc',platform:'win32',cpuModel:'cpu',cpuCores:4,totalMemory:100,freeMemory:20},
  'hardware.cpuUsage':{usagePercent:20,perCore:[{core:0,usagePercent:20}]},
  'hardware.memoryUsage':data,
  'hardware.diskInfo':{drives:[{DeviceID:'C:',Size:100,FreeSpace:30}]},
  'hardware.networkAdapters':{adapters:[{Description:'Ethernet'}]},
  'network.ipConfig':{adapters:[{name:'Ethernet'}]},
  'network.netstat':{connections:[{LocalAddress:'127.0.0.1',LocalPort:80}]},
  'process.list':{processes:[{pid:1,name:'test'}],total:1},
  'network.ping':{host:'example.com',sent:4,received:4,lost:0,lossPercent:0,roundTrip:{min:1,avg:2,max:3}},
};
for(const [key,fixture] of Object.entries(fixtures)) test(`deterministic verification: ${key}`,()=>{
  const [tool,action]=key.split('.');const params=key==='network.ping'?{host:'example.com'}:key==='process.startProcess'?{command:'notepad'}:{};const s={tool,action,params,toolCallId:'id',status:'done',observation:{toolCallId:'id',success:true,data:fixture}};
  assert.equal(verifyCapabilities([s]).success,true);
  assert.equal(verifyCapabilities([{...s,observation:{...s.observation,data:{}}}]).success,false);
  assert.equal(verifyCapabilities([{...s,observation:{...s.observation,toolCallId:'wrong'}}]).success,false);
});
test('verification does not treat packet loss or inconsistent memory as successful diagnostics',()=>{
  assert.equal(verificationPredicates['network.ping']({...fixtures['network.ping'],received:0,lost:4},{host:'example.com'}),false);
  assert.equal(verificationPredicates['hardware.memoryUsage']({...data,used:101}),false);
});
