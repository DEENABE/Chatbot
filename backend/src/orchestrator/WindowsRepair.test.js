import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runWindowsRepair} from './WindowsRepairCapability.js';
import {resumeOrchestrator} from './AgentOrchestrator.js';
import {createCheckpointStore} from './CheckpointStore.js';
import {toolRequestForStep} from './AgentExecutor.js';
import {renewCheckpointConfirmation,reviewCheckpoint} from './ManualRecovery.js';
import {runLegacyExecution} from './LegacyExecutionAdapter.js';
import {ToolEngineRouter} from '../../../frontend/tools/ToolEngineRouter.js';
import {ExecutionLedger} from '../../../frontend/tools/ExecutionLedger.js';
import {wireRepairLedger} from '../../../frontend/tools/repair/wireRepairLedger.js';
function setup({runner:custom}={}) {
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'typed-spooler-'));let starts=0,status=1;
 const sample=()=>({platform:'win32',name:'Spooler',hostId:'h',bootId:'b',configHash:'a'.repeat(64),observedAt:Date.now(),status,stock:true,canStart:true,dependenciesRunning:true,startType:2});
 const runner=custom|| (async operation=>{if(operation==='inspect')return sample();if(operation==='start'){starts++;status=4;return {startDisposition:'accepted'};}return {samples:[{...sample(),observedAt:Date.now()-1000},sample()]};});
 const router=new ToolEngineRouter({confirmationDirectory:path.join(directory,'tokens'),repairOptions:{directory:path.join(directory,'repair'),runner}});
 const ledger=new ExecutionLedger({directory:path.join(directory,'ledger'),dispatch:r=>router.dispatch(r)});
 wireRepairLedger(ledger,router);
 const save=createCheckpointStore(path.join(directory,'checkpoints'));
 const execute=async(step,options)=>{
  const cancel=()=>ledger.cancel('backend:owner',step.requestId);options.signal?.addEventListener('abort',cancel,{once:true});
  try{return await ledger.execute('backend:owner',{...toolRequestForStep(step),admission:options.admission},null,{backend:true,humanApproved:!!step.confirmationId});}
  finally{options.signal?.removeEventListener('abort',cancel);}
 };
 const dependencies={save,recordRepair:()=>{},executeStep:execute,inspectToolCall:key=>ledger.status('backend:owner',key)};
 const run=(extra={})=>runWindowsRepair({goal:'printing is broken',userId:'owner',dependencies,...extra});
 const resume=(r,extra={})=>resumeOrchestrator({sessionId:r.sessionId,userId:'owner',expectedRevision:r.revision,confirmationId:r.confirmationId,dependencies,...extra});
 return {run,resume,save,router,ledger,dependencies,starts:()=>starts};
}
test('typed repair uses AgentState diagnosis, waiting approval, execution and deterministic completion',async()=>{
 const f=setup(),waiting=await f.run();assert.equal(waiting.phase,'waiting_confirmation');assert.equal(f.starts(),0);assert.equal(waiting.stepCount,2);
 const done=await f.resume(waiting);assert.equal(done.phase,'done');assert.equal(done.stepCount,4);assert.equal(done.retryCount,0);assert.equal(f.starts(),1);assert.equal(done.userIssueResolved,null);assert.equal(done.resolved,false);assert.match(done.summary,/printing has not been verified/);
 const s=f.save.load(done.sessionId,'owner').state;assert.equal(s.mode,'orchestrator');assert.equal(s.maxRetries,0);assert.equal(s.maxSteps,6);
 await assert.rejects(f.resume({...waiting,revision:done.revision}),/Terminal/);
});
test('missing human approval, foreign owner and stale revision cannot start',async()=>{
 const f=setup(),w=await f.run();
 await assert.rejects(f.resume(w,{confirmationId:undefined}),/approval/);
 await assert.rejects(f.resume(w,{userId:'other'}),/not found/);
 await assert.rejects(f.resume(w,{expectedRevision:w.revision-1}),/revision/);
 assert.equal(f.starts(),0);
});
test('durable diagnosis-bound renewal leaves waiting state and separate approval',async()=>{
 const f=setup(),w=await f.run();const saved=await renewCheckpointConfirmation({store:f.save,sessionId:w.sessionId,userId:'owner',expectedRevision:w.revision,renewalId:'r1',renew:(id,key)=>f.router.gate.renew(id,key,'backend:owner')});
 assert.equal(saved.state.phase,'waiting_confirmation');assert.equal(saved.state.stepCount,2);assert.equal(f.starts(),0);
 const token=saved.state.plan[saved.state.currentStepIndex].observation.confirmationId;
 const done=await f.resume({...w,revision:saved.revision,confirmationId:token});assert.equal(done.phase,'done');assert.equal(f.starts(),1);
});
test('uncertain mutation cannot replay on explicit resume',async()=>{
 const f=setup({runner:async operation=>{if(operation==='start')throw new Error('disconnect');return {platform:'win32',name:'Spooler',hostId:'h',bootId:'b',configHash:'a'.repeat(64),observedAt:Date.now(),status:1,stock:true,canStart:true,dependenciesRunning:true,startType:2};}});
 const w=await f.run(),uncertain=await f.resume(w);assert.equal(uncertain.phase,'act');
 await assert.rejects(f.resume(uncertain,{confirmationId:undefined}),/reconciliation/);
 assert.equal(Object.values(f.router.services.get('windowsRepair').store.state.operations).length,1);
});
test('failed verification never becomes done and never retries mutation',async()=>{
 let starts=0;const f=setup({runner:async op=>{if(op==='start'){starts++;return {startDisposition:'accepted'};}if(op==='verify')return {samples:[]};return {platform:'win32',name:'Spooler',hostId:'h',bootId:'b',configHash:'a'.repeat(64),observedAt:Date.now(),status:1,stock:true,canStart:true,dependenciesRunning:true,startType:2};}});
 const done=await f.resume(await f.run());assert.equal(done.phase,'error');assert.equal(done.success,false);assert.equal(starts,1);assert.equal(done.retryCount,0);
});
test('backend legacy production entry cannot run generated PowerShell',async()=>{
 const result=await runLegacyExecution({goal:'Start-Service Spooler',dependencies:{save:()=>{}}});assert.equal(result.success,false);assert.match(result.answer,/MODEL_CAPABILITY_DENIED/);assert.equal(result.state.stepCount,0);
});
test('unsupported repair has no tool execution or second repair',async()=>{
 let called=0;const result=await runWindowsRepair({goal:'reset network adapter',userId:'owner',dependencies:{save:()=>{},executeStep:()=>{called++;}}});assert.equal(result.phase,'error');assert.equal(called,0);
});
test('shared frontend and backend repair contract copies cannot drift',()=>{
 assert.equal(fs.readFileSync(new URL('./WindowsRepairContract.js',import.meta.url),'utf8'),fs.readFileSync(new URL('../../../frontend/tools/repair/contract.js',import.meta.url),'utf8'));
});

