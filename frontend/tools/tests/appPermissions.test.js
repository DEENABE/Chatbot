import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {AppPermissionStore,levelAllows,levelSummary,PERMISSION_LEVELS,DEFAULT_LEVEL} from '../apps/AppPermissionStore.js';
import {categoryFor,isThirdPartyApp,describeApp} from '../apps/AppCatalog.js';
import {AppService} from '../services/AppService.js';
import {AppRegistryService} from '../apps/AppRegistryService.js';
import {GenericDesktopService} from '../services/GenericDesktopService.js';
import {executionContext} from '../ExecutionContext.js';
import {createToolRegistry} from '../security/ToolRegistry.js';
import {modelPolicy} from '../repair/contract.js';
import {nextDesktopDecision} from '../../../backend/src/orchestrator/GenericAppPlanner.js';
import {mergeSystemCapabilities} from '../apps/AppDiscoveryService.js';
import {normalize} from '../apps/AppResolverService.js';
const rec=(name,exe=name,extra={})=>({id:`id-${name.replace(/\W/g,'')}`,name,normalizedName:normalize(name),aliases:[normalize(name)],available:true,source:'start_menu',launchType:'executable',executablePath:`C:\\Programs\\${exe}.exe`,launchArgs:[],supportedExtensions:[],supportedProtocols:[],...extra});
const context={authenticated:true,scope:'backend:perm',taskId:'task',origin:'model'};
const tmp=async()=>fs.mkdtemp(path.join(os.tmpdir(),'perm-'));

