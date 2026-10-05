import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {AppService} from '../services/AppService.js';
import {resolveDocumentTarget} from '../apps/DocumentTarget.js';
import {FileAssociationService} from '../apps/FileAssociationService.js';
import {mapToolsToOllamaSchema} from '../../src/services/toolSchemas.js';

const root=await fs.mkdtemp(path.join(process.cwd(),'app-target-tests-'));
const paths=[];
for(const name of ['Code.exe','vlc.exe','unknown.exe','first.mp4','second.mp4','document.txt','demo.code-workspace']) {
  const p=path.join(root,name);await fs.writeFile(p,'test');paths.push(p);
}
test.after(async()=>{for(const p of paths)await fs.unlink(p);await fs.rmdir(root);});
const app=name=>({id:name,name,available:true,source:'start_menu',launchType:'executable',executablePath:path.join(root,name),launchArgs:[],aliases:[name],normalizedName:name.toLowerCase()});
const evidence=target=>({processId:123,verification:{status:'verified',criterion:'window_title',windowTitle:path.basename(target.path||target.value),observedAt:new Date().toISOString()}});
function service(name,launch,options={}) {
  const a=app(name),registry={apps:[a],errors:[],aliases:{},ensureTrusted:async()=>{},refresh:async()=>{}};
  const s=new AppService(null,{registry,processService:{launchApp:launch,_runPS:async()=>null},...options});
  s.resolve=async()=>({success:true,app:a});return s;
}
test('VS Code file/folder/workspace and VLC second target all dispatch, including already-running app',async()=>{
  for(const [name,targets] of [['Code.exe',[{type:'folder',path:root},{type:'file',path:path.join(root,'document.txt')},{type:'workspace',path:path.join(root,'demo.code-workspace')}]],['vlc.exe',[{type:'media',path:path.join(root,'first.mp4')},{type:'media',path:path.join(root,'second.mp4')}]]]) {
    const calls=[];const s=service(name,async(a,target)=>{calls.push(target);return evidence(target);});
    for(const target of targets){const r=await s.openWithTarget({app:name,target});assert.equal(r.status,'APP_TARGET_OPENED');assert.equal(r.strategy,'NATIVE_ARGUMENT');assert.equal(r.requestedApp,name);}
    assert.equal(calls.length,targets.length);
  }
});
test('missing folder, missing movie and unsupported type never launch',async()=>{
  let calls=0;const s=service('Code.exe',()=>{calls++;});
  for(const type of ['FOLDER','MEDIA'])assert.equal((await s.openWithTarget({app:'Code',target:{type,path:path.join(root,'missing')}})).status,'TARGET_NOT_FOUND');
  assert.equal((await s.openWithTarget({app:'Code',target:{type:'SCRIPT',path:paths[0]}})).status,'TARGET_TYPE_UNSUPPORTED');assert.equal(calls,0);
});
test('process evidence alone fails; UI fallback is attempted for unknown app and its verification is required',async()=>{
  const s=service('Code.exe',async()=>({processId:123,readiness:{status:'ready'}}));
  assert.equal((await s.openWithTarget({app:'Code',target:{type:'FOLDER',path:root}})).status,'VERIFICATION_FAILED');
  let fallbacks=0;const unknown=service('unknown.exe',()=>{throw Error('Native must not run');},{uiFallback:async({target})=>{fallbacks++;return {success:true,...evidence(target)};}});
  const target={type:'FILE',path:path.join(root,'document.txt')};
  assert.equal((await unknown.openWithTarget({app:'New ERP',target})).strategy,'UI_AUTOMATION');assert.equal(fallbacks,1);
  unknown.uiFallback=async()=>({success:true});assert.equal((await unknown.openWithTarget({app:'New ERP',target})).success,false);
});
test('configured concepts resolve actual files and folders, without guessing an absent alias',async()=>{
  const s=service('Code.exe',()=>{}, {targetAliases:{'my project folder':{type:'FOLDER',path:root},'this movie':{type:'MEDIA',path:path.join(root,'first.mp4')}},targetRoots:[root]});
  assert.equal((await s.resolveTarget({query:'my project folder'})).target.path,root);
  assert.equal((await s.resolveTarget({query:'this movie'})).target.type,'MEDIA');
  assert.equal((await s.resolveTarget({query:'document.txt'})).target.path,path.join(root,'document.txt'));
  assert.equal((await s.resolveTarget({query:'this file'})).status,'TARGET_NOT_FOUND');
});
test('association fallback accepts only discovered executable plus target placeholder',async()=>{
  const a=app('unknown.exe');const assoc=new FileAssociationService({_runPS:async()=>`"${a.executablePath}" "%1"`});
  assert.equal((await assoc.resolve({type:'FILE',path:paths[5]},[a])).id,a.id);
  assoc.processService._runPS=async()=>`"${a.executablePath}" "%1" & calc.exe`;
  assert.equal(await assoc.resolve({type:'FILE',path:paths[5]},[a]),null);
});
test('document boundary and nested model schema retain type information',async()=>{
  await assert.rejects(()=>resolveDocumentTarget({type:'MEDIA',path:paths[0]}),/TARGET_TYPE_UNSUPPORTED/);
  const s=service('Code.exe',()=>{});const mapped=mapToolsToOllamaSchema({app:s.getActionList()});
  const target=mapped.find(t=>t.function.name==='app_openWithTarget').function.parameters.properties.target;
  assert.equal(target.type,'object');assert.equal(target.properties.path.type,'string');assert.deepEqual(target.required,['type']);
});
