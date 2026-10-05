import test from 'node:test';
import assert from 'node:assert/strict';
import {createOrchestratorPlan,validateAndNormaliseLLMSteps} from './OrchestratorPlanner.js';
import {routeTask} from './TaskRouter.js';
import {verifyOutcome} from './Verifier.js';
test('new app names route and plan with query only',async()=>{
  for(const name of ['VLC','Some Brand New Application','Visual Studio Code']){
    assert.equal((await routeTask(`Open ${name}`)).taskType,'open_application');
    const p=await createOrchestratorPlan({task:`Open ${name}`,taskType:'open_application'});assert.equal(p.steps[0].tool,'app');assert.equal(p.steps[0].action,'openApp');assert.deepEqual(p.steps[0].params,{query:name});
  }
  assert.equal(validateAndNormaliseLLMSteps([{tool:'process',action:'startProcess',params:{command:'C:\\Invented.exe'}}]).length,0);
  assert.equal(validateAndNormaliseLLMSteps([{tool:'app',action:'openApp',params:{query:'Code',executablePath:'bad'}}]).length,0);
});
test('only verified app evidence produces a success message',async()=>{
  const step={tool:'app',action:'openApp',params:{query:'Code'},status:'done',toolCallId:'one',observation:{toolCallId:'one',success:true,data:{success:true,status:'APP_OPENED',app:{id:'code',name:'Visual Studio Code'},processId:123,readiness:{status:'ready',pid:123,criterion:'executable_process',observedAt:new Date().toISOString()}}}};
  assert.equal((await verifyOutcome({steps:[step]})).success,true);step.observation.data.readiness.status='not_ready';assert.equal((await verifyOutcome({steps:[step]})).success,false);
});
