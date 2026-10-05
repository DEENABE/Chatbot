import test from 'node:test';
import assert from 'node:assert/strict';
import {createOrchestratorPlan,validateAndNormaliseLLMSteps} from './OrchestratorPlanner.js';
import {ExecutionController} from './ExecutionController.js';
import {verifyOutcome} from './Verifier.js';
import {routeTask} from './TaskRouter.js';
import {runOrchestrator} from './AgentOrchestrator.js';
import {createChatExecution,executeChatCall,finishChat} from '../../../frontend/src/services/chatExecution.js';
for(const task of ['Open VS Code and open D:\\Projects\\Test','Open VLC and play D:\\Movies\\test.mp4','Play D:\\Movies\\test.mp4 using VLC'])test(task,async()=>{
  assert.equal((await routeTask(task)).taskType,'compound_application');
  const plan=await createOrchestratorPlan({task});assert.equal(plan.steps.length,2);
  assert.equal(plan.steps[0].action,'resolveTarget');assert.equal(plan.steps[1].params.targetFromStep,'resolve-target');
  const c=new ExecutionController(task);c.move('plan');c.plan(plan.steps);
  const target={type:'FILE',path:'D:\\Movies\\test.mp4'};
  await c.execute(async()=>({success:true,data:{success:true,status:'TARGET_RESOLVED',target}}));c.advance();
  await c.execute(async step=>{assert.deepEqual(step.params.target,target);assert.equal(step.params.targetFromStep,undefined);return {success:false,error:{code:'VERIFICATION_FAILED',message:'No target evidence'}};});
  assert.throws(()=>c.finish({success:true}),/Incomplete/);
});
test('launch-only success cannot verify compound goal',async()=>{
  const result=await verifyOutcome({task:'Open VLC and play this movie',steps:[{tool:'app',action:'openApp',status:'done'}]});assert.equal(result.success,false);
});
test('invalid mandatory steps invalidate the whole plan',()=>{
  assert.deepEqual(validateAndNormaliseLLMSteps([{tool:'app',action:'openApp',params:{query:'VLC'}},{tool:'shell',action:'execute',params:{}}]),[]);
  assert.deepEqual(validateAndNormaliseLLMSteps([{tool:'app',action:'openWithTarget',params:{app:'VLC',targetFromStep:'future'}}]),[]);
});
test('forward dependency cannot dispatch',async()=>{
  const c=new ExecutionController('test');c.move('plan');c.plan([{tool:'app',action:'openWithTarget',params:{app:'VLC',targetFromStep:'missing'}}]);
  let executed=false;await assert.rejects(()=>c.execute(async()=>{executed=true;}),/dependency/);assert.equal(executed,false);
});
const target={type:'FOLDER',path:'D:\\Projects\\Test'};
const opened=(app='VS Code')=>({success:true,status:'APP_TARGET_OPENED',requestedApp:app,app:{id:'code'},target,processId:42,message:'The project folder is open in VS Code.',verification:{status:'verified',criterion:'window_title',windowTitle:'Test - Visual Studio Code',observedAt:new Date().toISOString()}});
test('three-step orchestration executes in order and only finishes after goal verification',async()=>{
  const calls=[];
  const result=await runOrchestrator({task:'Open VS Code and open D:\\Projects\\Test',dependencies:{save:()=>{},createLogger:()=>({log:()=>{}}),
    routeTask:async()=>({mode:'agentic'}),createOrchestratorPlan:async()=>({steps:[
      {id:'resolve',tool:'app',action:'resolveTarget',params:{query:'D:\\Projects\\Test'}},
      {id:'inspect',tool:'hardware',action:'cpuUsage',params:{}},
      {id:'open',tool:'app',action:'openWithTarget',params:{app:'VS Code',targetFromStep:'resolve'}}]}),
    executeStep:async step=>{calls.push(step.toolCallId);return {success:true,data:step.action==='resolveTarget'?{success:true,status:'TARGET_RESOLVED',query:'D:\\Projects\\Test',target}:step.action==='cpuUsage'?{usagePercent:1,perCore:[{core:0,usagePercent:1}]}:opened()};}
  }});
  assert.deepEqual(calls,['resolve','inspect','open']);assert.equal(result.phase,'done');assert.match(result.summary,/project folder/);
});
test('all tool steps succeeding cannot override failed original-goal verification',async()=>{
  const c=new ExecutionController('Open VS Code and open D:\\Projects\\Test');c.move('plan');c.plan([
    {id:'resolve',tool:'app',action:'resolveTarget',params:{query:'wrong project'}},
    {id:'open',tool:'app',action:'openWithTarget',params:{app:'VS Code',targetFromStep:'resolve'}}]);
  await c.execute(async()=>({success:true,data:{success:true,status:'TARGET_RESOLVED',query:'wrong project',target}}));c.advance();
  await c.execute(async()=>({success:true,data:opened()}));
  const verdict=await verifyOutcome({task:c.state.task,steps:c.state.plan});assert.equal(verdict.success,false);c.finish(verdict);assert.equal(c.state.phase,'error');
});
test('chat dependencies use owned outputs and cannot complete on just app launch',async()=>{
  const c=createChatExecution('Open VS Code and open D:\\Projects\\Test',{save:()=>{}});
  const tools=['app_resolveTarget','app_openWithTarget'].map(name=>({function:{name}}));
  await executeChatCall(c,{id:'resolve',function:{name:'app_resolveTarget',arguments:{query:'D:\\Projects\\Test'}}},tools,async()=>({success:true,data:{success:true,status:'TARGET_RESOLVED',query:'D:\\Projects\\Test',target}}));
  await executeChatCall(c,{id:'open',function:{name:'app_openWithTarget',arguments:{app:'VS Code',targetFromStep:'resolve'}}},tools,async(tool,action,params)=>{assert.deepEqual(params.target,target);return {success:true,data:opened()};});
  finishChat(c);assert.equal(c.state.phase,'done');
});
test('replanning may reference successful resolver output; direct model paths are rejected',()=>{
  const completed=[{toolCallId:'resolve',tool:'app',action:'resolveTarget',status:'done'}];
  assert.equal(validateAndNormaliseLLMSteps([{id:'open2',tool:'app',action:'openWithTarget',params:{app:'VS Code',targetFromStep:'resolve'}}],1,completed).length,1);
  assert.equal(validateAndNormaliseLLMSteps([{tool:'app',action:'openWithTarget',params:{app:'VS Code',target}}]).length,0);
});
