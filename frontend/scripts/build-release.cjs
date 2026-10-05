/** Offline clean release: never restores user databases into an installer. */
const fs=require('node:fs');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const frontend=path.resolve(__dirname,'..');
const root=path.dirname(frontend);
const config=require('../package.json');
const electronPackage=require(path.join(root,'node_modules','electron','package.json'));
if(config.build.electronVersion!==electronPackage.version)throw new Error('Installed Electron differs from the pinned build version');
const electron=path.join(root,'node_modules','electron','dist','electron.exe');
const env={...process.env,CHANAKYA_CLEAN_PACKAGE:'1',CHANAKYA_REUSE_RUNTIME:'1'};
const run=(file,args,extra={})=>execFileSync(file,args,{cwd:frontend,env,stdio:'inherit',windowsHide:true,...extra});

// Pre-clean: wipe any previous release-security output and leftover stash so
// a running app's locked db.sqlite (or any preserved storage from a prior
// non-clean build) can never contaminate this clean package.
const outDir=path.join(frontend,'release-security');
const stashDir=path.join(frontend,'.storage-preserve-tmp');
for(const dir of [outDir,stashDir]){
  if(fs.existsSync(dir)){
    try {
      fs.rmSync(dir,{recursive:true,force:true});
      console.log('[build-release] pre-clean removed: '+dir);
    } catch(error) {
      // A scanner or shell can keep a handle on the (already emptied) directory itself. That is harmless for a clean
      // package as long as no file survives; if any file remains the build must not continue.
      const files=[];const walk=d=>{for(const entry of fs.readdirSync(d,{withFileTypes:true})){const full=path.join(d,entry.name);if(entry.isDirectory())walk(full);else files.push(full);}};
      try{walk(dir);}catch{files.push(dir);}
      if(!['EPERM','EBUSY'].includes(error.code)||files.length)throw error;
      console.log('[build-release] pre-clean: '+dir+' is empty but its folder is held open by another process; continuing');
    }
  }
}

run(process.execPath,[path.join(__dirname,'prepare-backend.cjs')]);
const runtime=path.join(frontend,'backend-runtime','package.json');
run(electron,['-e',`const r=require('node:module').createRequire(${JSON.stringify(runtime)});const Database=r('better-sqlite3');const db=new Database(':memory:');db.close();r('@lancedb/lancedb');console.log('Packaged backend native dependencies passed');`],{env:{...env,ELECTRON_RUN_AS_NODE:'1'}});
run(process.execPath,[path.join(root,'node_modules','vite','bin','vite.js'),'build']);
run(process.execPath,[path.join(root,'node_modules','electron-builder','cli.js'),'--win','--config.directories.output=release-security','--config.npmRebuild=false']);
const output=path.join(frontend,'release-security','win-unpacked');
require('./validate-repair-package.cjs').validateRepairPackage(path.join(output,'resources','app'));
require('./validate-security-package.cjs').validateSecurityPackage(output,frontend);
console.log('Clean Windows security release validated at '+path.dirname(output));
