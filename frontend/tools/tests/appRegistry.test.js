import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AppResolverService,aliasesFor,normalize } from '../apps/AppResolverService.js';
import { AppRegistryService } from '../apps/AppRegistryService.js';
import { AppService } from '../services/AppService.js';
import { validateTarget } from '../apps/AppTargetPolicy.js';
const app=(name,exe=name)=>({id:name,name,normalizedName:normalize(name),source:'start_menu',launchType:'executable',executablePath:`C:\\Apps\\${exe}.exe`,launchArgs:[],available:true,aliases:aliasesFor({name,executablePath:`C:\\Apps\\${exe}.exe`}),lastSeen:new Date().toISOString()});
const resolver=new AppResolverService();
test('dynamic aliases, token matching, Unicode, and safe ambiguity',()=>{
  const apps=[app('Visual Studio Code','Code'),app('Visual Studio'),app('Android Studio'),app('Google Chrome','chrome'),app('VLC media player','vlc'),app('PowerPoint','POWERPNT'),app('Calculator'),app('Word','WINWORD')];
  for(const [query,name] of [['VS Code','Visual Studio Code'],['chrome','Google Chrome'],['VLC','VLC media player'],['power point','PowerPoint'],['Word','Word'],['Calculator','Calculator']])assert.equal(resolver.resolve(query,apps).app.name,name);
  assert.equal(resolver.resolve('Studio',apps).status,'AMBIGUOUS_APP');
  assert.equal(resolver.resolve('ZyzxyUnrelated',apps).status,'APP_NOT_FOUND');
  assert.equal(resolver.resolve('Chrom',apps).app.name,'Google Chrome');
  assert.equal(resolver.resolve('calc.exe && some-command',apps).status,'APP_NOT_FOUND');
  assert.equal(resolver.resolve('editor',apps,{editor:'Visual Studio Code'}).app.name,'Visual Studio Code');
});
test('target boundary rejects unsafe paths, interpreters, arguments, source and missing files',()=>{
  const base=app('Good');validateTarget(base,()=>true);
  for(const executablePath of ['relative.exe','\\\\server\\app.exe','C:\\Temp\\app.exe','C:\\Apps\\..\\x.exe','C:\\Apps\\x.cmd','C:\\Apps\\CMD.EXE','C:\\Apps\\x.exe:script','C:\\Apps\\node.exe'])assert.throws(()=>validateTarget({...base,executablePath},()=>true));
  assert.throws(()=>validateTarget({...base,source:'llm'},()=>true));
  assert.throws(()=>validateTarget({...base,launchArgs:['-Command','bad']},()=>true));
  assert.throws(()=>validateTarget(base,()=>false),/MISSING/);
  assert.throws(()=>validateTarget({...base,launchType:'app_user_model_id',appUserModelId:'bad; command'},()=>true));
});
test('cache persistence, coalesced refresh, separate user aliases and cache distrust',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'chanakya-app-tests-'));
  let calls=0;const discovery={discover:async()=>{calls++;return {apps:[app('New App')],errors:[]};}};
  try {
    const r=new AppRegistryService({directory,discovery});await Promise.all([r.refresh(),r.refresh(),r.refresh()]);assert.equal(calls,1);
    await r.setUserAlias('editor','New App');const loaded=new AppRegistryService({directory,discovery});await loaded.ready;
    assert.equal(loaded.apps.length,1);assert.equal(loaded.aliases.editor,'New App');assert.equal(loaded.trusted,false);
    await loaded.ensureTrusted();assert.equal(calls,2);await loaded.ensureTrusted();assert.equal(calls,2);
  } finally {await fs.rm(directory,{recursive:true,force:true});}
});
test('missing result rescans once and never launches or installs',async()=>{
  let scans=0,launches=0;const registry=new AppRegistryService({discovery:{discover:async()=>{scans++;return {apps:[],errors:[]};}}});
  await registry.refresh();const service=new AppService(null,{registry,processService:{launchApp:()=>{launches++;}}});
  const r=await service.execute('openApp',{query:'Photoshop'});assert.equal(r.success,false);assert.equal(r.data.status,'APP_NOT_INSTALLED');assert.equal(r.data.suggestion.displayName,'Photoshop');assert.equal(scans,2);assert.equal(launches,0);
});
test('new app becomes resolvable after a miss; ambiguity never launches',async()=>{
  let scans=0;const registry=new AppRegistryService({discovery:{discover:async()=>({apps:++scans===1?[]:[app('VLC media player','vlc')],errors:[]})}});
  await registry.refresh();const service=new AppService(null,{registry});assert.equal((await service.resolve('VLC')).app.name,'VLC media player');assert.equal(scans,2);
  registry.apps=[app('Visual Studio'),app('Android Studio')];registry.discovery={discover:async()=>({apps:registry.apps,errors:[]})};assert.equal((await service.openApp({query:'Studio'})).status,'AMBIGUOUS_APP');
});
test('stale missing executable is invalidated and rescanned',async()=>{
  const stale=app('Gone');stale.executablePath='C:\\ChanakyaNonexistentAppPath\\Gone.exe';
  const registry=new AppRegistryService({discovery:{discover:async()=>({apps:[],errors:[]})}});await registry.ready;registry.apps=[stale];registry.trusted=true;registry.scannedAt=Date.now();
  const service=new AppService(null,{registry});assert.equal((await service.openApp({query:'Gone'})).status,'APP_NOT_INSTALLED');assert.equal(stale.available,false);
});
test('partial discovery never asserts not installed',async()=>{
  const registry=new AppRegistryService({discovery:{discover:async()=>({apps:[],errors:['msix']})}});
  assert.equal((await new AppService(null,{registry}).resolve('Photoshop')).status,'APP_NOT_FOUND');
});
test('known blocked applications are not reported as missing',async()=>{
  const registry=new AppRegistryService({discovery:{discover:async()=>({apps:[{...app('Python'),available:false,blockedReason:'APP_UNSAFE_TARGET'}],errors:[]})}});
  assert.equal((await new AppService(null,{registry}).resolve('Python')).status,'APP_UNSAFE_TARGET');
});
