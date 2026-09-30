import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as policy from '../apps/InputPolicy.js';
import * as backendPolicy from '../../../backend/src/orchestrator/InputPolicy.js';
import {GenericDesktopService} from '../services/GenericDesktopService.js';
import {AppPermissionStore} from '../apps/AppPermissionStore.js';
import {executionContext} from '../ExecutionContext.js';
import {createToolRegistry} from '../security/ToolRegistry.js';
import {modelPolicy} from '../repair/contract.js';
import {nextDesktopDecision} from '../../../backend/src/orchestrator/GenericAppPlanner.js';
import {computerTask,setInstalledApps} from '../../../backend/src/orchestrator/ComputerTaskPolicy.js';
import {freeformDesktopTask,sanitizeInstalledApps} from '../../../backend/src/orchestrator/FreeformDesktopTask.js';
import {capabilitySchemas} from '../../../backend/src/orchestrator/CapabilityContracts.js';

const risk=(keys,role='')=>policy.chordRisk(policy.parseChord(keys),role);
test('key chords are parsed strictly and classified by risk',()=>{
  assert.deepEqual(policy.parseChord('Ctrl + Shift + F'),{mods:['ctrl','shift'],key:'f',text:'ctrl+shift+f'});
  for(const bad of ['','ctrl+','ctrl+ctrl+','a+b','ctrl+shift','f13','x'.repeat(41),'ctrl++f','enter enter',null,42])assert.equal(policy.parseChord(bad),null,String(bad));
  for(const [keys,role,expected] of [
    ['down','','SAFE_WRITE'],['pagedown','','SAFE_WRITE'],['tab','','SAFE_WRITE'],['escape','','SAFE_WRITE'],['ctrl+f','','SAFE_WRITE'],['ctrl+a','','SAFE_WRITE'],['ctrl+c','','SAFE_WRITE'],['f3','','SAFE_WRITE'],
    ['enter','Edit','SAFE_WRITE'],['enter','','DANGEROUS'],['enter','Button','DANGEROUS'],['backspace','Document','SAFE_WRITE'],['delete','','DANGEROUS'],['space','','DANGEROUS'],['space','Edit','SAFE_WRITE'],['a','Edit','SAFE_WRITE'],['a','','DANGEROUS'],
    ['ctrl+s','Document','DANGEROUS'],['ctrl+v','Edit','DANGEROUS'],['ctrl+x','Edit','DANGEROUS'],['ctrl+z','Edit','DANGEROUS'],['ctrl+w','','DANGEROUS'],['f5','','DANGEROUS'],['alt+f','','DANGEROUS'],
    ['alt+f4','','CRITICAL'],['alt+tab','','CRITICAL'],['ctrl+alt+delete','','CRITICAL'],['ctrl+shift+escape','','CRITICAL'],['ctrl+escape','','CRITICAL'],['win+r','','CRITICAL'],['windows','','CRITICAL'],['printscreen','','CRITICAL'],
  ])assert.equal(risk(keys,role),expected,`${keys} in [${role}]`);
  assert.equal(policy.chordRisk(null),'CRITICAL');
  assert.equal(policy.validTypedText('hello world'),true);for(const bad of ['','a\nb','a\tb','a\u0000b','x'.repeat(501),null,5])assert.equal(policy.validTypedText(bad),false,String(bad));
});
test('the frontend and backend copies of the key policy behave identically',()=>{
  const corpus=['down','ctrl+f','ctrl+s','enter','alt+f4','win+d','ctrl+shift+f','f12','delete','space','a','x','ctrl+alt+delete','ctrl+shift+escape','bogus','ctrl+','pageup'];
  for(const keys of corpus)for(const role of ['','Edit','Document','Button']){
    assert.deepEqual(policy.parseChord(keys),backendPolicy.parseChord(keys),keys);
    assert.equal(policy.chordRisk(policy.parseChord(keys),role),backendPolicy.chordRisk(backendPolicy.parseChord(keys),role),`${keys}/${role}`);
  }
  assert.equal(fs.readFileSync(new URL('../apps/InputPolicy.js',import.meta.url),'utf8').replace(/\r\n/g,'\n'),fs.readFileSync(new URL('../../../backend/src/orchestrator/InputPolicy.js',import.meta.url),'utf8').replace(/\r\n/g,'\n'));
});

