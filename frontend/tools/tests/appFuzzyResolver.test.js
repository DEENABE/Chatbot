import test from 'node:test';
import assert from 'node:assert/strict';
import {AppResolverService,normalizeAppName} from '../apps/AppResolverService.js';
import {jaroWinkler,editDistance} from '../apps/AppFuzzyMatcher.js';
import {AppRegistryService} from '../apps/AppRegistryService.js';
import {AppService} from '../services/AppService.js';
import {appLaunchTask} from '../../../backend/src/orchestrator/AppLaunchTask.js';
const app=(name,id=name,extra={})=>({id,name,available:true,source:'start_menu',launchType:'executable',executablePath:`C:\\Programs\\${id}.exe`,launchArgs:[],...extra});
const resolver=new AppResolverService();
test('normalization and query extraction are reusable and preserve application identity',()=>{
 assert.equal(normalizeAppName(' Blender.EXE '),'blender');assert.equal(normalizeAppName('Visual-Studio_Code'),'visual studio code');assert.equal(normalizeAppName('  VLC   Player '),'vlc player');assert.equal(normalizeAppName('Ｎｏｔｅｐａｄ++'),'notepad++');
 for(const text of ['open blendar','please open blendar','launch blendar','start the blendar application','can you run blendar'])assert.equal(appLaunchTask(text).params.query,'blendar');
});
test('Damerau and Jaro-Winkler are independently meaningful',()=>{assert.equal(editDistance('reslove','resolve'),1);assert.equal(editDistance('blneder','blender'),1);assert.equal(jaroWinkler('same','same'),1);assert.equal(jaroWinkler('','x'),0);assert.ok(jaroWinkler('martha','marhta')>.95);});
test('example corpus and unseen names use identical generic scoring',()=>{
 const apps=[app('Blender'),app('VLC media player','vlc'),app('Visual Studio Code','Code'),app('Notepad++'),app('DaVinci Resolve'),app('Zorvex Spectral Mapper'),app('Quenvox Canvas')];
 for(const [q,name] of [['blendar','Blender'],['blendr','Blender'],['blneder','Blender'],['visul studio cod','Visual Studio Code'],['vlc plyer','VLC media player'],['vls','VLC media player'],['notpad++','Notepad++'],['davnci reslove','DaVinci Resolve'],['Zorvex Spectarl Mapper','Zorvex Spectral Mapper'],['quenovx canvas','Quenvox Canvas']])assert.equal(resolver.resolve(q,apps).app?.name,name,q);
 assert.equal(resolver.resolve('notpad',apps).success,false);
});
test('resolver cannot manufacture a system record or execute a query',()=>{
 for(const q of ['Calculator','Control Panel','File Explorer','zxqwertapp','calc.exe && whoami','C:\\Windows\\calc.exe'])assert.equal(resolver.resolve(q,[]).code,'APP_NOT_FOUND');
 assert.equal(resolver.resolve('Ghost',[app('Ghost','ghost',{available:false})]).success,false);
});
test('semantic ambiguity, metadata collisions, and short names never win by ordering',()=>{
 const apps=[app('Microsoft Teams'),app('Teams Classic'),app('TeamViewer')];assert.equal(resolver.resolve('team',apps).code,'APP_AMBIGUOUS');assert.equal(resolver.resolve('teamvewer',apps).app.name,'TeamViewer');
 const duplicate=[app('First','first',{shortcutName:'Editor'}),app('Second','second',{shortcutName:'Editor'})];assert.equal(resolver.resolve('editor',duplicate).code,'APP_AMBIGUOUS');assert.equal(resolver.resolve('editor',duplicate.reverse()).success,false);
 assert.equal(resolver.resolve('vls',[app('VLC'),app('VLT')]).success,false);
});
test('metadata index reads new record values and diagnostics never expose executable paths',()=>{
 const a=app('Unseen Product','unseen',{registryDisplayName:'Spectral Workbench',packageDisplayName:'Quantum Composer'});assert.equal(resolver.resolve('quantum composer',[a]).app.id,a.id);
 const diagnostics=resolver.diagnose('spectarl workbench',[a]);assert.equal(diagnostics.selected,a.name);assert.equal(diagnostics.decision,'AUTO_OPEN');assert.ok(diagnostics.candidates[0].matchedAgainst);assert.ok(!JSON.stringify(diagnostics).includes('C:\\'));
 a.name='Renamed Tool';a.registryDisplayName='New Name';assert.equal(resolver.resolve('new name',[a]).success,true);
});
test('thresholds configurable and typo queries never persist aliases',()=>{
 assert.throws(()=>new AppResolverService({thresholds:{highConfidence:2}}));const strict=new AppResolverService({thresholds:{highConfidence:1,mediumConfidence:1}});assert.equal(strict.resolve('paitner',[app('Painter')]).success,false);
 const aliases={};resolver.resolve('paitner',[app('Painter')],aliases);assert.deepEqual(aliases,{});
});
test('first miss discovers an unseen installation, retries fuzzy and skips successful rescans',async()=>{
 let installed=[app('Old Viewer')],scans=0;const registry=new AppRegistryService({discovery:{discover:async()=>{scans++;return {apps:installed,errors:[]};}}});await registry.refresh();const service=new AppService(null,{registry});
 installed=[...installed,app('Davnex Spectrum Composer')];const result=await service.resolve('davex specturm composer');assert.equal(result.code,'REGISTRY_REFRESHED_AND_MATCHED');assert.equal(result.app.name,'Davnex Spectrum Composer');assert.equal(scans,2);
 await service.resolve('Davnex Spectrum Composer');assert.equal(scans,2);assert.deepEqual(registry.aliases,{});
});
test('refresh failure is structured and preserves cache without selecting an unrelated app',async()=>{
 let failed=false;const registry=new AppRegistryService({discovery:{discover:async()=>{if(failed)throw Error('offline');return {apps:[app('Known Viewer')],errors:[]};}}});await registry.refresh();failed=true;
 const service=new AppService(null,{registry});assert.equal((await service.resolve('brand new editor')).code,'REGISTRY_REFRESH_FAILED');assert.equal((await service.resolve('Known Viewer')).success,true);
});
