import test from 'node:test';
import assert from 'node:assert/strict';
import {UIAutomationService} from '../services/UIAutomationService.js';
import {ToolEngineRouter} from '../ToolEngineRouter.js';
import {executionContext} from '../ExecutionContext.js';
const identity='Microsoft.WindowsCalculator_8wekyb3d8bbwe!App';
const appService={resolve:async()=>({success:true,app:{appUserModelId:identity}}),openApp:async()=>({success:true,processId:123})};
test('UI tool validates before launching and rejects substituted app identity',async()=>{
  let called=0;const service=new UIAutomationService(null,appService,{runner:async()=>{called++;}});
  for(const expression of ['1+1; calc','1+1+1','-1+1','1e10+2'])await assert.rejects(service.execute('calculate',{expression}),/Validation/);
  assert.equal(called,0);
  service.appService={...appService,resolve:async()=>({success:true,app:{appUserModelId:'OtherApp!App'}})};
  await assert.rejects(service.execute('calculate',{expression:'1+1'}),/identity/);assert.equal(called,0);
});
test('UI success requires observed, matching evidence and an owned application identity',async()=>{
  const service=new UIAutomationService(null,appService,{runner:async()=>({processId:123,appUserModelId:identity,expression:'1+1',displayText:'2',verification:{status:'verified',criterion:'calculator_display'}})});
  const r=await service.execute('calculate',{expression:'1+1'});assert.equal(r.data.status,'UI_ACTION_COMPLETED');assert.match(r.data.message,/shows 2/);
  service.runner=async()=>({processId:123,appUserModelId:identity,expression:'8+8',displayText:'16',verification:{status:'verified',criterion:'calculator_display'}});
  await assert.rejects(service.execute('calculate',{expression:'1+1'}),/did not match/);
});
test('only bounded UI actions are exposed to models; arbitrary clicks, keys, PIDs and scripts are denied',()=>{
  const router=new ToolEngineRouter(),context={authenticated:true,scope:'backend:test',taskId:'test',origin:'model'};
  assert.ok(router.getTools({model:true}).uiAutomation.some(a=>a.action==='calculate'));
  for(const request of [{tool:'uiAutomation',action:'click',params:{x:1,y:1}},{tool:'uiAutomation',action:'calculate',params:{expression:'1+1',processId:12}},{tool:'uiAutomation',action:'typeInNotepad',params:{text:'Hello',script:'evil'}}])assert.equal(router.policy.evaluate(request,context).decision,'DENY');
});
test('Windows UI automation really presses Calculator buttons and verifies its display',{skip:process.platform!=='win32'||process.env.CHANAKYA_UI_INTEGRATION!=='1',timeout:60000},async()=>{
  const router=new ToolEngineRouter();const r=await executionContext.run({authenticated:true,scope:'backend:uia-test',taskId:'integration',origin:'model'},()=>router.dispatch({tool:'uiAutomation',action:'calculate',params:{expression:'1+1'}}));
  assert.equal(r.success,true,JSON.stringify(r));assert.equal(r.data.displayText,'2');assert.equal(r.data.verification.criterion,'calculator_display');
});