const app={id:'id-Editor',name:'Zorvex Editor',executablePath:'C:\\Programs\\Zorvex.exe',available:true,source:'start_menu'};
const context={authenticated:true,scope:'backend:input',taskId:'task',origin:'model'};
const baseControls=focused=>[{locator:'doc',label:'Text editor',role:'Document',enabled:true,actions:['focus'],focused,provider:'UIA',valueHash:'v1'},{locator:'btn',label:'Search files',role:'Button',enabled:true,actions:['invoke'],provider:'UIA'}];
const desktop=(level='modify',{focused=true,answer}={})=>{
  const permissions=new AppPermissionStore({});permissions.levels.set(app.id,level);const calls=[];let n=0;
  const reader=async input=>{if(input.action==='input'){calls.push(input);if(answer)return answer(input);}return {success:true,processId:5,windowId:9,screenFingerprint:'fp'+(input.action==='input'?++n:0),controls:baseControls(focused),provider:'UIA'};};
  const service=new GenericDesktopService({request:()=>({confirmationId:'c'})},{resolve:async()=>({success:true,app}),openApp:async()=>({success:true,processId:5}),permissions},null,{reader,permissions});
  return {service,calls};
};
const observe=(service,open=false)=>service.observe({query:'zorvex'},open);
const inputParams=(snapshot,extra)=>({snapshotId:snapshot.snapshotId,...extra});

test('snapshot reports the focused text field and what keyboard input the level allows',async()=>{
  for(const [level,focused,typeAllowed,keysAllowed] of [['read',true,false,false],['interact',true,true,true],['interact',false,false,true],['modify',true,true,true]]){
    const {service}=desktop(level,{focused});
    await executionContext.run(context,async()=>{
      const snapshot=await observe(service);
      assert.equal(snapshot.input.type.allowed,typeAllowed,`${level}/${focused}`);assert.equal(snapshot.input.keys.allowed,keysAllowed);assert.ok(snapshot.input.keys.guide.refused);
      assert.equal(snapshot.input.focusedTextField?.role||null,focused?'Document':null);
    });
  }
});
test('typing goes only into a focused text field, is bounded, and is verified',async()=>{
  const {service,calls}=desktop('interact');
  await executionContext.run(context,async()=>{
    let snapshot=await observe(service);
    const result=await service.execute('input',inputParams(snapshot,{kind:'type',text:'hello world'}));
    assert.equal(result.data.status,'UI_ACTION_VERIFIED');assert.equal(result.data.operation,'type');assert.equal(result.data.targetLabel,'Text editor');
    assert.deepEqual(calls.map(c=>[c.kind,c.payload]),[['type','hello world']]);
    // The snapshot is consumed by the mutation.
    await assert.rejects(service.execute('input',inputParams(snapshot,{kind:'type',text:'again'})),{code:'STALE_SNAPSHOT'});
    for(const bad of [{kind:'type',text:''},{kind:'type',text:'a\nb'},{kind:'type',text:'x'.repeat(501)},{kind:'type',text:'ok',keys:'a'},{kind:'key',keys:'ctrl+f',text:'x'},{kind:'key',keys:'bogus+key'},{kind:'other'}]){
      snapshot=await observe(service);
      await assert.rejects(service.execute('input',inputParams(snapshot,bad)),e=>e.code==='INVALID_INPUT'||/validation|VALIDATION/i.test(e.code||e.message),JSON.stringify(bad));
    }
  });
  assert.equal(calls.length,1,'nothing invalid reached the native layer');
});
test('typing without a focused text field is refused before any input is sent',async()=>{
  const {service,calls}=desktop('modify',{focused:false});
  await executionContext.run(context,async()=>{const snapshot=await observe(service);await assert.rejects(service.execute('input',inputParams(snapshot,{kind:'type',text:'hi'})),{code:'NO_EDITABLE_FOCUS'});});
  assert.equal(calls.length,0);
});
test('safe keys run directly; risky keys need the confirmed action; forbidden keys never run',async()=>{
  const {service,calls}=desktop('modify');
  await executionContext.run(context,async()=>{
    let snapshot=await observe(service);
    assert.equal((await service.execute('input',inputParams(snapshot,{kind:'key',keys:'Ctrl+F'}))).data.status,'UI_ACTION_VERIFIED');
    assert.deepEqual(calls.at(-1),{action:'input',executablePath:app.executablePath,appUserModelId:undefined,windowId:9,kind:'key',payload:'ctrl+f'});
    snapshot=await observe(service);
    await assert.rejects(service.execute('input',inputParams(snapshot,{kind:'key',keys:'ctrl+s'})),{code:'APPROVAL_REQUIRED'});
    const asked=await service.execute('inputConfirmed',inputParams(snapshot,{kind:'key',keys:'ctrl+s'}));
    assert.equal(asked.needsConfirmation,true);assert.match(asked.message,/pressing .ctrl\+s. in Zorvex Editor/i);
    assert.equal(calls.length,1,'confirmation is requested before anything is pressed');
    for(const keys of ['alt+f4','win+r','ctrl+alt+delete','alt+tab']){snapshot=await observe(service);await assert.rejects(service.execute('input',inputParams(snapshot,{kind:'key',keys})),{code:'CRITICAL_OPERATION'},keys);await assert.rejects(service.execute('inputConfirmed',inputParams(snapshot,{kind:'key',keys})),{code:'CRITICAL_OPERATION'},keys);}
  });
  assert.equal(calls.length,1);
});
test('the permission level bounds keyboard input like every other action',async()=>{
  for(const [level,keys,expect] of [['read','down','APP_PERMISSION_DENIED'],['interact','ctrl+f','ok'],['interact','ctrl+s','APP_PERMISSION_DENIED'],['blocked','down','APP_PERMISSION_DENIED'],['modify','ctrl+s','APPROVAL_REQUIRED']]){
    const {service,calls}=desktop(level==='blocked'?'read':level);
    await executionContext.run(context,async()=>{
      const snapshot=await observe(service);
      if(level==='blocked')service.permissions.levels.set(app.id,'blocked');
      const attempt=service.execute('input',inputParams(snapshot,{kind:'key',keys}));
      if(expect==='ok')assert.equal((await attempt).data.status,'UI_ACTION_VERIFIED');else await assert.rejects(attempt,{code:expect},`${level}/${keys}`);
      // A confirmation is never even requested when the level can never allow the key.
      if(expect==='APP_PERMISSION_DENIED'&&level==='interact')await assert.rejects(service.execute('inputConfirmed',inputParams(await observe(service),{kind:'key',keys})),{code:'APP_PERMISSION_DENIED'});
    });
    assert.equal(calls.length,expect==='ok'?1:0,`${level}/${keys}`);
  }
});
test('failures reported before sending are precise; anything else is treated as uncertain',async()=>{
  for(const [code,expected] of [['FOCUS_UNVERIFIED','FOCUS_UNVERIFIED'],['SENSITIVE_FOCUS','SENSITIVE_FOCUS'],['INPUT_REFUSED','CRITICAL_OPERATION'],['NO_EDITABLE_FOCUS','NO_EDITABLE_FOCUS']]){
    const {service}=desktop('modify',{answer:async()=>({success:false,code})});
    await executionContext.run(context,async()=>{const snapshot=await observe(service);await assert.rejects(service.execute('input',inputParams(snapshot,{kind:'key',keys:'down'})),{code:expected});});
  }
  const {service}=desktop('modify',{answer:async()=>({success:false,code:'UI_INSPECTION_FAILED'})});
  await executionContext.run(context,async()=>{const snapshot=await observe(service);await assert.rejects(service.execute('input',inputParams(snapshot,{kind:'key',keys:'down'})),{code:'UI_EXECUTION_UNCERTAIN'});});
  const other={...desktop('modify',{answer:async()=>({success:true,processId:99,windowId:9,screenFingerprint:'x',controls:[]})})};
  await executionContext.run(context,async()=>{const snapshot=await observe(other.service);await assert.rejects(other.service.execute('input',inputParams(snapshot,{kind:'key',keys:'down'})),{code:'UI_EXECUTION_UNCERTAIN'});});
});
test('desktop.input and inputConfirmed are registered with the right risk and the model may call them',()=>{
  const registry=createToolRegistry(new Map([['desktop',new GenericDesktopService(null,{},null,{reader:async()=>({})})]]));
  assert.equal(registry.get('desktop.input').risk,'SAFE_WRITE');assert.equal(registry.get('desktop.inputConfirmed').risk,'DANGEROUS');assert.equal(registry.get('desktop.inputConfirmed').requiresApproval,true);
  assert.equal(modelPolicy('desktop','input'),null);assert.equal(modelPolicy('desktop','inputConfirmed'),null);
  assert.ok(capabilitySchemas['desktop.input']&&capabilitySchemas['desktop.inputConfirmed']);
  assert.equal(modelPolicy('uiAutomation','sendKeys'),'MODEL_CAPABILITY_DENIED');
});