for(const disposition of ['completed','not_completed','abandon']) test(`manual ${disposition} recovery remains under AgentState without mutation replay`,async()=>{
 let starts=0;const sample=()=>({platform:'win32',name:'Spooler',hostId:'h',bootId:'b',configHash:'a'.repeat(64),observedAt:Date.now(),status:1,stock:true,canStart:true,dependenciesRunning:true,startType:2});
 const f=setup({runner:async op=>{if(op==='inspect')return sample();if(op==='start'){starts++;throw new Error('disconnect after start');}return {samples:[{...sample(),status:4,observedAt:Date.now()-1000},{...sample(),status:4}]};}});
 const uncertain=await f.resume(await f.run());const saved=f.save.load(uncertain.sessionId,'owner');const step=saved.state.plan[saved.state.currentStepIndex];
 const reviewed=await reviewCheckpoint({store:f.save,sessionId:uncertain.sessionId,userId:'owner',expectedRevision:uncertain.revision,requestId:step.requestId,idempotencyKey:step.idempotencyKey,toolCallId:step.toolCallId,
 review:{reviewId:'manual-review',disposition,note:'Original helper exited and service was inspected.',quiescenceConfirmed:true},reviewCall:(request,review)=>f.ledger.reconcileRepair('backend:owner',request,review)});
 assert.equal(reviewed.state.phase,disposition==='abandon'?'cancelled':'decide');assert.equal(starts,1);
 if(disposition==='abandon'){await assert.rejects(f.resume({...uncertain,revision:reviewed.revision}),/Terminal/);return;}
 const done=await f.resume({...uncertain,revision:reviewed.revision},{confirmationId:undefined});
 assert.equal(done.phase,disposition==='completed'?'done':disposition==='abandon'?'cancelled':'error');assert.equal(starts,1);assert.equal(done.retryCount,0);
});

