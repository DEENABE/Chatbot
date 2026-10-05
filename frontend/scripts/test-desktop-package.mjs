import {_electron} from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
const launchRequest=process.argv.includes('--resolver')?'open calculatro':'open calculator';
const output=path.resolve(process.argv[2]||'frontend/release-desktop/win-unpacked');
const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'chanakya-packaged-desktop-'));
let application;
const helper=path.join(output,'resources','desktop-control','GenericUI.ps1'),masked=helper+'.test-mask';
try {
 application=await _electron.launch({executablePath:path.join(output,'Chanakya AI.exe'),cwd:output,args:[`--user-data-dir=${path.join(fixture,'profile')}`],env:{...process.env,APP_DATA_PATH:path.join(fixture,'data'),CHANAKYA_DEBUG_DESKTOP:'1'},timeout:90000});
 const info=await application.evaluate(({app})=>({isPackaged:app.isPackaged,platform:process.platform,resourcesPath:process.resourcesPath}));assert.equal(info.isPackaged,true);console.log(JSON.stringify({stage:'packaged-start',...info}));
 const page=await application.firstWindow();await page.waitForLoadState('domcontentloaded');
 const chatBodies=[];page.on('request',r=>{if(r.url().endsWith('/api/chat')&&r.method()==='POST'){try{chatBodies.push(r.postDataJSON());}catch{}}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.locator('div.cursor-grab').click({timeout:30000});
 await page.getByRole('button',{name:'Register',exact:true}).click();
 await page.getByPlaceholder('Username',{exact:true}).fill('desktop_'+randomUUID().slice(0,8));
 await page.getByPlaceholder('Display Name',{exact:true}).fill('Desktop test');
 await page.getByPlaceholder('Password',{exact:true}).fill('Fixture-'+randomUUID());
 await page.getByRole('button',{name:'Create Account',exact:true}).click();
 const input=page.getByPlaceholder('Message Chanakya AI...', {exact:true});await input.waitFor({timeout:30000});
 const tools=await page.evaluate(()=>window.toolEngine.getTools());assert.ok(tools.app.some(a=>a.action==='openApp'));
 const diagnostic=await page.evaluate(()=>window.toolEngine.getDesktopStatus());assert.equal(diagnostic.desktopControl.ready,true);console.log(JSON.stringify({stage:'renderer-ready',registeredTools:Object.keys(tools),...diagnostic}));
 if(!process.argv.includes('--phase2-only')){
 const request=page.waitForRequest(r=>r.url().endsWith('/api/chat')&&r.method()==='POST');
 await input.fill(launchRequest);await input.press('Enter');
 const sent=await request;const payload=sent.postDataJSON();assert.equal(payload.message,launchRequest);assert.ok(payload.tools.some(t=>t.function.name==='app_openApp'));
 console.log(JSON.stringify({stage:'chat-request',requestedTool:'app_openApp',advertised:true}));
 await page.getByText('Calculator opened successfully.',{exact:false}).first().waitFor({timeout:90000});
 assert.equal(await page.getByText('required desktop tool is unavailable',{exact:false}).count(),0);
 const observations=chatBodies.flatMap(b=>b.history||[]).filter(m=>m.role==='tool'&&m.tool_name==='app_openApp').map(m=>JSON.parse(m.content));
 const launch=observations.find(o=>o.success&&o.data?.status==='APP_OPENED');assert.ok(launch,'Missing launch evidence');
 assert.equal(launch.data.readiness.status,'ready');assert.ok(Number.isInteger(launch.data.processId)&&launch.data.processId>0);assert.ok(launch.data.windowId);
 const present=await application.evaluate(async({desktopCapturer},windowId)=>{const sources=await desktopCapturer.getSources({types:['window'],thumbnailSize:{width:0,height:0},fetchWindowIcons:false});return sources.some(s=>s.id.split(':')[1]===String(windowId));},launch.data.windowId);
 assert.equal(present,true,'The specific verified launch window must still exist');
 console.log(JSON.stringify({stage:'acceptance',success:true,request:launchRequest,windowVerified:true,processId:launch.data.processId,permission:launch.permission?.decision,pageErrors:errors.length}));
 }
 if(process.argv.includes('--phase2')){
  const taskId='phase2-'+randomUUID();let step=0;
  const execute=async(action,params)=>{const callId=taskId+':step:'+ ++step;return page.evaluate(({action,params,callId,taskId})=>window.toolEngine.execute('desktop',action,params,callId,{requestId:taskId+':request:'+callId,idempotencyKey:callId}),{action,params,callId,taskId});};
  const query=process.env.PHASE2_TEST_APP||'Steam';
  const opened=await execute('open',{query});assert.equal(opened.success,true,JSON.stringify({error:opened.error}));
  const snapshot=opened.data;
  const element=snapshot.elements.find(e=>['Edit','ComboBox','ListItem','TreeItem','TabItem','Document'].includes(e.role)&&e.actions.some(a=>a.operation==='focus'&&a.permission==='SAFE_WRITE'));
  assert.ok(element,'No safe focus primitive exposed');
  const acted=await execute('act',{snapshotId:snapshot.snapshotId,elementId:element.elementId,operation:'focus'});
  assert.equal(acted.data?.success,true,JSON.stringify({error:acted.error,status:acted.data?.status}));
  const after=acted.data.snapshot,focused=after.elements.find(e=>e.focused&&e.label===element.label&&e.role===element.role);assert.ok(focused);
  const checked=await execute('verify',{snapshotId:after.snapshotId,goal:'Focus the observed control',evidenceIds:[focused.elementId]});assert.equal(checked.success,true,JSON.stringify({error:checked.error}));
  console.log(JSON.stringify({stage:'phase2-packaged',application:query,success:true,inspection:true,action:'focus',goalVerified:true,helper:'DesktopAccessibility.cs'}));
 }
 if(process.argv.includes('--negative')){
  fs.renameSync(helper,masked);
  const unavailable=await page.evaluate(()=>window.toolEngine.getDesktopStatus());assert.equal(unavailable.desktopControl.ready,false);assert.ok(unavailable.desktopControl.reasons.includes('GENERIC_UI_SCRIPT_MISSING'));
  const absent=await page.evaluate(()=>window.toolEngine.getTools());assert.equal(absent.app.length,0);
  await input.fill(launchRequest);await input.press('Enter');
  await page.getByText('Execution blocked: the required desktop tool is unavailable in this running app. No computer action was performed.',{exact:false}).first().waitFor({timeout:30000});
  console.log(JSON.stringify({stage:'masked-helper',success:true,ready:false,reason:'GENERIC_UI_SCRIPT_MISSING',safeBlockPreserved:true}));
 }
} catch(error){console.error(JSON.stringify({success:false,message:error.message}));process.exitCode=1;}
finally{if(fs.existsSync(masked))fs.renameSync(masked,helper);if(application)await application.close();}

