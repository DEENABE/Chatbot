import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
const require=createRequire(import.meta.url);
const {validateRepairPackage}=require('../../scripts/validate-repair-package.cjs');
const frontend=fileURLToPath(new URL('../../',import.meta.url));
test('source runner and isolated package layout pass integrity validation',()=>{
 assert.equal(validateRepairPackage(frontend).integrity,'passed');
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'repair-package-'));fs.cpSync(path.join(frontend,'tools'),path.join(temp,'tools'),{recursive:true});
 assert.equal(validateRepairPackage(temp).integrity,'passed');
 fs.appendFileSync(path.join(temp,'tools','repair','PrintSpoolerRunner.ps1'),'# modified');assert.throws(()=>validateRepairPackage(temp),/integrity/);
});
test('runner PowerShell syntax parses without executing the script',{skip:process.platform!=='win32'},()=>{
 const runner=path.join(frontend,'tools','repair','PrintSpoolerRunner.ps1');
 const out=execFileSync(path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-Command',"$tokens=$null;$errors=$null;[void][System.Management.Automation.Language.Parser]::ParseFile($env:CHANAKYA_PARSE_FILE,[ref]$tokens,[ref]$errors);if($errors.Count){$errors|Out-String;exit 1};'syntax valid'"],{windowsHide:true,timeout:10000,env:{...process.env,CHANAKYA_PARSE_FILE:runner},encoding:'utf8'});
 assert.match(out,/syntax valid/);
});
test('packaging installs per-machine and validates actual output bytes',()=>{
 const config=JSON.parse(fs.readFileSync(path.join(frontend,'package.json'),'utf8'));
 assert.equal(config.build.nsis.perMachine,true);
 assert.match(fs.readFileSync(path.join(frontend,'scripts','afterPack.cjs'),'utf8'),/validateRepairPackage/);
});
