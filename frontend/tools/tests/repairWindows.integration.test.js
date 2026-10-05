import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {createProtectedRunner} from '../repair/ProtectedRunner.js';
import {ToolEngineRouter} from '../ToolEngineRouter.js';
import {ExecutionLedger} from '../ExecutionLedger.js';
import {wireRepairLedger} from '../repair/wireRepairLedger.js';
import {runWindowsRepair} from '../../../backend/src/orchestrator/WindowsRepairCapability.js';
import {resumeOrchestrator} from '../../../backend/src/orchestrator/AgentOrchestrator.js';
import {createCheckpointStore} from '../../../backend/src/orchestrator/CheckpointStore.js';
import {toolRequestForStep} from '../../../backend/src/orchestrator/AgentExecutor.js';
/** Opt-in only inside a disposable, operator-prepared Windows VM and protected package. */
test('isolated Windows VM starts only a pre-stopped fixture and verifies service condition',{
 skip:process.platform!=='win32'||process.env.CHANAKYA_DISPOSABLE_SPOOLER_VM!=='approved-empty-queue',
},async()=>{
 const model=execFileSync(path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-Command','(Get-CimInstance Win32_ComputerSystem).Model'],{windowsHide:true,timeout:10000,encoding:'utf8'});
 assert.match(model,/Virtual Machine|VMware|VirtualBox|KVM/i,'Refuse mutation outside an isolated VM');
 const jobs=execFileSync(path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-Command',"@(Get-CimInstance Win32_PrintJob -ErrorAction Stop).Count"],{windowsHide:true,timeout:10000,encoding:'utf8'});
 assert.equal(jobs.trim(),'0','Integration fixture must contain no print jobs');
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'spooler-vm-'));
 const router=new ToolEngineRouter({confirmationDirectory:path.join(directory,'approval'),repairOptions:{directory:path.join(directory,'audit'),runner:createProtectedRunner({packaged:true})}});
 const ledger=wireRepairLedger(new ExecutionLedger({directory:path.join(directory,'ledger'),timeoutMs:60000,dispatch:r=>router.dispatch(r)}),router);
 const dependencies={save:createCheckpointStore(path.join(directory,'checkpoints')),recordRepair:()=>{},inspectToolCall:key=>ledger.status('backend:operator',key),executeStep:(step,options)=>ledger.execute('backend:operator',{...toolRequestForStep(step),admission:options.admission},null,{backend:true,humanApproved:!!step.confirmationId})};
 const waiting=await runWindowsRepair({goal:'Start the print spooler',userId:'operator',dependencies});
 assert.equal(waiting.phase,'waiting_confirmation','Operator must prepare a stopped, automatic fixture with actual start rights');
 assert.equal(Object.keys(router.services.get('windowsRepair').store.state.operations).length,0);
 const done=await resumeOrchestrator({sessionId:waiting.sessionId,userId:'operator',expectedRevision:waiting.revision,confirmationId:waiting.confirmationId,dependencies});
 assert.equal(done.phase,'done');assert.match(done.summary,/printing has not been verified/);
 assert.equal(Object.keys(router.services.get('windowsRepair').store.state.operations).length,1);
 // Deliberately no automated Stop/rollback. Dispose of the VM snapshot externally.
});
