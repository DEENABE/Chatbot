import test from 'node:test';
import assert from 'node:assert/strict';
import {AppInspectorService} from '../services/AppInspectorService.js';
import {inferCapabilities,resolveSemanticControl} from '../apps/SemanticUIResolver.js';
import {VisionFallbackService} from '../services/VisionFallbackService.js';
import {UIAutomationService} from '../services/UIAutomationService.js';
import {executionContext} from '../ExecutionContext.js';
const controls=[{name:'Open File',controlType:'MenuItem',enabled:true},{name:'Open Folder',controlType:'MenuItem',enabled:true},{name:'Run',controlType:'Button',enabled:true}];
test('semantic controls disambiguate project folders and do not infer execution permission',()=>{
 assert.equal(resolveSemanticControl('open my project folder',controls).control.name,'Open Folder');
 assert.equal(resolveSemanticControl('do something',controls).errorCode,'LOW_MATCH_CONFIDENCE');
 assert.equal(resolveSemanticControl('open my project',[controls[1],{...controls[1]}]).errorCode,'AMBIGUOUS_CONTROL');
 assert.equal(inferCapabilities(controls).find(c=>c.intent==='run').executable,false);
});
test('inspector uses scoped app context, caches unchanged capabilities and reinspects navigation',async()=>{
 let reads=0;const app={activeContexts:new Map([['owner',{query:'Editor'}]]),resolve:async()=>({success:true,app:{id:'editor'}})};
 const inspector=new AppInspectorService(null,app,{generic:async(action)=>{reads++;return {controls,windowId:1,processId:2,verification:{status:'verified'}};}});
 await executionContext.run({scope:'owner'},async()=>{const a=await inspector.inspect(),b=await inspector.inspect();assert.equal(a.capabilities,b.capabilities);await inspector.navigate({goal:'open my project'});assert.equal(reads,5);await assert.rejects(()=>inspector.execute('resolveControl',{goal:'missing'}),e=>e.code==='LOW_MATCH_CONFIDENCE');});
 await executionContext.run({scope:'other'},()=>assert.rejects(()=>inspector.inspect(),e=>e.code==='WINDOW_NOT_FOUND'));
});
test('vision fails closed without provider and wipes temporary frame',async()=>{
 assert.equal((await new VisionFallbackService().inspect({})).errorCode,'VISION_UNAVAILABLE');
 const frame=Buffer.from('private pixels');const vision=new VisionFallbackService({captureWindow:async()=>frame,analyseLocal:async()=>[{x:2,y:2,width:4,height:4,confidence:.98},{x:50,y:0,width:1,height:1,confidence:1}]});
 const r=await vision.inspect({windowId:1,bounds:{width:20,height:20},sensitiveRegions:[],privacyVerified:true});assert.equal(r.controls.length,1);assert.ok(frame.every(b=>b===0));
});
test('implicit arithmetic refuses an inactive Calculator before launching or touching it',async()=>{
 let launched=false;const ui=new UIAutomationService(null,{resolve:async()=>({success:true,app:{appUserModelId:'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App'}}),openApp:async()=>{launched=true;}},{runner:async()=>{throw Error('Must not act');}});ui.generic=async()=>({foreground:false});
 await assert.rejects(()=>ui.perform('calculate',{expression:'5+4',requireActive:true}),e=>e.code==='ACTIVE_APP_MISMATCH');assert.equal(launched,false);
});