const snapshotFor=async(level,focused=true)=>{const {service}=desktop(level,{focused});let snapshot;await executionContext.run(context,async()=>{snapshot=await observe(service);});return snapshot;};
const decide=(snapshot,proposal,task)=>nextDesktopDecision({task,intent:{query:'Zorvex Editor',goal:task,task},evidence:[{toolName:'desktop_open',success:true,data:snapshot}],complete:async()=>proposal});
test('the planner turns type/key proposals into the right desktop call and enforces the rules',async()=>{
  const task='in Zorvex Editor type hello world then search';
  const snapshot=await snapshotFor('modify');
  let d=await decide(snapshot,{kind:'type',text:'hello world'},task);assert.deepEqual(d.call,{tool:'desktop',action:'input',params:{snapshotId:snapshot.snapshotId,kind:'type',text:'hello world'}});
  d=await decide(snapshot,{kind:'type',text:'text the user never wrote'},task);assert.equal(d.call,undefined);assert.match(d.message,/copied from your request/);
  d=await decide(snapshot,{kind:'key',keys:'ctrl+f'},task);assert.equal(d.call.action,'input');assert.equal(d.call.params.keys,'ctrl+f');
  d=await decide(snapshot,{kind:'key',keys:'Ctrl+S'},task);assert.equal(d.call.action,'inputConfirmed');assert.equal(d.call.params.keys,'ctrl+s');
  d=await decide(snapshot,{kind:'key',keys:'alt+f4'},task);assert.equal(d.call,undefined);assert.match(d.message,/blocked/);
  d=await decide(snapshot,{kind:'key',keys:'nonsense'},task);assert.equal(d.call,undefined);
  const noFocus=await snapshotFor('modify',false);d=await decide(noFocus,{kind:'type',text:'hello world'},task);assert.equal(d.call,undefined);assert.match(d.message,/Focus a text field/);
  const readOnly=await snapshotFor('read');d=await decide(readOnly,{kind:'key',keys:'down'},task);assert.equal(d.status,'APP_PERMISSION_DENIED');assert.match(d.message,/read/);
});

