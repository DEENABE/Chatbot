import test from 'node:test';
import assert from 'node:assert/strict';
import {AppResolverService,aliasesFor,normalize} from '../apps/AppResolverService.js';
import {AppRegistryService} from '../apps/AppRegistryService.js';
import {AppService} from '../services/AppService.js';
import {appLaunchTask} from '../../../backend/src/orchestrator/AppLaunchTask.js';
import {trustedSystemCapability} from '../apps/WindowsSystemCapabilityRegistry.js';
import path from 'node:path';
const record=(name,exe=name,publisher='')=>({id:name,name,publisher,available:true,source:'start_menu',launchType:'executable',executablePath:`C:\\Programs\\${exe}.exe`,launchArgs:[]});
const resolve=new AppResolverService();
test('one algorithm handles sample typos and preserves distinct plus-suffixed products',()=>{
 const apps=[record('Blender 5.2','blender'),record('VLC media player','vlc'),record('Visual Studio Code','Code'),record('Notepad','notepad'),record('Notepad++','notepad++'),record('Microsoft Teams'),record('TeamViewer'),record('Teams Classic')];
 for(const [query,name] of [['blendar','Blender 5.2'],['blendr','Blender 5.2'],['vls','VLC media player'],['vlc plyer','VLC media player'],['vs cod','Visual Studio Code'],['visul studio cod','Visual Studio Code'],['notpad++','Notepad++'],['notpad','Notepad'],['teamvewer','TeamViewer']])assert.equal(resolve.resolve(query,apps).app?.name,name,query);
 assert.equal(resolve.resolve('team',apps).success,false);
 assert.equal(normalize(' Notepad++ '),'notepad++');
 assert.equal(resolve.resolve('jxyqzz',apps).status,'APP_NOT_FOUND');
});
test('aliases derive from previously unseen metadata, with no product dictionary',()=>{
 const app=record('Zorvex Spectral Mapper','zmapper','Zorvex Corporation');
 app.shortcutName='Spectral Workbench';app.fileDescription='Spectral Mapper';
 const aliases=aliasesFor(app);for(const a of ['spectral mapper','spectral workbench','zs mapper','zmapper'])assert.ok(aliases.includes(a),a);
 assert.equal(resolve.resolve('Zorvex Spectarl Mapper',[app]).app.id,app.id);
 const invented=['Quenvox','Nembrix','Wavendra','Soltiva','Arvexia','Zulvoro','Tarnex','Ombrino','Yelvica','Praxoma'];
 const apps=invented.map(n=>record(n+' Canvas',n));
 for(const app of apps){const q=app.name.slice(0,2)+app.name[3]+app.name[2]+app.name.slice(4);assert.equal(resolve.resolve(q,apps).app?.id,app.id,q);}
});
test('natural language extraction and registry refresh are application-independent',()=>{
 for(const [text,query] of [['open blender','blender'],['please start blendar','blendar'],['open the blender app','blender'],['can you open blendr','blendr'],['run visual studio cod','visual studio cod'],['open my vlc player','vlc player'],['open Command Prompt','Command Prompt'],['open File Explorer','File Explorer']])assert.deepEqual(appLaunchTask(text),{tool:'app',action:'openApp',params:{query}});
 assert.equal(appLaunchTask('refresh app registry').action,'refreshAppRegistry');
 for(const text of ['open calc.exe && whoami','run C:\\evil.exe','open X and delete files'])assert.equal(appLaunchTask(text),null);
});
test('new installation appears after refresh; partial failures never block known matches',async()=>{
 let installed=[record('Unseen Painter')];let scans=0;const registry=new AppRegistryService({discovery:{discover:async()=>{scans++;return {apps:installed,errors:['install_root_entry']};}}});
 const service=new AppService(null,{registry});assert.equal((await service.resolve('Unseen Paintre')).app.name,'Unseen Painter');const before=scans;
 await service.resolve('Unseen Painter');assert.equal(scans,before);
 installed=[...installed,record('Newborn Composer')];assert.equal((await service.resolve('Newborn Composre')).app.name,'Newborn Composer');
 assert.equal((await service.resolve('xyzzzy')).status,'APP_NOT_FOUND');
});
test('failed refresh retains previously verified discovery rather than disabling launcher',async()=>{
 let fail=false;const registry=new AppRegistryService({discovery:{discover:async()=>{if(fail)throw Error('source failed');return {apps:[record('Unseen Painter')],errors:[]};}}});await registry.refresh();fail=true;
 assert.equal((await registry.refresh()).retained,true);assert.equal(registry.apps[0].name,'Unseen Painter');
});
test('discovered management consoles allow only one local System32 msc target',()=>{
 const system=path.win32.join(process.env.SystemRoot||'C:\\Windows','System32');
 const app={name:'Discovered Console',source:'windows_management',launchType:'windows_system_command',executablePath:path.win32.join(system,'mmc.exe'),launchArgs:[path.win32.join(system,'arbitrary-console.msc')]};
 assert.ok(trustedSystemCapability(app));assert.equal(trustedSystemCapability({...app,launchArgs:['C:\\Temp\\evil.msc']}),undefined);
 assert.equal(trustedSystemCapability({...app,launchArgs:[app.launchArgs[0],'/command']}),undefined);
});
