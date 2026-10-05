import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { validateRepair, modelPolicy, eligibility, verified } from '../repair/contract.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolEngineRouter } from '../ToolEngineRouter.js';
import { ExecutionLedger } from '../ExecutionLedger.js';
import { ConfirmationGate } from '../ConfirmationGate.js';
import { validateRunnerBytes, createProtectedRunner } from '../repair/ProtectedRunner.js';
import { wireRepairLedger } from '../repair/wireRepairLedger.js';
import { createToolBridgeServer } from '../../electron/ipc/toolBridgeServer.js';
export function repairFixture({directory,runner:override,timeoutMs=2000}={}) {
 let starts=0,status=1,n=0;const sessionId=randomUUID();
 const evidence=()=>sample({status,observedAt:Date.now()});
 const runner=override|| (async op=>{if(op==='inspect')return evidence();if(op==='start'){starts++;status=4;return {startDisposition:'accepted'};}return {samples:[{...evidence(),observedAt:Date.now()-1000},evidence()]};});
 const router=new ToolEngineRouter({confirmationDirectory:directory&&path.join(directory,'confirmations'),repairOptions:{directory:directory&&path.join(directory,'repair'),runner}});
 const ledger=new ExecutionLedger({directory:directory&&path.join(directory,'ledger'),dispatch:r=>router.dispatch(r),timeoutMs});
 wireRepairLedger(ledger,router);
 function request(action,params={},extra={}) { const id=`${sessionId}:request:${++n}`;return {tool:'windowsRepair',action,params,requestId:id,idempotencyKey:id,toolCallId:randomUUID(),admission:{sessionId,revision:n,taskType:'windows_repair_print_spooler_start'},...extra}; }
 const call=(r,humanApproved=false)=>ledger.execute('backend:owner',r,null,{backend:true,humanApproved});
 const inspect=()=>call(request('inspectSpooler'));
 const propose=diagnosisId=>call(request('startSpooler',{diagnosisId}));
 const approve=confirmationId=>call(request('confirm',{confirmationId},{tool:'_system'}),true);
 return {router,ledger,request,call,inspect,propose,approve,sessionId,starts:()=>starts};
}
const sample = (patch = {}) => ({ platform:'win32', name:'Spooler', hostId:'host', bootId:'boot', configHash:'a'.repeat(64), observedAt:1000, status:1, stock:true, canStart:true, dependenciesRunning:true, startType:2, ...patch });
test('repair contract accepts only the fixed capability and diagnosis UUID', () => {
  assert.equal(validateRepair('startSpooler', { diagnosisId: randomUUID() }), null);
  for (const p of [null, [], {}, {diagnosisId:'fake'}, {diagnosisId:randomUUID(),command:'Start-Service Spooler'}, JSON.parse('{"__proto__":{}}')]) assert.ok(validateRepair('startSpooler',p));
  assert.ok(validateRepair('restartSpooler',{})); assert.ok(validateRepair('inspectSpooler',{host:'remote'}));
});
test('negative model policy blocks every generic repair escape and model confirmation', () => {
  for (const [tool,action,params] of [['powershell','execute',{}],['powershell','executeScript',{}],['cmd','execute',{}],['cmd','executeBatch',{}],['services','start',{name:'Spooler'}],['services','stop',{name:'Spooler'}],['process','startProcess',{command:'powershell.exe'}],['process','startProcess',{command:'notepad.exe',args:['evil']}],['_system','confirm',{}],['file','write',{}]]) assert.ok(modelPolicy(tool,action,params));
  assert.equal(modelPolicy('hardware','systemInfo'),null); assert.ok(modelPolicy('process','startProcess',{command:'notepad.exe'})); assert.equal(modelPolicy('app','openApp',{query:'Notepad'}),null);
});
test('diagnosis rejects unknown, changed, inaccessible and nonstopped configurations', () => {
  assert.equal(eligibility(sample()),null);
  for(const patch of [{status:2},{startType:3},{stock:false},{canStart:false},{dependenciesRunning:false},{platform:'linux'},{configHash:'bad'}]) assert.ok(eligibility(sample(patch)));
  assert.equal(eligibility(sample({status:4})),'ALREADY_RUNNING');
});
test('verification requires two matching fresh numeric Running samples', () => {
  const a=sample({status:4}), b=sample({status:4,observedAt:2000});
  assert.equal(verified([a,b],sample()),true);
  for(const values of [[a],[a,{...b,status:1}],[a,{...b,bootId:'other'}],[a,{...b,observedAt:1500}],[a,{...b,status:'Running'}]]) assert.equal(verified(values,sample()),false);
});
test('diagnosis, durable approval, one start and separate verification',async()=>{
 const f=repairFixture(),d=await f.inspect();assert.equal(d.data.eligible,true);assert.equal(f.starts(),0);
 const proposal=await f.propose(d.data.diagnosisId);assert.equal(proposal.needsConfirmation,true);assert.equal(f.starts(),0);
 const model=await f.call(f.request('confirm',{confirmationId:proposal.confirmationId},{tool:'_system'}));assert.equal(model.success,false);assert.equal(f.starts(),0);
 assert.equal((await f.approve(proposal.confirmationId)).success,true);assert.equal(f.starts(),1);
 assert.equal((await f.approve(proposal.confirmationId)).success,false);
 assert.equal((await f.propose(d.data.diagnosisId)).success,false);
 const verification=await f.call(f.request('verifySpooler',{diagnosisId:d.data.diagnosisId}));assert.equal(verification.data.verificationStatus,'passed');assert.equal(verification.data.userIssueResolved,null);
 assert.equal(f.starts(),1);assert.ok(f.router.services.get('windowsRepair').store.state.events.some(e=>e.eventType==='verification.result'));
});
test('forged broker calls, foreign diagnosis and unknown parameters cannot dispatch',async()=>{
 const f=repairFixture();
 for(const r of [f.request('startSpooler',{diagnosisId:randomUUID()}),f.request('inspectSpooler',{}, {admission:null}),f.request('startSpooler',{diagnosisId:randomUUID(),command:'bad'})])assert.equal((await f.call(r)).success,false);
 assert.equal(f.starts(),0);
 for(const tool of ['powershell','cmd','services'])assert.equal((await f.call(f.request('execute',{command:'Start-Service Spooler'},{tool}))).success,false);
});
test('duplicate concurrent continuation and distinct transport keys dispatch only once',async()=>{
 const f=repairFixture(),d=await f.inspect(),p=await f.propose(d.data.diagnosisId);
 const results=await Promise.all([f.approve(p.confirmationId),f.approve(p.confirmationId)]);
 assert.equal(results.filter(x=>x.success).length,1);assert.equal(f.starts(),1);
});
test('confirmation expiry renewal and spent operation survive restart',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'spooler-durable-'));
 const f=repairFixture({directory:dir}),d=await f.inspect(),p=await f.propose(d.data.diagnosisId);
 const renewed=f.router.gate.renew(p.confirmationId,'renew-1','backend:owner');
 const gate=new ConfirmationGate({directory:path.join(dir,'confirmations')});
 assert.equal(gate.renew(p.confirmationId,'renew-1','backend:owner').confirmationId,renewed.confirmationId);
 assert.equal((await f.approve(p.confirmationId)).success,false);assert.equal((await f.approve(renewed.confirmationId)).success,true);
 const restarted=repairFixture({directory:dir});assert.ok(restarted.router.services.get('windowsRepair').store.state.operations[`${f.sessionId}:windows.printSpooler.start.v1`]);
 assert.equal(new ConfirmationGate({directory:path.join(dir,'confirmations')}).confirm(renewed.confirmationId).success,false);
});
test('renewal cannot extend diagnosis expiry or exceed three renewals',()=>{
 let now=0;const gate=new ConfirmationGate({now:()=>now});let id=gate.request({scope:'owner',validUntil:120000,maxRenewals:3}).confirmationId;
 for(let i=0;i<3;i++)id=gate.renew(id,`renew-${i}`,'owner').confirmationId;
 assert.throws(()=>gate.renew(id,'renew-4','owner'),/budget/);
 now=120000;assert.equal(gate.confirm(id).success,false);assert.throws(()=>gate.renew(id,'renew-5','owner'),/REDIAGNOSIS/);
});
test('changed preconditions consume approval without dispatching a start',async()=>{
 let reads=0,starts=0;const f=repairFixture({runner:async op=>{if(op==='start'){starts++;return {startDisposition:'accepted'};}return sample({observedAt:Date.now(),configHash:(++reads===1?'a':'b').repeat(64)});}});
 const d=await f.inspect(),p=await f.propose(d.data.diagnosisId);assert.equal((await f.approve(p.confirmationId)).error.code,'PRECONDITION_CHANGED');assert.equal(starts,0);
 assert.equal((await f.approve(p.confirmationId)).success,false);
});
test('timeout leaves a spent reservation, no replay or automatic compensation',async()=>{
 let starts=0;const f=repairFixture({runner:async op=>{if(op==='inspect')return sample({observedAt:Date.now()});if(op==='start'){starts++;throw new Error('lost helper');}}});
 const d=await f.inspect(),p=await f.propose(d.data.diagnosisId),r=await f.approve(p.confirmationId);
 assert.equal(r.error.code,'EXECUTION_UNCERTAIN');assert.equal((await f.propose(d.data.diagnosisId)).success,false);assert.equal(starts,1);
 assert.equal(Object.values(f.router.services.get('windowsRepair').store.state.operations)[0].status,'reserved');
});
test('cancel-before-dispatch survives ledger restart',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'spooler-cancel-'));const f=repairFixture({directory:dir}),r=f.request('inspectSpooler');f.ledger.cancel('backend:owner',r.requestId);
 const restarted=repairFixture({directory:dir});assert.equal((await restarted.call(r)).error.code,'CANCELLED');
});
test('journal failure before reservation fails closed',async()=>{
 const f=repairFixture(),d=await f.inspect(),p=await f.propose(d.data.diagnosisId);
 f.router.services.get('windowsRepair').store.commit=()=>{throw new Error('disk full');};
 assert.equal((await f.approve(p.confirmationId)).success,false);assert.equal(f.starts(),0);
});
test('protected runner rejects development, missing and modified artifacts',async()=>{
 validateRunnerBytes();await assert.rejects(createProtectedRunner()('start'),/PROTECTED_INSTALL_REQUIRED/);
 const file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'runner-integrity-')),'runner.ps1');fs.writeFileSync(file,'tampered');assert.throws(()=>validateRunnerBytes(file),/INTEGRITY/);
});

