import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {BrowserAutomationService} from '../services/BrowserAutomationService.js';
import {AppService} from '../services/AppService.js';
import {executionContext} from '../ExecutionContext.js';
test('real Chromium DOM navigation, reuse, redaction, tabs and stale element rejection',{skip:process.env.CHANAKYA_BROWSER_INTEGRATION!=='1',timeout:90000},async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'chanakya-browser-test-'));
 let posts=0;const server=http.createServer((req,res)=>{if(req.method==='POST')posts++;res.setHeader('Content-Type','text/html');res.end('<title>Browser fixture</title><h1>Safe page</h1><a href="/second">Next page</a><input aria-label="Search"><input type="password" value="SECRET_SENTINEL"><input aria-label="OTP" value="OTP_SENTINEL"><button type="submit">Send</button>');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=new BrowserAutomationService(null,new AppService(null,{directory:path.join(directory,'registry')}),{directory:path.join(directory,'profile'),headless:true});
 try{await executionContext.run({scope:'browser-fixture',authenticated:true,taskId:'fixture'},async()=>{
 const url=`http://127.0.0.1:${server.address().port}`;const run=async(action,params={})=>(await browser.execute(action,params)).data;
 const first=await run('navigate',{browser:'crome',url});assert.equal(first.status,'BROWSER_ACTION_COMPLETED');
 const context=browser.sessions.get('browser-fixture').context;
 await run('attachBrowser');assert.equal(browser.sessions.get('browser-fixture').context,context);
 const observed=await run('getVisibleElements');assert.doesNotMatch(JSON.stringify(observed),/SECRET_SENTINEL|OTP_SENTINEL|password/i);
 const input=observed.elements.find(e=>e.role==='textbox');await run('type',{elementId:input.elementId,text:'Safe query'});
 await assert.rejects(()=>run('click',{elementId:observed.elements.find(e=>e.role==='link').elementId}),e=>e.code==='STALE_UI_ELEMENT');
 const fresh=await run('getVisibleElements');await run('click',{elementId:fresh.elements.find(e=>e.role==='link').elementId});
 await run('back');await run('forward');await run('scroll');
 const tabs=await run('newTab',{url});assert.equal(tabs.tabs.length,2);await run('switchTab',{tabId:tabs.tabs.find(t=>!t.active).tabId});await run('closeTab');
 const page=browser.sessions.get('browser-fixture').page;await page.evaluate(()=>fetch('/effect',{method:'POST'}).catch(()=>{}));assert.equal(posts,0);
 });}finally{await browser.close();await new Promise(r=>server.close(r));await fs.rm(directory,{recursive:true,force:true,maxRetries:8,retryDelay:200});}
});
