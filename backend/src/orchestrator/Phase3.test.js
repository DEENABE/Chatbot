import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ExecutionController } from './ExecutionController.js';
import { createCheckpointStore } from './CheckpointStore.js';
import { currentStep, checkpoint, restoreCheckpoint } from './AgentState.js';
import { reviewCheckpoint, renewCheckpointConfirmation } from './ManualRecovery.js';
import { resumeOrchestrator } from './AgentOrchestrator.js';
import { verificationPredicates, verifyCapabilities } from './CapabilityContracts.js';
import { ExecutionLedger } from '../../../frontend/tools/ExecutionLedger.js';
import { ConfirmationGate } from '../../../frontend/tools/ConfirmationGate.js';
import { toolRequestForStep } from './AgentExecutor.js';

const data={total:100,free:40,used:60,usagePercent:60};
const review={reviewId:'review-1',disposition:'completed',quiescenceConfirmed:true,note:'Observed the completed memory diagnostic and confirmed execution stopped.',data};
function setup(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'phase3-state-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const store=createCheckpointStore(dir), c=new ExecutionController('memory',{ownerId:'alice',save:store,maxRetries:1});
  c.plan([{tool:'hardware',action:'memoryUsage',params:{},toolCallId:'original-id'}]);
  const ledger=new ExecutionLedger({dispatch:()=>{throw new Error('Review must never execute a tool');}});
  return {store,c,ledger,dir};
}
function args(c,store) {const s=currentStep(c.state);return {store,sessionId:c.state.sessionId,userId:'alice',expectedRevision:c.state.revision,requestId:s.requestId,idempotencyKey:s.idempotencyKey,toolCallId:s.toolCallId};}
test('manual completed review records human provenance without executing, then explicit resume verifies',async t=>{
  const {c,store,ledger}=setup(t);c.move('act');
  const saved=await reviewCheckpoint({...args(c,store),review,reviewCall:async(r,v)=>ledger.reconcile('backend:alice',r,v)});
  assert.equal(saved.state.phase,'decide');assert.equal(saved.state.stepCount,1);assert.equal(saved.state.retryCount,0);
  assert.equal(saved.state.observations[0].reconciliation.reviewedBy,'backend:alice');
  const result=await resumeOrchestrator({sessionId:c.state.sessionId,userId:'alice',expectedRevision:saved.revision,dependencies:{save:store,verifyOutcome:async({steps})=>verifyCapabilities(steps),executeStep:async()=>{throw new Error('replayed');}}});
  assert.equal(result.success,true);assert.equal(store.load(c.state.sessionId,'alice').state.verdict.scope,'human_attestation');
});
test('manual not-completed review needs explicit resume and charges the original retry budget',async t=>{
  const {c,store,ledger}=setup(t);c.move('act');
  const saved=await reviewCheckpoint({...args(c,store),review:{...review,disposition:'not_completed'},reviewCall:async(r,v)=>ledger.reconcile('backend:alice',r,v)});
  assert.equal(saved.state.phase,'decide');let calls=0;
  const result=await resumeOrchestrator({sessionId:c.state.sessionId,userId:'alice',expectedRevision:saved.revision,dependencies:{save:store,
    replan:async()=>({steps:[{tool:'hardware',action:'memoryUsage',params:{}}]}),executeStep:async()=>{calls++;return {success:true,data};},verifyOutcome:async({steps})=>verifyCapabilities(steps)}});
  assert.equal(result.success,true);assert.equal(result.retryCount,1);assert.equal(result.stepCount,2);assert.equal(calls,1);
});
test('manual abandonment is terminal and cannot resume',async t=>{
  const {c,store,ledger}=setup(t);c.move('act');
  const saved=await reviewCheckpoint({...args(c,store),review:{...review,disposition:'abandon'},reviewCall:async(r,v)=>ledger.reconcile('backend:alice',r,v)});
  assert.equal(saved.state.phase,'cancelled');
  await assert.rejects(resumeOrchestrator({sessionId:c.state.sessionId,userId:'alice',expectedRevision:saved.revision,dependencies:{save:store}}),{status:409});
});
for (const interruptedPhase of ['decide','cancelled']) test(`abandonment survives interruption before ${interruptedPhase} is saved`,async t=>{
  const {c,store,ledger}=setup(t);c.move('act');
  const interrupted=value=>{if(value.state.phase===interruptedPhase) throw new Error('simulated crash');store(value);};interrupted.load=store.load;
  await assert.rejects(reviewCheckpoint({...args(c,interrupted),review:{...review,disposition:'abandon'},reviewCall:async(r,v)=>ledger.reconcile('backend:alice',r,v)}),/simulated crash/);
  const saved=store.load(c.state.sessionId,'alice');
  const result=await resumeOrchestrator({sessionId:c.state.sessionId,userId:'alice',expectedRevision:saved.revision,dependencies:{save:store,inspectToolCall:async key=>ledger.status('backend:alice',key)}});
  assert.equal(result.phase,'cancelled');assert.equal(result.success,false);
});
test('manual review rejects foreign owner, stale revision, wrong call and invalid completion data',async t=>{
  const {c,store}=setup(t);c.move('act');const base={...args(c,store),review,reviewCall:async()=>{throw new Error('must not reach bridge');}};
  for(const [patch,status] of [[{userId:'bob'},404],[{expectedRevision:0},409],[{requestId:'wrong'},409],[{review:{...review,data:{}}},400]]) await assert.rejects(reviewCheckpoint({...base,...patch}),{status});
  assert.equal(store.load(c.state.sessionId,'alice').revision,c.state.revision);
});
test('crash after ledger review but before checkpoint save is recovered without repeating review or tool',async t=>{
  const {c,store,ledger}=setup(t);c.move('act');
  ledger.reconcile('backend:alice',toolRequestForStep(currentStep(c.state)),review);
  const result=await resumeOrchestrator({sessionId:c.state.sessionId,userId:'alice',expectedRevision:c.state.revision,dependencies:{save:store,inspectToolCall:async key=>ledger.status('backend:alice',key),verifyOutcome:async({steps})=>verifyCapabilities(steps)}});
  assert.equal(result.success,true);assert.equal(result.stepCount,1);
});
test('renewal is an audited waiting-state update with no budget or attempt mutation',async t=>{
  const {c,store,dir}=setup(t);let clock=0;const gate=new ConfirmationGate({directory:path.join(dir,'confirmations'),now:()=>clock});
  const {confirmationId}=gate.request({scope:'backend:alice',message:'Review original action.'});
  await c.execute(async()=>({needsConfirmation:true,confirmationId}));clock=61000;
  const saved=await renewCheckpointConfirmation({...args(c,store),renewalId:'renew-1',renew:async(id,renewalId)=>gate.renew(id,renewalId,'backend:alice')});
  assert.equal(saved.state.phase,'waiting_confirmation');assert.equal(saved.state.stepCount,1);assert.equal(saved.state.retryCount,0);
  assert.equal(saved.state.events.at(-1).type,'confirmation_renewed');assert.deepEqual(saved.state.attempts,c.state.attempts);
  assert.equal(restoreCheckpoint(saved).phase,'waiting_confirmation');
  assert.equal(gate.confirm(confirmationId).success,false);
  const newId=currentStep(saved.state).observation.confirmationId;
  await assert.rejects(resumeOrchestrator({sessionId:c.state.sessionId,userId:'alice',expectedRevision:saved.revision,confirmationId,dependencies:{save:store}}),{status:409});
  assert.equal(gate.confirm(newId).success,true);gate.settle(confirmationId,false);
});
test('renewal rejects other phases and mismatched old tokens',async t=>{
  const {c,store}=setup(t);
  assert.throws(()=>c.renewConfirmation({previousId:'old',confirmationId:'new',expiresAt:1}),/Invalid/);
  await assert.rejects(renewCheckpointConfirmation({...args(c,store),renewalId:'r'}),{status:409});
  await c.execute(async()=>({needsConfirmation:true,confirmationId:'real'}));
  assert.throws(()=>c.renewConfirmation({previousId:'wrong',confirmationId:'new',expiresAt:1}),/Invalid/);
});
test('crash after durable renewal before checkpoint update returns same replacement on retry',async t=>{
  const {c,store,dir}=setup(t);const gate=new ConfirmationGate({directory:path.join(dir,'confirmations')});
  const {confirmationId}=gate.request({scope:'backend:alice'});await c.execute(async()=>({needsConfirmation:true,confirmationId}));
  const renewed=gate.renew(confirmationId,'stable-renewal','backend:alice');
  const restart=new ConfirmationGate({directory:path.join(dir,'confirmations')});
  const saved=await renewCheckpointConfirmation({...args(c,store),renewalId:'stable-renewal',renew:async(id,r)=>restart.renew(id,r,'backend:alice')});
  assert.equal(currentStep(saved.state).observation.confirmationId,renewed.confirmationId);
});
test('a PID alone or unsupported readiness cannot produce verified launch success',()=>{
  const predicate=verificationPredicates['process.startProcess'];
  assert.equal(predicate({pid:12,command:'notepad'},{command:'notepad'}),false);
  assert.equal(predicate({pid:12,command:'notepad',readiness:{status:'unsupported'}},{command:'notepad'}),false);
  assert.equal(predicate({pid:12,command:'notepad',readiness:{status:'ready',pid:13,criterion:'responding_window',windowTitle:'title',observedAt:new Date().toISOString()}},{command:'notepad'}),false);
});