test('spent approval cannot be replaced after changed preconditions',async()=>{
 let reads=0;const f=repairFixture({runner:async()=>sample({observedAt:Date.now(),canStart:++reads===1})});
 const d=await f.inspect(),p=await f.propose(d.data.diagnosisId);
 assert.equal((await f.approve(p.confirmationId)).success,false);
 assert.equal((await f.propose(d.data.diagnosisId)).error.code,'APPROVAL_ALREADY_SPENT');
});

test('production renewal checks fresh evidence and does not approve',async()=>{
 let stock=true;const f=repairFixture({runner:async()=>sample({observedAt:Date.now(),stock})});
 const d=await f.inspect(),p=await f.propose(d.data.diagnosisId);
 const renewed=await f.ledger.renewConfirmation(p.confirmationId,'renew-one','backend:owner');
 assert.ok(renewed.confirmationId);assert.equal(f.starts(),0);stock=false;
 await assert.rejects(f.ledger.renewConfirmation(renewed.confirmationId,'renew-two','backend:owner'),/REQUIRES_REDIAGNOSIS/);
});

test('cancel during start preserves uncertainty until helper settles and prevents replay',async()=>{
 let release,entered;const ready=new Promise(r=>entered=r);let starts=0;
 const f=repairFixture({runner:async op=>{if(op==='inspect')return sample({observedAt:Date.now()});starts++;entered();return new Promise(r=>release=r);}});
 const d=await f.inspect(),p=await f.propose(d.data.diagnosisId);
 const req=f.request('confirm',{confirmationId:p.confirmationId},{tool:'_system'}),pending=f.call(req,true);
 await ready;f.ledger.cancel('backend:owner',req.requestId);
 assert.equal((await pending).error.code,'EXECUTION_UNCERTAIN');assert.equal(f.ledger.status('backend:owner',req.idempotencyKey).executionActive,true);
 assert.equal((await f.call(req,true)).error.code,'EXECUTION_UNCERTAIN');
 release({startDisposition:'accepted'});await new Promise(r=>setImmediate(r));
 assert.equal(f.ledger.status('backend:owner',req.idempotencyKey).executionActive,false);assert.equal(starts,1);
 assert.ok(f.router.services.get('windowsRepair').store.state.events.some(e=>e.eventType==='cancellation.requested'));
});

