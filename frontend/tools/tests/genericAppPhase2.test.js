import test from 'node:test';
import assert from 'node:assert/strict';
import {computerTask} from '../../../backend/src/orchestrator/ComputerTaskPolicy.js';
import {resolveElement} from '../../../backend/src/orchestrator/ElementResolver.js';
import {nextDesktopDecision} from '../../../backend/src/orchestrator/GenericAppPlanner.js';
import {GenericDesktopService} from '../services/GenericDesktopService.js';
import {executionContext} from '../ExecutionContext.js';
import {buildSemanticSnapshot} from '../apps/SemanticUI.js';
import {assertDesktopApplication} from '../apps/Phase2ApplicationPolicy.js';
const app={id:'new-app',name:'Unseen Editor',executablePath:'C:\\Programs\\Unseen\\editor.exe'};
const context={authenticated:true,scope:'backend:phase2',taskId:'task',origin:'model'};
test('normal UI compound requests use generic loop rather than interpreting goal as a file',()=>{
 for(const text of ['Open Blender and add a cube','Open VLC and open network stream','Open VS Code and open my project folder','Open Notepad++ and replace hello with hi','run New Editor and select Home'])assert.ok(computerTask(text).genericDesktop,text);
});
test('system management is rejected by target metadata before launch or inspection',async()=>{
 let calls=0;const service=new GenericDesktopService(null,{resolve:async()=>({success:true,app:{...app,source:'windows_system'}}),openApp:async()=>{calls++;}},null,{reader:async()=>{calls++;}});
 await assert.rejects(executionContext.run(context,()=>service.observe({query:'anything'},true)),{code:'SYSTEM_APPLICATION_OUT_OF_SCOPE'});assert.equal(calls,0);
 assert.throws(()=>assertDesktopApplication({...app,executablePath:'C:\\Windows\\System32\\anything.exe'}));
});
test('unverified Phase 1 launch never proceeds into UI automation',async()=>{
 let inspected=false;const service=new GenericDesktopService(null,{resolve:async()=>({success:true,app}),openApp:async()=>({success:false,status:'APP_LAUNCH_UNVERIFIED'})},null,{reader:async()=>{inspected=true;}});
 await assert.rejects(executionContext.run(context,()=>service.observe({query:app.name},true)),{code:'APP_LAUNCH_UNVERIFIED'});assert.equal(inspected,false);
});
test('semantic resolver normalizes ellipsis, respects parent and type, refuses ambiguous controls',()=>{
 const snapshot={elements:[{elementId:'a',label:'Media',role:'MenuBar',enabled:true},{elementId:'b',label:'Open Network Stream...',role:'MenuItem',enabled:true,parentId:'a'}]};
 assert.equal(resolveElement({name:'Open Network Stream',controlType:'MenuItem',parentName:'Media'},snapshot).elementId,'b');
 assert.equal(resolveElement({name:'Open Network Stream',controlType:'Button'},snapshot),null);
 snapshot.elements.push({...snapshot.elements[1],elementId:'c'});assert.equal(resolveElement({name:'Open Network Stream'},snapshot),null);
});
test('snapshot excludes hidden and duplicate controls and marks empty UI insufficient',async()=>{
 const control={locator:'a',label:'Home',role:'TabItem',enabled:true,actions:['select'],provider:'UIA'};
 const s=buildSemanticSnapshot({controls:[control,control,{...control,locator:'b',visible:false}],provider:'UIA'},app).snapshot;assert.equal(s.elements.length,1);
 const empty=buildSemanticSnapshot({controls:[],provider:'UIA'},app).snapshot;
 const result=await nextDesktopDecision({task:'open Unseen Editor and show Home',evidence:[{toolName:'desktop_open',success:true,data:empty}],complete:async()=>{throw Error('should not call model');}});
 assert.equal(result.status,'UI_AUTOMATION_INSUFFICIENT');
});
test('goal verification refuses changed process even with an identical fingerprint',async()=>{
 let pid=10;const reader=async()=>({success:true,processId:pid,windowId:20,screenFingerprint:'same',controls:[{locator:'a',label:'Home',role:'Text',enabled:true,actions:[],provider:'UIA'}]});
 const service=new GenericDesktopService(null,{resolve:async()=>({success:true,app})},null,{reader});
 await executionContext.run(context,async()=>{const snapshot=await service.observe({query:app.name},false);pid=11;await assert.rejects(service.verify({snapshotId:snapshot.snapshotId,goal:'show Home',evidenceIds:[snapshot.elements[0].elementId]}),{code:'STALE_SNAPSHOT'});});
});

test('fresh evidence survives unrelated UI change but not changed cited controls',async()=>{
 let signature='stable',fingerprint='initial';const reader=async()=>({success:true,processId:10,windowId:20,screenFingerprint:fingerprint,controls:[{locator:'a',signature,label:'Home',role:'Text',enabled:true,actions:[],provider:'UIA'}]});
 const service=new GenericDesktopService(null,{resolve:async()=>({success:true,app})},null,{reader});
 await executionContext.run(context,async()=>{const s=await service.observe({query:app.name},false);const params={snapshotId:s.snapshotId,goal:'show Home',evidenceIds:[s.elements[0].elementId]};fingerprint='clock changed';assert.equal((await service.verify(params)).success,true);signature='changed';await assert.rejects(service.verify(params),{code:'STALE_SNAPSHOT'});});
});
test('unobserved replay is replaced by a fresh observation on stale action',async()=>{
 const decision=await nextDesktopDecision({task:'open Unseen Editor and show Home',evidence:[{toolName:'desktop_act',success:false,error:{code:'STALE_SNAPSHOT'}}],complete:async()=>{throw Error('must observe first');}});
 assert.equal(decision.call.action,'observe');
});
