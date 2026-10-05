import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolveToolActor } from '../../electron/services/ToolActor.js';
test('tool identity is derived from the verified session and tied to the sender',async()=>{
  const id=randomUUID();
  const deps={readToken:()=> 'opaque-test-token',request:async(url,options)=>{assert.equal(url,'http://127.0.0.1:3001/api/auth/me');assert.equal(options.redirect,'error');return {ok:true,json:async()=>({user:{id}})};}};
  assert.equal(await resolveToolActor(7,deps),`renderer:${id}-7`);
});
test('missing, revoked, changed and malformed tool sessions deny',async()=>{
  await assert.rejects(resolveToolActor(7,{readToken:()=>null}),{code:'AUTH_CONTEXT_REQUIRED'});
  await assert.rejects(resolveToolActor(7,{readToken:()=> 'token',request:async()=>({ok:false})}),{code:'AUTH_CONTEXT_REQUIRED'});
  await assert.rejects(resolveToolActor(7,{readToken:()=> 'token',request:async()=>({ok:true,json:async()=>({user:{id:'spoofed'}})})}),{code:'AUTH_CONTEXT_REQUIRED'});
  let token='before';await assert.rejects(resolveToolActor(7,{readToken:()=>token,request:async()=>{token='after';return {ok:true};}}),{code:'AUTH_CONTEXT_REQUIRED'});
});