test('crash after broker reconciliation before checkpoint save recovers from durable evidence',async()=>{
 const f=setup({runner:async op=>{if(op==='start')throw new Error('lost start');return {platform:'win32',name:'Spooler',hostId:'h',bootId:'b',configHash:'a'.repeat(64),observedAt:Date.now(),status:1,stock:true,canStart:true,dependenciesRunning:true,startType:2};}});
 const uncertain=await f.resume(await f.run()),s=f.save.load(uncertain.sessionId,'owner').state,step=s.plan[s.currentStepIndex];
 const request={...toolRequestForStep(step),repair:{action:step.action,params:step.params,admission:{sessionId:s.sessionId,revision:s.revision,taskType:s.taskType}}};
 const review={reviewId:'crash-review',disposition:'not_completed',note:'Helper exited and effect was not established.',quiescenceConfirmed:true};
 const evidence=await f.ledger.reconcileRepair('backend:owner',request,review);
 assert.deepEqual(await f.ledger.reconcileRepair('backend:owner',request,review),evidence);
 const recovered=await f.resume(uncertain,{confirmationId:undefined});assert.equal(recovered.phase,'error');assert.equal(recovered.retryCount,0);
});

test('cancelled uncertain repair permits effect reconciliation without reopening terminal state',async()=>{
 let entered,release;const ready=new Promise(r=>entered=r);
 const f=setup({runner:async op=>{if(op==='start'){entered();return new Promise(r=>release=r);}return {platform:'win32',name:'Spooler',hostId:'h',bootId:'b',configHash:'a'.repeat(64),observedAt:Date.now(),status:1,stock:true,canStart:true,dependenciesRunning:true,startType:2};}});
 const waiting=await f.run(),abort=new AbortController(),pending=f.resume(waiting,{signal:abort.signal});
 await ready;abort.abort();const cancelled=await pending;assert.equal(cancelled.phase,'cancelled');
 const s=f.save.load(cancelled.sessionId,'owner').state,step=s.plan[s.currentStepIndex];
 const args={store:f.save,sessionId:s.sessionId,userId:'owner',expectedRevision:s.revision,requestId:step.requestId,idempotencyKey:step.idempotencyKey,toolCallId:step.toolCallId,review:{reviewId:'cancel-review',disposition:'abandon',note:'Original helper stopped and operator assumes responsibility.',quiescenceConfirmed:true},reviewCall:(r,v)=>f.ledger.reconcileRepair('backend:owner',r,v)};
 await assert.rejects(reviewCheckpoint(args),/has not stopped/);
 release({startDisposition:'accepted'});await new Promise(r=>setImmediate(r));
 const reviewed=await reviewCheckpoint(args);assert.equal(reviewed.state.phase,'cancelled');assert.equal(reviewed.reconciliation.disposition,'abandon');
 await assert.rejects(f.resume(cancelled),/Terminal/);
});