test('manual reconciliation ignores forged completion and uses fresh broker observations',async()=>{
 let running=false,starts=0;const f=repairFixture({runner:async op=>{
  if(op==='inspect')return sample({observedAt:Date.now()});
  if(op==='start'){starts++;throw new Error('lost response');}
  return {samples:[sample({status:running?4:1,observedAt:Date.now()-1000}),sample({status:running?4:1,observedAt:Date.now()})]};
 }});
 const d=await f.inspect(),p=await f.propose(d.data.diagnosisId);
 const req=f.request('confirm',{confirmationId:p.confirmationId},{tool:'_system'});await f.call(req,true);
 req.repair={action:'startSpooler',params:{diagnosisId:d.data.diagnosisId},admission:req.admission};
 const review={reviewId:'review-one',disposition:'completed',quiescenceConfirmed:true,note:'The owned helper is stopped.',data:{verificationStatus:'passed',forged:true}};
 await assert.rejects(f.ledger.reconcileRepair('backend:owner',req,review),/POSTCONDITION_FAILED/);
 running=true;const record=await f.ledger.reconcileRepair('backend:owner',req,review);
 assert.equal(record.result.data.verificationStatus,'passed');assert.equal(record.result.data.forged,undefined);
 assert.deepEqual(await f.ledger.reconcileRepair('backend:owner',req,review),record);
 assert.equal((await f.propose(d.data.diagnosisId)).success,false);assert.equal(starts,1);
});

