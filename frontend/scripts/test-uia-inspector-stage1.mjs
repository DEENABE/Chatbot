import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {UIInspectionService} from '../tools/inspection/UIInspectionService.js';
const registry=JSON.parse(fs.readFileSync(process.argv[2]||'outputs/resolver-benchmark.registry.json','utf8'));
const powershell=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
const processes=JSON.parse(execFileSync(powershell,['-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('./uia-stage1-open-processes.ps1',import.meta.url))],{encoding:'utf8',windowsHide:true,timeout:15000}));
const candidates=registry.apps.filter(a=>a.available&&a.executablePath&&!/uninstall|setup|install|update|repair|registry|command|powershell|terminal|security|password/i.test(a.name)&&!a.source?.startsWith('windows_')).sort((a,b)=>a.name.localeCompare(b.name));
let target;for(const app of candidates){const existing=processes.find(p=>p.executablePath.toLowerCase()===app.executablePath.toLowerCase());if(existing){target={...existing,applicationName:app.name};break;}}
if(!target)throw Error('NOT RUN: no already-open discovered executable has a main window');
const inspector=new UIInspectionService(),rows=[];
const summarize=result=>{const counts={};const visit=node=>{if(!node)return;counts[node.controlType]=(counts[node.controlType]||0)+1;for(const child of node.children)visit(child);};for(const w of result.windows)visit(w.root);return {success:result.success,error:result.error,rawElementCount:result.rawElementCount,skippedElementCount:result.skippedElementCount,windows:result.windows.length,truncated:result.truncated,regionsInaccessible:result.regionsInaccessible,elapsedMs:result.elapsedMs,helperProcessId:result.helperProcessId,dpiAwareness:result.dpiAwareness,types:counts};};
const inspect=async(label,options={})=>{const result=await inspector.inspect(target,options);const row={label,application:target.applicationName,...summarize(result)};rows.push(row);console.log(JSON.stringify(row));if(process.argv.includes('--debug'))fs.writeFileSync(`outputs/uia-stage1-${label}.raw.json`,JSON.stringify(result,null,2));return result;};
try{
 const cold=await inspect('cold');assert.equal(cold.success,true,JSON.stringify(summarize(cold)));assert.ok(cold.rawElementCount>1);
 for(let i=1;i<=3;i++){const warm=await inspect('warm-'+i);assert.equal(warm.success,true);assert.equal(warm.helperProcessId,cold.helperProcessId);}
 const limited=await inspect('element-limit',{maxElements:3});assert.ok(limited.rawElementCount<=3);assert.equal(limited.truncated,true);
 const depth=await inspect('depth-limit',{maxDepth:0});assert.equal(depth.truncated,true);
 const invalid=await inspector.inspect({...target,windowHandle:'9007199254740993'});assert.equal(invalid.error,'TARGET_WINDOW_NOT_FOUND');console.log(JSON.stringify({label:'64-bit-invalid-handle',error:invalid.error}));
 const cross=await inspector.inspect({...target,processId:process.pid,executablePath:process.execPath});assert.equal(cross.error,'UIA_ACCESS_DENIED');console.log(JSON.stringify({label:'cross-process-refusal',error:cross.error}));
 const child=inspector.provider.child;const exited=new Promise(resolve=>child.once('exit',resolve));child.kill();await exited;const restarted=await inspect('crash-restart');assert.equal(restarted.success,true);assert.notEqual(restarted.helperProcessId,cold.helperProcessId);
 const short=await inspect('timeout-budget',{timeoutMs:100});assert.ok(short.elapsedMs<=1000);const recovered=await inspect('after-timeout');assert.equal(recovered.success,true);
 console.log(JSON.stringify({stage:1,passed:true,application:target.applicationName,helperStarts:inspector.provider.starts,warmElapsedMs:rows.filter(r=>r.label.startsWith('warm')).map(r=>r.elapsedMs),actionsPerformed:0,applicationsLaunched:0}));
}finally{fs.writeFileSync('outputs/uia-stage1-results.json',JSON.stringify(rows,null,2));await inspector.close();}
