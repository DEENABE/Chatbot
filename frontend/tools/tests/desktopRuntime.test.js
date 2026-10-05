import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ToolEngineRouter} from '../ToolEngineRouter.js';
import {AppRegistryService} from '../apps/AppRegistryService.js';
import {desktopCapabilityDiagnostics} from '../DesktopCapabilityDiagnostics.js';
import {desktopPaths,DESKTOP_HELPERS,helperScriptPath} from '../DesktopRuntime.js';
import {executionContext} from '../ExecutionContext.js';
import {mapToolsToOllamaSchema} from '../../src/services/toolSchemas.js';
import {computerTask} from '../../../backend/src/orchestrator/ComputerTaskPolicy.js';
const registry=()=>new AppRegistryService({discovery:{discover:async()=>({apps:[],errors:[]})}});
test('production constructor with appOptions.directory registers canonical desktop tools before readiness',async()=>{
 const appRegistry=registry();const router=new ToolEngineRouter({appOptions:{directory:path.join(os.tmpdir(),'chanakya-constructor-only'),registry:appRegistry}});
 try{await router.ready;const map=router.getTools({model:true});const names=mapToolsToOllamaSchema(map).map(t=>t.function.name);
 assert.ok(router.registry.get('app.openApp'));assert.ok(router.registry.get('desktop.open'));assert.ok(router.registry.get('uiAutomation.findWindow'));
 if(process.platform==='win32')assert.ok(names.includes('app_openApp'));
 const selected=computerTask('open calculator').call;assert.equal(selected.tool,'app');assert.equal(selected.action,'openApp');
 assert.equal(desktopPaths().genericUIScriptPath,path.resolve('frontend/tools/apps/GenericUI.ps1'));
 }finally{appRegistry.close();}
});
test('packaged resource layout is external to asar; masked helper safely removes capability',async()=>{
 const resourcesPath=fs.mkdtempSync(path.join(os.tmpdir(),'chanakya-desktop-package-'));const root=path.join(resourcesPath,'desktop-control');fs.mkdirSync(root);
 for(const name of DESKTOP_HELPERS)fs.writeFileSync(path.join(root,name),'# fixture');
 try{const runtime={isPackaged:true,resourcesPath,platform:'win32'},router=new ToolEngineRouter({desktopRuntime:runtime});
 const positive=desktopCapabilityDiagnostics(router,{runtime,exists:()=>true});assert.equal(positive.desktopControl.ready,true);assert.equal(positive.genericUIScriptPath,path.join(root,'GenericUI.ps1'));assert.doesNotMatch(positive.genericUIScriptPath,/app\.asar/);
 fs.renameSync(path.join(root,'GenericUI.ps1'),path.join(root,'GenericUI.masked'));
 const map=router.getTools({model:true});assert.equal(map.app.length,0);assert.equal(router.desktopDiagnostics.desktopControl.ready,false);assert.ok(router.desktopDiagnostics.desktopControl.reasons.includes('GENERIC_UI_SCRIPT_MISSING'));
 let launched=false;router.services.get('app').openApp=async()=>{launched=true;};
 const blocked=await executionContext.run({authenticated:true,scope:'backend:fixture',taskId:'fixture',origin:'model'},()=>router.dispatch({tool:'app',action:'openApp',params:{query:'Calculator'}}));
 assert.equal(blocked.success,false);assert.equal(blocked.error.code,'CAPABILITY_NOT_AVAILABLE');assert.equal(launched,false);
 }finally{fs.rmSync(resourcesPath,{recursive:true,force:true});}
});
test('diagnostics identify service/powershell mismatch and schema conversion rejects error envelopes',()=>{
 const router=new ToolEngineRouter();router.services.delete('uiAutomation');
 const d=desktopCapabilityDiagnostics(router,{exists:p=>!p.endsWith('powershell.exe')});
 assert.ok(d.desktopControl.reasons.includes('UI_AUTOMATION_SERVICE_NOT_REGISTERED'));assert.ok(d.desktopControl.reasons.includes('POWERSHELL_UNAVAILABLE'));
 assert.throws(()=>mapToolsToOllamaSchema({success:false,error:{code:'FAILED'}}),e=>e.code==='FAILED');
 assert.throws(()=>helperScriptPath('../untrusted.ps1'),e=>e.code==='DESKTOP_HELPER_NOT_ALLOWED');
});
test('DEV open calculator resolves, passes availability and verifies a real window',{skip:process.env.CHANAKYA_DESKTOP_RUNTIME_LIVE!=='1',timeout:90000},async()=>{
 const router=new ToolEngineRouter();assert.equal(router.desktopDiagnostics.desktopControl.ready,true);
 await executionContext.run({authenticated:true,scope:'backend:desktop-runtime',taskId:'desktop-runtime',origin:'model'},async()=>{
 const r=await router.dispatch({tool:'app',action:'openApp',params:{query:'calculator'}});assert.equal(r.success,true,JSON.stringify(r));assert.equal(r.permission.decision,'ALLOW');
 const window=await router.dispatch({tool:'uiAutomation',action:'findWindow',params:{query:'Calculator'}});assert.equal(window.success,true,JSON.stringify(window));assert.equal(window.data.verification.status,'verified');assert.ok(window.data.processId>0);
 });
});
