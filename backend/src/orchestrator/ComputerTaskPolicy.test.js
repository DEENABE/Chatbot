import test from 'node:test';
import assert from 'node:assert/strict';
import {computerTask,currentToolEvidence,executionOnlyReply} from './ComputerTaskPolicy.js';
import {createOrchestratorPlan} from './OrchestratorPlanner.js';
import {routeTask} from './TaskRouter.js';
test('computer requests require tools while ordinary arithmetic and explanations remain chat',()=>{
  for(const text of ['Calculate 1+1 using Calculator','Open Chrome','Open Notepad and type Hello','Open VS Code and open my project','List files in my folder','Change my desktop settings','What apps are running?'])assert.equal(computerTask(text)?.requiresTools,true,text);
  for(const text of ['What is 1+1?','Explain how Calculator works','How do I open Notepad?','Write a story about a computer','It started after the Windows update.'])assert.equal(computerTask(text),null,text);
});
test('safe deterministic requests preserve the expression and exact text',async()=>{
  assert.deepEqual(computerTask('Calculate 1+1 using Calculator').call,{tool:'uiAutomation',action:'calculate',params:{expression:'1+1'}});
  assert.equal(computerTask('Open Notepad and type "Hello!"').call.params.text,'Hello!');
  assert.equal(computerTask('Type Hello in Notepad').call.params.text,'Hello');
  assert.equal(computerTask('Calculate -1+1 using Calculator').call,undefined);
  assert.equal(computerTask('Calculate 1+1+1 using Calculator').call,undefined);
  const plan=await createOrchestratorPlan({task:'Calculate 1+1 using Calculator',taskType:'desktop_interaction'});
  assert.equal(plan.steps[0].tool,'uiAutomation');assert.equal((await routeTask('Calculate 1+1 using Calculator')).taskType,'desktop_interaction');
});
test('only current-turn tool evidence can finish an action; open alone cannot finish UI work',()=>{
  assert.deepEqual(currentToolEvidence([{role:'tool',content:'{"success":true}'},{role:'user',content:'new task'}]),[]);
  const task=computerTask('Calculate 1+1 using Calculator');
  assert.match(executionOnlyReply(task,[]),/blocked/i);
  assert.match(executionOnlyReply(task,[{success:true,toolName:'app_openApp',data:{message:'opened'}}]),/not been performed/);
  assert.equal(executionOnlyReply(task,[{success:false,error:{message:'Tool failed'}}]),'Tool failed');
  assert.equal(executionOnlyReply(task,[{needsConfirmation:true,confirmationMessage:'Allow?'}]),'Allow?');
  assert.equal(executionOnlyReply(task,[{success:true,toolName:'uiAutomation_calculate',data:{message:'Calculator shows 2',verification:{status:'verified'}}}]),'Calculator shows 2');
});
