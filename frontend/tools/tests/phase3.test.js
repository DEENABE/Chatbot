import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfirmationGate } from '../ConfirmationGate.js';
import { ExecutionLedger } from '../ExecutionLedger.js';
import { parseTasklistWindow, checkApplicationReadiness } from '../ApplicationReadiness.js';
import { createToolBridgeServer } from '../../electron/ipc/toolBridgeServer.js';

const request={tool:'process',action:'startProcess',params:{command:'notepad'},requestId:'request-1',idempotencyKey:'key-1',toolCallId:'model/id'};
const review={reviewId:'review-1',disposition:'not_completed',quiescenceConfirmed:true,note:'Checked the original execution and confirmed it has stopped.'};
function directory(t) {const dir=fs.mkdtempSync(path.join(os.tmpdir(),'phase3-tools-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
test('expired confirmation renews after restart; old token rejects and new approval is consumed durably',t=>{
  const dir=directory(t);let clock=1000;
  const first=new ConfirmationGate({directory:dir,now:()=>clock});
  const {confirmationId}=first.request({tool:'process',action:'startProcess',params:{command:'notepad'},scope:'alice',message:'Open Notepad?'});
  clock+=61000;assert.equal(first.confirm(confirmationId).success,false);
  const restarted=new ConfirmationGate({directory:dir,now:()=>clock});
  const fresh=restarted.renew(confirmationId,'renew-1','alice');
  assert.equal(fresh.message,'Open Notepad?');assert.equal(fresh.generation,1);assert.notEqual(fresh.confirmationId,confirmationId);
  assert.equal(restarted.confirm(confirmationId).success,false);
  assert.deepEqual(restarted.renew(confirmationId,'renew-1','alice'),fresh);
  assert.equal(restarted.confirm(fresh.confirmationId).success,true);
  assert.equal(new ConfirmationGate({directory:dir,now:()=>clock}).confirm(fresh.confirmationId).success,false);
  assert.throws(()=>restarted.renew(fresh.confirmationId,'renew-2','alice'),{status:409});
  first.settle(confirmationId,false);
});
test('renewal rejects foreign, cancelled, superseded and invented tokens',()=>{
  const gate=new ConfirmationGate();const {confirmationId}=gate.request({scope:'alice'});
  assert.throws(()=>gate.renew(confirmationId,'r','bob'),{status:404});
  assert.throws(()=>gate.renew('__proto__','r','alice'),{status:404});
  const fresh=gate.renew(confirmationId,'r','alice');
  assert.throws(()=>gate.renew(confirmationId,'different','alice'),{status:409});
  gate.cancel(fresh.confirmationId);assert.throws(()=>gate.renew(fresh.confirmationId,'next','alice'),{status:409});
});
test('confirmation persistence failure cannot approve or change the token',()=>{
  const gate=new ConfirmationGate();const {confirmationId}=gate.request({scope:'alice'});
  const save=gate.store.save;gate.store.save=()=>{throw new Error('disk full');};
  assert.throws(()=>gate.confirm(confirmationId),/disk full/);assert.equal(gate.getRecord(confirmationId).status,'pending');
  assert.throws(()=>gate.renew(confirmationId,'r','alice'),/disk full/);assert.equal(gate.getRecord(confirmationId).status,'pending');
  gate.store.save=save;gate.cancel(confirmationId);
});
test('malformed durable confirmation data fails closed on restart',t=>{
  const dir=directory(t);const gate=new ConfirmationGate({directory:dir});
  const {confirmationId}=gate.request({scope:'alice'});gate.settle(confirmationId,false);
  const file=path.join(dir,'confirmations.json');const data=JSON.parse(fs.readFileSync(file,'utf8'));
  delete data.records[confirmationId].expiresAt;fs.writeFileSync(file,JSON.stringify(data));
  assert.throws(()=>new ConfirmationGate({directory:dir}),/Invalid durable confirmation/);
});
test('manual review is durable, idempotent, preserves identity and never dispatches',async t=>{
  const dir=directory(t);let calls=0;
  const ledger=new ExecutionLedger({directory:dir,dispatch:async()=>{calls++;return {success:true};}});
  const evidence=ledger.reconcile('alice',request,review);
  assert.equal(evidence.previousStatus,'unknown');assert.equal(evidence.reconciliation.provenance,'human_attestation');assert.equal(evidence.result.success,false);
  const restart=new ExecutionLedger({directory:dir,dispatch:async()=>{calls++;}});
  assert.deepEqual(restart.reconcile('alice',request,review),evidence);
  assert.deepEqual(await restart.execute('alice',request),evidence.result);assert.equal(calls,0);
  assert.throws(()=>restart.reconcile('alice',request,{...review,note:'Changed evidence from another review.'}),{status:409});
  assert.throws(()=>restart.reconcile('alice',{...request,toolCallId:'different'},review),{status:409});
});
test('manual review requires explicit quiescence and evidence, and rejects completed automatic records',async()=>{
  const ledger=new ExecutionLedger({dispatch:async()=>({success:true})});
  assert.throws(()=>ledger.reconcile('alice',request,{...review,quiescenceConfirmed:false}),{status:400});
  assert.throws(()=>ledger.reconcile('alice',request,{...review,note:''}),{status:400});
  await ledger.execute('alice',request);
  assert.throws(()=>ledger.reconcile('alice',request,review),{status:409});
});
test('timeout does not permit review while the underlying handler remains alive',async()=>{
  let finish;const ledger=new ExecutionLedger({timeoutMs:5,dispatch:()=>new Promise(resolve=>finish=resolve)});
  await ledger.execute('alice',request);
  assert.equal(ledger.status('alice','key-1').status,'uncertain');
  assert.throws(()=>ledger.reconcile('alice',request,review),/not stopped/);
  finish({success:true});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(ledger.reconcile('alice',request,review).result.error.code,'MANUALLY_NOT_COMPLETED');
});
test('tasklist parser requires exact PID, a window and Running status',()=>{
  const row=(pid,status,title)=>`"notepad.exe","${pid}","Console","1","10 K","${status}","user","0:00:00","${title}"`;
  assert.equal(parseTasklistWindow(row(12,'Running','Untitled'),12).ready,true);
  for(const [csv,pid] of [[row(13,'Running','Untitled'),12],[row(12,'Not Responding','Untitled'),12],[row(12,'Running','N/A'),12],['bad output',12]]) assert.equal(parseTasklistWindow(csv,pid).ready,false);
});
test('readiness succeeds only after a responding window is observed',async()=>{
  let clock=0,calls=0;
  const result=await checkApplicationReadiness({child:{pid:12,exitCode:null},command:'C:\\Windows\\notepad.exe',platform:'win32',now:()=>clock,wait:async ms=>{clock+=ms;},probe:async()=>({ready:++calls===2,title:'Untitled'})});
  assert.equal(result.status,'ready');assert.equal(result.pid,12);assert.equal(calls,2);
});
test('readiness is bounded and does not equate process survival or handoff with readiness',async()=>{
  let clock=0;const args={child:{pid:12,exitCode:null},command:'notepad',platform:'win32',now:()=>clock,wait:async ms=>{clock+=ms;},probe:async()=>({ready:false}),timeoutMs:200};
  assert.equal((await checkApplicationReadiness(args)).status,'not_ready');assert.equal(clock,200);
  clock=0;assert.equal((await checkApplicationReadiness({...args,child:{pid:12,exitCode:0}})).status,'not_ready');
  assert.equal((await checkApplicationReadiness({...args,command:'unknown-program'})).status,'unsupported');
});
test('readiness cancellation aborts rather than claiming readiness',async()=>{
  const abort=new AbortController();abort.abort();
  await assert.rejects(checkApplicationReadiness({child:{pid:12},command:'notepad',signal:abort.signal}),{name:'AbortError'});
});
test('a failing readiness probe stays bounded and cancellation during a probe wins over ready',async()=>{
  let clock=0;const args={child:{pid:12,exitCode:null},command:'notepad',platform:'win32',now:()=>clock,wait:async ms=>{clock+=ms;},timeoutMs:200};
  const result=await checkApplicationReadiness({...args,probe:async()=>{throw new Error('tasklist unavailable');}});
  assert.equal(result.status,'not_ready');assert.equal(result.processStatus,'probe_failed');assert.equal(clock,200);
  clock=0;const abort=new AbortController();
  await assert.rejects(checkApplicationReadiness({...args,signal:abort.signal,probe:async()=>{abort.abort();return {ready:true,title:'late window'};}}),{name:'AbortError'});
});
test('new bridge operations reject missing authentication and cross-owner renewal',async t=>{
  const gate=new ConfirmationGate();const {confirmationId}=gate.request({scope:'backend:alice'});
  const ledger=new ExecutionLedger({dispatch:async()=>({success:true}),renewConfirmation:(...args)=>gate.renew(...args)});
  const bridge=await createToolBridgeServer(ledger);t.after(()=>{bridge.server.closeAllConnections();bridge.server.close();gate.settle(confirmationId,false);});
  for(const endpoint of ['/reconcile','/confirmations/renew']) assert.equal((await fetch(bridge.url+endpoint,{method:'POST'})).status,401);
  const response=await fetch(bridge.url+'/confirmations/renew',{method:'POST',headers:{Authorization:`Bearer ${bridge.secret}`,'x-execution-owner':'bob','content-type':'application/json'},body:JSON.stringify({confirmationId,renewalId:'renew'})});assert.equal(response.status,404);
});
