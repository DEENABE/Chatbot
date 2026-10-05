const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
/** Validate the actual packaged bytes, not just the source-tree manifest. */
function validateRepairPackage(appRoot) {
 const root=path.join(appRoot,'tools','repair');
 const bytes=fs.readFileSync(path.join(root,'PrintSpoolerRunner.ps1'));
 const manifest=fs.readFileSync(path.join(root,'runnerDigest.js'),'utf8');
 const expected=/RUNNER_SHA256\s*=\s*'([0-9a-f]{64})'/.exec(manifest)?.[1];
 if(!expected || crypto.createHash('sha256').update(bytes).digest('hex')!==expected)throw new Error('Packaged repair runner integrity mismatch');
 const source=bytes.toString('utf8');
 if((source.match(/\$service\.Start\(\)/g)||[]).length!==1 || /Restart-Service|Stop-Service|Remove-PrintJob|Invoke-Expression|ExecutionPolicy\s+Bypass/i.test(source))throw new Error('Repair runner exceeds the single-start boundary');
 for(const name of ['ProtectedRunner.js','contract.js','RepairStore.js','wireRepairLedger.js'])if(!fs.existsSync(path.join(root,name)))throw new Error('Missing repair runtime '+name);
 for(const name of ['services/WindowsRepairService.js','ExecutionContext.js','ExecutionLedger.js','ConfirmationGate.js','ToolEngineRouter.js'])if(!fs.existsSync(path.join(appRoot,'tools',name)))throw new Error('Missing repair broker '+name);
 return {capability:'windows.printSpooler.start.v1',sha256:expected,integrity:'passed',protectedInstall:'runtime ACL check required'};
}
module.exports={validateRepairPackage};
if(require.main===module)console.log(JSON.stringify(validateRepairPackage(path.resolve(process.argv[2]||path.join(__dirname,'..')))));