test('levels are ordered and each one maps to what it allows; CRITICAL is never allowed',()=>{
  assert.deepEqual(PERMISSION_LEVELS,['blocked','read','interact','modify']);
  const matrix={blocked:[0,0,0],read:[1,0,0],interact:[1,1,0],modify:[1,1,1]};
  for(const [level,[read,safe,danger]] of Object.entries(matrix)){
    assert.equal(levelAllows(level,'READ'),!!read,level);assert.equal(levelAllows(level,'SAFE_WRITE'),!!safe,level);assert.equal(levelAllows(level,'DANGEROUS'),!!danger,level);
    assert.equal(levelAllows(level,'CRITICAL'),false,level);assert.equal(levelAllows(level,'UNKNOWN'),false,level);
  }
  assert.equal(levelSummary('read').allows.join(),'read_ui');
  assert.equal(DEFAULT_LEVEL,'modify');
});
test('store persists per-app levels, ignores corrupt input and rejects bad ids/levels',async()=>{
  const directory=await tmp();
  try {
    const store=new AppPermissionStore({directory});assert.equal(store.levelFor({id:'a'}),'modify');
    await store.setLevel('a','read');await store.setLevel('b','blocked');
    const reloaded=new AppPermissionStore({directory});await reloaded.ready;
    assert.equal(reloaded.levelFor({id:'a'}),'read');assert.equal(reloaded.levelFor({id:'b'}),'blocked');assert.equal(reloaded.levelFor({id:'other'}),'modify');
    await reloaded.setLevel('a','modify');assert.equal(reloaded.explicitLevel('a'),null);
    for(const [id,level] of [['../x','read'],['a b','read'],['','read'],['a','admin'],['a',undefined]])await assert.rejects(reloaded.setLevel(id,level),{code:'INVALID_PERMISSION_LEVEL'});
    await fs.writeFile(path.join(directory,'app-permissions.json'),JSON.stringify({schemaVersion:1,default:'blocked',levels:{ok:'read','bad id':'read',x:'root',y:5}}));
    const hostile=new AppPermissionStore({directory});await hostile.ready;
    assert.equal(hostile.levelFor({id:'ok'}),'read');assert.equal(hostile.levelFor({id:'x'}),'modify');assert.equal(hostile.levelFor({id:'y'}),'modify');
    await fs.writeFile(path.join(directory,'app-permissions.json'),'{not json');const broken=new AppPermissionStore({directory});await broken.ready;assert.equal(broken.levelFor({id:'a'}),'modify');
  } finally {await fs.rm(directory,{recursive:true,force:true});}
});
test('catalog recognises third-party apps only and describes what the assistant can do',()=>{
  const apps=mergeSystemCapabilities([rec('Visual Studio Code','Code'),rec('VLC media player','vlc'),rec('Zorvex Widget')]);
  const listed=apps.filter(isThirdPartyApp).map(a=>a.name);
  assert.deepEqual(listed.sort(),['VLC media player','Visual Studio Code','Zorvex Widget']);
  assert.equal(categoryFor(rec('Visual Studio Code','Code')),'Code editor');assert.equal(categoryFor(rec('VLC media player','vlc')),'Media');assert.equal(categoryFor(rec('Zorvex Widget')),'General');
  const d=describeApp(rec('Visual Studio Code','Code'),'read');
  assert.ok(d.abilities.includes('open_file')&&d.abilities.includes('read_visible_ui'));assert.equal(d.permission.level,'read');assert.match(d.nextSteps.join(' '),/desktop_open/);
  assert.match(describeApp(rec('Visual Studio Code','Code'),'blocked').nextSteps[0],/blocked/);
  assert.equal(isThirdPartyApp(rec('Cmd',"cmd",{resolutionRisk:'sensitive'})),false);assert.equal(isThirdPartyApp({...rec('Gone'),available:false}),false);
});
const appService=async(apps,directory)=>{const registry=new AppRegistryService({directory,discovery:{discover:async()=>({apps:mergeSystemCapabilities(apps),errors:[]})}});return new AppService(null,{registry});};
test('listApps/describeApp expose the catalog and permissions; setAppPermission changes one app',async()=>{
  const directory=await tmp();
  try {
    const service=await appService([rec('Visual Studio Code','Code'),rec('Zorvex Widget')],directory);
    const listed=await service.listApps({});
    assert.deepEqual(listed.apps.map(a=>a.name),['Visual Studio Code','Zorvex Widget']);assert.ok(listed.apps.every(a=>a.permission==='modify'&&a.category));
    assert.equal((await service.listApps({query:'zorvex'})).apps[0].name,'Zorvex Widget');
    const app=listed.apps[1];
    assert.equal((await service.setAppPermission({appId:app.id,level:'read'})).permission.level,'read');
    assert.equal((await service.listApps({})).apps.find(a=>a.id===app.id).permission,'read');
    assert.equal((await service.describeApp({query:'zorvex widget'})).app.permission.level,'read');
    assert.equal((await service.describeApp({query:'device manager'})).status,'SYSTEM_APP');
    assert.equal((await service.setAppPermission({appId:'device-manager',level:'blocked'})).success,false);
    assert.equal((await service.setAppPermission({appId:'nope',level:'read'})).success,false);
    assert.match(service.getConfirmationMessage('setAppPermission',{appId:app.id,level:'blocked'}),/Zorvex Widget.*modify|Zorvex Widget.*read/);
    // Persisted for the next start.
    const again=await appService([rec('Visual Studio Code','Code'),rec('Zorvex Widget')],directory);assert.equal((await again.listApps({})).apps.find(a=>a.id===app.id).permission,'read');
  } finally {await fs.rm(directory,{recursive:true,force:true});}
});
test('a blocked app is never launched by openApp',async()=>{
  const service=await appService([rec('Zorvex Widget')]);let launches=0;service.processService={launchApp:async()=>{launches++;return {readiness:{status:'ready'}};}};
  const id=(await service.listApps({})).apps[0].id;await service.setAppPermission({appId:id,level:'blocked'});
  const result=await service.openApp({query:'Zorvex Widget'});
  assert.equal(result.status,'APP_PERMISSION_DENIED');assert.equal(result.success,false);assert.equal(launches,0);
});
const app={id:'id-Zorvex',name:'Zorvex Widget',executablePath:'C:\\Programs\\Zorvex.exe',available:true,source:'start_menu'};
const controls=[{locator:'home',label:'Home',role:'TabItem',enabled:true,actions:['select'],provider:'UIA'},{locator:'find',label:'Search files',role:'Button',enabled:true,actions:['invoke'],provider:'UIA'},{locator:'del',label:'Delete item',role:'Button',enabled:true,actions:['invoke'],provider:'UIA'}];
const desktop=(level,acts=[])=>{
  const permissions=new AppPermissionStore({});permissions.levels.set(app.id,level);
  const reader=async input=>{if(input.action==='act')acts.push(input.locator);return {success:true,processId:5,windowId:9,screenFingerprint:'fp'+acts.length,controls,provider:'UIA'};};
  const service=new GenericDesktopService({request:()=>({confirmationId:'c'})},{resolve:async()=>({success:true,app}),openApp:async()=>({success:true,processId:5}),permissions},null,{reader,permissions});
  return {service,acts};
};
const find=(snapshot,label)=>snapshot.elements.find(e=>e.label===label);
test('snapshot tells the planner which actions the level allows',async()=>{
  for(const [level,expected] of [['read',{Home:false,'Search files':false,'Delete item':false}],['interact',{Home:true,'Search files':true,'Delete item':false}],['modify',{Home:true,'Search files':true,'Delete item':true}]]){
    const {service}=desktop(level);
    await executionContext.run(context,async()=>{
      const snapshot=await service.observe({query:'zorvex'},false);
      assert.equal(snapshot.permission.level,level);
      for(const [label,allowed] of Object.entries(expected))assert.equal(find(snapshot,label).actions[0].allowed,allowed,`${level}/${label}`);
    });
  }
});
test('read level can observe but every action is refused before anything is executed',async()=>{
  const {service,acts}=desktop('read');
  await executionContext.run(context,async()=>{
    const snapshot=await service.observe({query:'zorvex'},true);
    await assert.rejects(service.execute('act',{snapshotId:snapshot.snapshotId,elementId:find(snapshot,'Home').elementId,operation:'select'}),{code:'APP_PERMISSION_DENIED',message:/needs .interact./});
    await assert.rejects(service.execute('actConfirmed',{snapshotId:snapshot.snapshotId,elementId:find(snapshot,'Delete item').elementId,operation:'invoke'}),{code:'APP_PERMISSION_DENIED'});
  });
  assert.deepEqual(acts,[]);
});
test('interact level operates low-risk controls but refuses data-changing ones without asking for confirmation',async()=>{
  const {service,acts}=desktop('interact');
  await executionContext.run(context,async()=>{
    const snapshot=await service.observe({query:'zorvex'},false);
    const ok=await service.execute('act',{snapshotId:snapshot.snapshotId,elementId:find(snapshot,'Home').elementId,operation:'select'});
    assert.equal(ok.data.operation,'select');assert.equal(ok.data.targetLabel,'Home');assert.ok(acts.includes('home'),'the low-risk control was operated');
    const next=await service.observe({query:'zorvex'},false);
    await assert.rejects(service.execute('actConfirmed',{snapshotId:next.snapshotId,elementId:find(next,'Delete item').elementId,operation:'invoke'}),{code:'APP_PERMISSION_DENIED'});
  });
  assert.equal(acts.includes('del'),false);
});
test('modify level still needs the per-action human confirmation for dangerous controls',async()=>{
  const {service,acts}=desktop('modify');
  await executionContext.run(context,async()=>{
    const snapshot=await service.observe({query:'zorvex'},false);
    const plain=await service.execute('act',{snapshotId:snapshot.snapshotId,elementId:find(snapshot,'Delete item').elementId,operation:'invoke'}).catch(e=>e);
    assert.match(JSON.stringify(plain),/APPROVAL_REQUIRED/);
    const asked=await service.execute('actConfirmed',{snapshotId:snapshot.snapshotId,elementId:find(snapshot,'Delete item').elementId,operation:'invoke'});
    assert.equal(asked.needsConfirmation,true);
  });
  assert.equal(acts.includes('del'),false);
});
test('blocked level stops observe and open before launch or inspection',async()=>{
  let launches=0,reads=0;const permissions=new AppPermissionStore({});permissions.levels.set(app.id,'blocked');
  const service=new GenericDesktopService(null,{resolve:async()=>({success:true,app}),openApp:async()=>{launches++;},permissions},null,{reader:async()=>{reads++;},permissions});
  await assert.rejects(executionContext.run(context,()=>service.observe({query:'zorvex'},true)),{code:'APP_PERMISSION_DENIED'});
  assert.equal(launches+reads,0);
});
test('the planner never proposes an action its snapshot marks disallowed and reports the level',async()=>{
  const {service}=desktop('read');let snapshot;await executionContext.run(context,async()=>{snapshot=await service.observe({query:'zorvex'},false);});
  const target=find(snapshot,'Home');
  const result=await nextDesktopDecision({task:'open Zorvex Widget and select Home',evidence:[{toolName:'desktop_open',success:true,data:snapshot}],complete:async()=>({kind:'act',elementId:target.elementId,operation:'select'})});
  assert.equal(result.status,'APP_PERMISSION_DENIED');assert.match(result.message,/read/);assert.equal(result.call,undefined);
});
test('the model can list and describe apps but cannot change permissions; the change needs approval',()=>{
  assert.equal(modelPolicy('app','listApps'),null);assert.equal(modelPolicy('app','describeApp'),null);
  assert.equal(modelPolicy('app','setAppPermission',{appId:'x',level:'modify'}),'MODEL_CAPABILITY_DENIED');
  assert.equal(modelPolicy('permissions','set'),'MODEL_CAPABILITY_DENIED');
  const registry=createToolRegistry(new Map([['app',new AppService(null,{registry:new AppRegistryService({discovery:{discover:async()=>({apps:[],errors:[]})}})})]]));
  assert.equal(registry.get('app.listApps').risk,'READ');assert.equal(registry.get('app.describeApp').risk,'READ');
  assert.equal(registry.get('app.setAppPermission').risk,'DANGEROUS');assert.equal(registry.get('app.setAppPermission').requiresApproval,true);
});
