import test from 'node:test';
import assert from 'node:assert/strict';
import {systemCapabilities} from '../apps/WindowsSystemCapabilityRegistry.js';
import {validateTarget} from '../apps/AppTargetPolicy.js';
import {AppService} from '../services/AppService.js';
import {resolveDocumentTarget} from '../apps/DocumentTarget.js';
import {capabilitiesFor} from '../apps/AppCapabilities.js';
import {ToolEngineRouter} from '../ToolEngineRouter.js';
test('system records resolve only when supplied by the registry',async()=>{
  const registry={apps:systemCapabilities(),aliases:{},errors:[],ensureTrusted:async()=>{}};
  const service=new AppService(null,{registry});
  for(const app of systemCapabilities()){
    const r=await service.resolve(app.name);assert.equal(r.app.id,app.id);validateTarget(r.app,()=>true);
    assert.throws(()=>validateTarget({...r.app,launchArgs:['malicious']},()=>true));
  }
});
test('native adapters distinguish targets without defining installed apps',()=>{
  assert.equal(capabilitiesFor({executablePath:'C:\\Apps\\Code.exe'}).openFolder,true);
  assert.equal(capabilitiesFor({executablePath:'C:\\Apps\\vlc.exe'}).openMedia,true);
  assert.deepEqual(capabilitiesFor({executablePath:'C:\\Apps\\new-app.exe'}).types,[]);
});
test('target validation rejects commands, traversal and unknown types',async()=>{
  for(const target of [{type:'MEDIA',path:'cmd /c bad'},{type:'FILE',path:'C:\\a\\..\\b.txt'},{type:'URL',value:'javascript:alert(1)'},{type:'URL',value:'https://user:pass@example.com'},{type:'EXECUTABLE',path:'C:\\Windows\\notepad.exe'}])await assert.rejects(()=>resolveDocumentTarget(target));
  assert.deepEqual(await resolveDocumentTarget({type:'url',value:'https://example.com'}),{type:'URL',value:'https://example.com/'});
});
test('nested target schema reaches permission engine as SAFE_WRITE',()=>{
  const router=new ToolEngineRouter();
  const r=router.policy.evaluate({tool:'app',action:'openWithTarget',params:{app:'VLC',target:{type:'MEDIA',path:'D:\\Movies\\test.mp4'}}},{authenticated:true,scope:'backend:test',taskId:'test',origin:'model'});
  assert.equal(r.decision,'ALLOW');assert.equal(r.risk,'SAFE_WRITE');
  assert.equal(router.policy.evaluate({tool:'app',action:'openWithTarget',params:{app:'VLC',target:{type:'FILE',path:'x',command:'bad'}}},{authenticated:true,scope:'backend:test',taskId:'test'}).decision,'DENY');
});