test('free-form requests naming an installed app enter the desktop loop; chat about apps does not',()=>{
  const apps=[{name:'VLC media player',aliases:['vlc']},{name:'Notepad++',aliases:['notepad++']},{name:'Blender 5.2',aliases:['blender']},{name:'Spotify',aliases:[]},{name:'Microsoft Word',aliases:['word']}];
  setInstalledApps(apps);
  for(const [text,app] of [['in Notepad++ replace hello with hi','Notepad++'],['vlc la movie play pannu','VLC media player'],['use blender to add a cube','Blender 5.2'],['open vlc play the last video','VLC media player'],['can you please play music using spotify','Spotify'],['set the volume to 50 in vlc','VLC media player']]){
    const r=computerTask(text);assert.equal(r?.genericDesktop?.query,app,text);assert.ok(r.requiresUI);
  }
  for(const text of ['write an essay about blender','what is VLC','how to use blender for animation','install vlc','tell me about spotify','I like the word love in my poem','my favourite word is hello','explain how vlc works'])assert.equal(computerTask(text)?.genericDesktop,undefined,text);
  assert.deepEqual(computerTask('open vlc')?.call,{tool:'app',action:'openApp',params:{query:'vlc'}});
  assert.notEqual(computerTask('open notepad++ and type hello world')?.call?.tool,'uiAutomation','Notepad++ is not Windows Notepad');
  assert.equal(computerTask('open notepad and type hello world')?.call?.tool,'uiAutomation');
  // Two different apps with the same alias are ambiguous, never guessed.
  assert.equal(freeformDesktopTask('play it in studio',[{name:'Android Studio',names:['studio']},{name:'Visual Studio',names:['studio']}]),null);
  setInstalledApps([]);assert.equal(computerTask('use blender to add a cube')?.genericDesktop,undefined,'no catalog, no free-form admission');
});
test('the installed-app catalog from the client is sanitised',()=>{
  assert.deepEqual(sanitizeInstalledApps('nope'),[]);
  const clean=sanitizeInstalledApps([{name:'Ok App',aliases:['okapp','x','y'.repeat(90)]},{name:''},{name:'z'.repeat(101)},null,5,{name:'Ab',aliases:[]}]);
  assert.deepEqual(clean,[{name:'Ok App',names:['ok app','okapp']}]);
  assert.equal(sanitizeInstalledApps(Array.from({length:500},(_,i)=>({name:`App number ${i}`}))).length,200);
});
test('a typing step that was already verified is never repeated; the outcome is re-checked instead',async()=>{
  const {createHash}=await import('node:crypto');
  const snapshot=await snapshotFor('modify');const task='in Zorvex Editor type hello world';
  const done={toolName:'desktop_input',success:true,data:{status:'UI_ACTION_VERIFIED',operation:'type',inputDigest:createHash('sha256').update('hello world').digest('hex'),snapshot}};
  const again=await nextDesktopDecision({task,intent:{query:'Zorvex Editor',goal:task,task},evidence:[{toolName:'desktop_open',success:true,data:snapshot},done],complete:async()=>({kind:'type',text:'hello world'})});
  assert.equal(again.call.action,'verify');assert.deepEqual(again.call.params.evidenceIds,[snapshot.input.focusedTextField.elementId]);
  // Different text is a new request and is allowed.
  const other=await nextDesktopDecision({task:'in Zorvex Editor type hello world and then more',intent:{query:'Zorvex Editor',goal:'x',task:'x'},evidence:[{toolName:'desktop_open',success:true,data:snapshot},done],complete:async()=>({kind:'type',text:'more'})});
  assert.equal(other.call.action,'input');assert.equal(other.call.params.text,'more');
});
