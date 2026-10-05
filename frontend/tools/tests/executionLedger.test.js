import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ExecutionLedger } from '../ExecutionLedger.js';
import { executionContext, execFile } from '../ExecutionContext.js';
import { createToolBridgeServer } from '../../electron/ipc/toolBridgeServer.js';
import { ToolEngineRouter } from '../ToolEngineRouter.js';
import { BaseToolService } from '../BaseToolService.js';
import { InputValidator } from '../InputValidator.js';

const request = { tool: 'hardware', action: 'systemInfo', params: {}, requestId: 'r1', idempotencyKey: 'k1', toolCallId: 'model-call' };
const deferred = () => { let resolve; const promise = new Promise(r => resolve=r); return { promise, resolve }; };
test('authenticated bridge executes; missing/wrong secret rejects every endpoint', async t => {
  let calls=0;
  const ledger = new ExecutionLedger({ dispatch: async () => { calls++; return { success: true, data: { ok: true } }; } });
  const bridge = await createToolBridgeServer(ledger);
  t.after(() => { bridge.server.closeAllConnections(); bridge.server.close(); });
  for (const endpoint of ['/', '/status', '/cancel', '/health']) for (const secret of ['', 'wrong']) {
    const response = await fetch(bridge.url+endpoint, { method: endpoint === '/health' ? 'GET' : 'POST', headers: { authorization: `Bearer ${secret}` } });
    assert.equal(response.status,401);
  }
  assert.equal(calls,0);
  const headers = { authorization: `Bearer ${bridge.secret}`, 'x-execution-owner': 'alice', 'content-type': 'application/json' };
  const response = await fetch(bridge.url, { method:'POST', headers, body:JSON.stringify(request) });
  assert.equal(response.status,200); assert.equal((await response.json()).success,true); assert.equal(calls,1);
  const status = await fetch(bridge.url+'/status', { method:'POST', headers, body:JSON.stringify({idempotencyKey:'k1'}) });
  assert.equal((await status.json()).status,'completed');
  const other = await fetch(bridge.url+'/status', { method:'POST', headers:{...headers,'x-execution-owner':'bob'}, body:JSON.stringify({idempotencyKey:'k1'}) });
  assert.equal((await other.json()).status,'unknown');
});
test('durable duplicate prevention survives restart and rejects different payloads', async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'phase2-ledger-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  let calls=0; const dispatch=async()=>{calls++; return {success:true,data:'saved'};};
  const first=new ExecutionLedger({directory:dir,dispatch});
  const result=await first.execute('owner',request);
  const second=new ExecutionLedger({directory:dir,dispatch});
  assert.deepEqual(await second.execute('owner',request),result); assert.equal(calls,1);
  assert.equal((await second.execute('owner',{...request,params:{changed:true}})).error.code,'IDEMPOTENCY_CONFLICT');
  assert.equal(calls,1);
});
test('in-flight duplicates and orphaned crash records never redispatch', async () => {
  const wait=deferred(); let calls=0;
  const ledger=new ExecutionLedger({dispatch:()=>{calls++;return wait.promise;}});
  const running=ledger.execute('owner',request);
  assert.equal((await ledger.execute('owner',request)).error.code,'EXECUTION_UNCERTAIN');
  const crashed=new ExecutionLedger({dispatch:()=>{throw new Error('must not dispatch');}});
  crashed.memory=structuredClone(ledger.memory);
  assert.equal(crashed.status('owner','k1').status,'uncertain');
  assert.equal((await crashed.execute('owner',request)).error.code,'EXECUTION_UNCERTAIN');
  wait.resolve({success:true}); await running; assert.equal(calls,1);
});
test('requestId cancellation reaches execution context and prevents pre-cancelled calls', async () => {
  let signal;
  const ledger=new ExecutionLedger({dispatch:()=>{signal=executionContext.getStore().signal;return new Promise(()=>{});}});
  const running=ledger.execute('owner',request);
  ledger.cancel('owner','r1');
  assert.equal(signal.aborted,true); assert.equal((await running).error.code,'EXECUTION_UNCERTAIN');
  assert.equal(ledger.status('owner','k1').status,'uncertain');
  ledger.cancel('owner','r2');
  assert.equal((await ledger.execute('owner',{...request,requestId:'r2',idempotencyKey:'k2'})).error.code,'CANCELLED');
});
test('bounded timeout leaves an uncertain record, never false success', async () => {
  const ledger=new ExecutionLedger({timeoutMs:10,dispatch:()=>new Promise(()=>{})});
  assert.equal((await ledger.execute('owner',request)).error.code,'EXECUTION_UNCERTAIN');
  assert.equal(ledger.status('owner','k1').status,'uncertain');
});
test('confirmation is scope-bound and duplicate continuation executes exactly once', async () => {
  const router=new ToolEngineRouter(); let effects=0;
  class Fake extends BaseToolService { get actions(){return {restart:{schema:{name:{type:'string',required:true}},destructive:true,handler:async()=>{effects++;return 'done';}}};} }
  router.services.set('services',new Fake('services',router.gate));
  const ledger=new ExecutionLedger({dispatch:r=>router.dispatch(r)});
  // Mock only the effect of a registered typed action. Unknown tools fail closed.
  const execute=(scope,call)=>ledger.execute(`backend:${scope}`,call,null,{origin:'operator',humanApproved:call.action==='confirm'});
  const initial=await execute('alice',{...request,tool:'services',action:'restart',params:{name:'Spooler'}});
  assert.equal(initial.needsConfirmation,true);
  const confirm={...request,tool:'_system',action:'confirm',params:{confirmationId:initial.confirmationId},requestId:'r2',idempotencyKey:'confirm1'};
  assert.equal((await execute('bob',confirm)).success,false); assert.equal(effects,0);
  const result=await execute('alice',confirm); assert.equal(result.success,true);
  assert.deepEqual(await execute('alice',confirm),result); assert.equal(effects,1);
});
test('schema validation rejects unknown, inherited, nonfinite and array parameters', () => {
  const schema={n:{type:'number',required:true,integer:true,min:1,max:20}};
  for(const params of [[],null,{n:Infinity},{n:1.5},{n:21},{n:2,extra:true},Object.create({n:2})]) assert.equal(InputValidator.validate(schema,params).valid,false);
  assert.equal(InputValidator.validate(schema,{n:2}).valid,true);
});
test('subprocess cancellation passes through the context to a real child', async () => {
  const abort=new AbortController();
  const result=executionContext.run({signal:abort.signal},()=>new Promise(resolve=>{
    execFile(process.execPath,['-e','setTimeout(()=>{},30000)'],{windowsHide:true},error=>resolve(error));
  }));
  abort.abort(); assert.equal((await result).name,'AbortError');
});