test('authenticated bridge requires dedicated human approval route and owner binding',async()=>{
 const f=repairFixture(),bridge=await createToolBridgeServer(f.ledger);
 const post=(route,body,{auth=true,owner='owner'}={})=>fetch(bridge.url+route,{method:'POST',headers:{'Content-Type':'application/json','x-execution-owner':owner,...(auth?{authorization:`Bearer ${bridge.secret}`}:{})},body:JSON.stringify(body)});
 try {
  assert.equal((await post('/',f.request('inspectSpooler'),{auth:false})).status,401);
  const d=await (await post('/',f.request('inspectSpooler'))).json();assert.equal(d.success,true);
  const p=await (await post('/',f.request('startSpooler',{diagnosisId:d.data.diagnosisId}))).json();
  const confirm=()=>f.request('confirm',{confirmationId:p.confirmationId},{tool:'_system'});
  assert.equal((await (await post('/',confirm())).json()).success,false);
  assert.equal((await (await post('/approve',confirm(),{owner:'other'})).json()).success,false);
  assert.equal((await (await post('/approve',confirm())).json()).success,true);assert.equal(f.starts(),1);
 } finally {bridge.server.closeAllConnections();await new Promise(r=>bridge.server.close(r));}
});

test('durable journal validates corruption and records ordered structured identities',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'repair-audit-')),f=repairFixture({directory:dir});
 const d=await f.inspect(),p=await f.propose(d.data.diagnosisId);await f.approve(p.confirmationId);
 const events=f.router.services.get('windowsRepair').store.state.events;
 assert.deepEqual(events.map(e=>e.sequence),events.map((_,i)=>i+1));
 for(const e of events){assert.equal(e.sessionId,f.sessionId);assert.equal(e.capabilityId,'windows.printSpooler.start.v1');assert.ok(e.eventId);assert.ok(e.requestId);assert.equal(e.policyVersion,1);}
 fs.writeFileSync(path.join(dir,'repair','spooler-v1.json'),'{corrupt');assert.throws(()=>repairFixture({directory:dir}));
});
