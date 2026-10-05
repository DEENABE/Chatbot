import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'phase2-auth-resume-'));
process.env.APP_DATA_PATH=dir;
const {app}=await import('../app.js');
const {db}=await import('../services/db.js');
const {ExecutionController}=await import('../orchestrator/ExecutionController.js');
const {createCheckpointStore}=await import('../orchestrator/CheckpointStore.js');
const {ExecutionLedger}=await import('../../../frontend/tools/ExecutionLedger.js');
const {ToolEngineRouter}=await import('../../../frontend/tools/ToolEngineRouter.js');
const {createToolBridgeServer}=await import('../../../frontend/electron/ipc/toolBridgeServer.js');
const router=new ToolEngineRouter();
const ledger=new ExecutionLedger({dispatch:r=>router.dispatch(r),renewConfirmation:(...args)=>router.gate.renew(...args)});
const bridge=await createToolBridgeServer(ledger);
process.env.TOOL_ENGINE_INTERNAL_URL=bridge.url;process.env.TOOL_ENGINE_SESSION_SECRET=bridge.secret;
const server=http.createServer(app);
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}/api`;
test.after(()=>{server.closeAllConnections();server.close();bridge.server.closeAllConnections();bridge.server.close();db.close();fs.rmSync(dir,{recursive:true,force:true});});
async function user(name) {
  const response=await fetch(base+'/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:name,displayName:name,password:'correcthorsebatterystaple'})});
  assert.equal(response.status,201);return response.json();
}
test('checkpoint endpoints require authentication and isolate ownership; explicit resume verifies a real safe capability',async()=>{
  const alice=await user('phase2_alice'),bob=await user('phase2_bob');
  const c=new ExecutionController('Read current memory usage',{ownerId:alice.user.id,save:createCheckpointStore()});
  c.plan([{tool:'hardware',action:'memoryUsage',params:{},toolCallId:'memory-call'}]);
  const url=base+'/orchestrate/checkpoints/'+c.state.sessionId;
  for(const [suffix,method] of [['','GET'],['/resume','POST'],['/cancel','POST']]) {
    const response=await fetch(url+suffix,{method});assert.equal(response.status,401);
    const other=await fetch(url+suffix,{method,headers:{Authorization:`Bearer ${bob.token}`}});assert.equal(other.status,404);
  }
  const headers={Authorization:`Bearer ${alice.token}`,'Content-Type':'application/json'};
  const inspect=await fetch(url,{headers});assert.equal(inspect.status,200);assert.equal(inspect.headers.get('cache-control'),'no-store');
  const saved=await inspect.json();assert.equal(saved.state.ownerId,alice.user.id);
  const stale=await fetch(url+'/resume',{method:'POST',headers,body:JSON.stringify({expectedRevision:0})});assert.equal(stale.status,409);
  const resumed=await fetch(url+'/resume',{method:'POST',headers,body:JSON.stringify({expectedRevision:saved.revision})});
  assert.equal(resumed.status,200);assert.equal((await resumed.json()).success,true);
  const again=await fetch(url+'/resume',{method:'POST',headers,body:JSON.stringify({expectedRevision:saved.revision})});assert.equal(again.status,409);
});
test('Phase 3 HTTP review and renewal require ownership, explicit review, and a fresh approval',async()=>{
  const {askLimiter}=await import('../middleware/rateLimiter.js');
  askLimiter.resetKey('127.0.0.1'); // Isolate this scenario from the prior test's request count.
  const alice=await user('phase3_alice'),bob=await user('phase3_bob');
  const save=createCheckpointStore();
  const c=new ExecutionController('memory',{ownerId:alice.user.id,save});
  c.plan([{tool:'hardware',action:'memoryUsage',params:{}}]);c.move('act');
  const url=base+'/orchestrate/checkpoints/'+c.state.sessionId;
  const headers={Authorization:`Bearer ${alice.token}`,'Content-Type':'application/json'};
  assert.equal((await fetch(url+'/recovery')).status,401);
  assert.equal((await fetch(url+'/recovery',{headers:{Authorization:`Bearer ${bob.token}`}})).status,404);
  const inspection=await fetch(url+'/recovery',{headers});assert.equal(inspection.status,200);
  const inspectionBody=await inspection.json();assert.equal(inspectionBody.canReview,true);assert.equal(inspectionBody.evidence.status,'unknown');
  for(const suffix of ['/reconcile','/confirmation/renew']) {
    assert.equal((await fetch(url+suffix,{method:'POST'})).status,401);
    assert.equal((await fetch(url+suffix,{method:'POST',headers:{Authorization:`Bearer ${bob.token}`}})).status,404);
  }
  const step=c.state.plan[0];
  const body={expectedRevision:c.state.revision,requestId:step.requestId,idempotencyKey:step.idempotencyKey,toolCallId:step.toolCallId,
    review:{reviewId:'http-review',disposition:'completed',quiescenceConfirmed:true,note:'Verified diagnostic completed and the original execution stopped.',data:{total:100,free:40,used:60,usagePercent:60}}};
  assert.equal((await fetch(url+'/reconcile',{method:'POST',headers,body:JSON.stringify({...body,expectedRevision:0})})).status,409);
  const reviewed=await fetch(url+'/reconcile',{method:'POST',headers,body:JSON.stringify(body)});assert.equal(reviewed.status,200);
  const saved=await reviewed.json();assert.equal(saved.state.phase,'decide');assert.equal(saved.state.observations[0].reconciliation.provenance,'human_attestation');
  const result=await fetch(url+'/resume',{method:'POST',headers,body:JSON.stringify({expectedRevision:saved.revision})});assert.equal((await result.json()).success,true);

  const waiting=new ExecutionController('confirmation fixture',{ownerId:alice.user.id,save});waiting.plan([{tool:'hardware',action:'memoryUsage',params:{}}]);
  const {confirmationId}=router.gate.request({scope:`backend:${alice.user.id}`,message:'Review unchanged action.'});
  await waiting.execute(async()=>({needsConfirmation:true,confirmationId}));
  const renewUrl=base+'/orchestrate/checkpoints/'+waiting.state.sessionId;
  const response=await fetch(renewUrl+'/confirmation/renew',{method:'POST',headers,body:JSON.stringify({expectedRevision:waiting.state.revision,renewalId:'http-renewal'})});
  assert.equal(response.status,200);const renewed=await response.json();
  assert.equal(renewed.state.phase,'waiting_confirmation');assert.equal(renewed.state.stepCount,1);
  const newId=renewed.state.plan[0].observation.confirmationId;assert.notEqual(newId,confirmationId);
  assert.equal(router.gate.confirm(confirmationId).success,false);
  assert.equal((await fetch(renewUrl+'/resume',{method:'POST',headers,body:JSON.stringify({expectedRevision:renewed.revision,confirmationId})})).status,409);
  router.gate.cancel(newId);
});
