import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {AppResolverService,normalize} from '../apps/AppResolverService.js';
import {AppRegistryService} from '../apps/AppRegistryService.js';
import {mapDiscoveredRows,mergeSystemCapabilities} from '../apps/AppDiscoveryService.js';
import {systemCapabilities,trustedSystemCapability,systemProcessNames,systemLaunchCommand} from '../apps/WindowsSystemCapabilityRegistry.js';
import {SETTINGS_CATALOG,SETTINGS_URI} from '../apps/SettingsCatalog.js';
import {validateTarget} from '../apps/AppTargetPolicy.js';
import {appLaunchTask} from '../../../backend/src/orchestrator/AppLaunchTask.js';
import {computerTask} from '../../../backend/src/orchestrator/ComputerTaskPolicy.js';
const root=process.env.SystemRoot||'C:\\Windows',system32=path.win32.join(root,'System32');
const discovered=(name,extra={})=>({id:`d-${name}`,name,normalizedName:normalize(name),aliases:[normalize(name)],available:true,source:'msix',launchType:'app_user_model_id',appUserModelId:`Vendor.${name.replace(/\W/g,'')}_x!App`,launchArgs:[],supportedExtensions:[],supportedProtocols:[],...extra});
const controlRow={name:'Programs and Features',canonicalName:'Microsoft.ProgramsAndFeatures',source:'control_panel'};
const fake=[
  discovered('Settings',{appUserModelId:'windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel'}),
  discovered('Task Manager'),discovered('Microsoft Teams'),discovered('Camera'),discovered('Clock'),discovered('Bluetooth LE Explorer'),
  ...mapDiscoveredRows([controlRow,{name:'Sound',canonicalName:'Microsoft.Sound',source:'control_panel'}]),
];
const apps=mergeSystemCapabilities(fake);
const resolver=new AppResolverService();
const resolved=q=>resolver.resolve(q,apps);

test('system Settings, Control Panel, MMC and tool names each resolve to one app',()=>{
  for(const [query,id] of [
    ['wifi settings','wifi-settings'],['wi-fi','wifi-settings'],['display settings','display-settings'],['dark mode','colors-settings'],
    ['windows update','update-settings'],['device manager','device-manager'],['control panel','control-panel'],['task manager','task-manager'],
    ['windows features','windows-features'],['turn windows features on or off','windows-features'],['bluetooth settings','bluetooth-settings'],
    ['settings for bluetooth','bluetooth-settings'],['dark mode settings','colors-settings'],['wifi setting','wifi-settings'],
    ['system information','system-information'],['about windows','about-windows'],['on screen keyboard','on-screen-keyboard'],['msconfig','system-configuration'],
  ]) {const r=resolved(query);assert.equal(r.success,true,`${query}: ${JSON.stringify(r)}`);assert.equal(r.app.id,id,query);}
  const programs=resolved('programs and features');
  assert.equal(programs.success,true);assert.equal(programs.app.source,'control_panel');assert.deepEqual(programs.app.launchArgs,['/name','Microsoft.ProgramsAndFeatures']);
});
test('the Get-StartApps "Settings" row never competes with the system Settings capability',()=>{
  const r=resolved('settings');
  assert.equal(r.success,true,JSON.stringify(r));assert.equal(r.app.source,'windows_system');assert.equal(r.app.id,'settings');
  assert.equal(apps.filter(a=>a.normalizedName==='settings').length,1);
  assert.equal(apps.filter(a=>a.normalizedName==='task manager').length,1);
});
test('shared host executables do not make every Settings page match "explorer" or "mmc"',()=>{
  const r=resolved('explorer');assert.equal(r.app?.id,'file-explorer',JSON.stringify(r));
  assert.notEqual(resolved('mmc').status,'APP_RESOLVED');
});
test('generic aliases do not steal real application names',()=>{
  assert.equal(resolved('camera').app.id,'d-Camera');
  assert.equal(resolved('clock').app.id,'d-Clock');
  assert.equal(resolved('microsoft teams').app.id,'d-Microsoft Teams');
  assert.notEqual(resolved('bluetooth').app?.id,'d-Bluetooth LE Explorer');
  assert.equal(resolved('camera permission').app.id,'camera-privacy-settings');
});
test('sensitive pages and consoles are not opened from a fuzzy match',()=>{
  for(const query of ['recovry settings','activaton settings','developr mode','sign in optons','windows featurs','sytem configuration','regsitry editor']) {
    const r=resolved(query);assert.equal(r.success,false,`${query} -> ${r.app?.name}`);
  }
  for(const id of ['recovery-settings','activation-settings','developer-settings','signin-settings','windows-features','system-configuration'])assert.equal(apps.find(a=>a.id===id).resolutionRisk,'sensitive',id);
  // Exact requests for a sensitive page still open it.
  assert.equal(resolved('recovery settings').app.id,'recovery-settings');
  assert.equal(resolved('windows features').app.id,'windows-features');
});
test('every catalog id ends in -settings and resolves to its own page by name',()=>{
  const ids=SETTINGS_CATALOG.map(r=>r[0]);assert.equal(new Set(ids).size,ids.length);
  for(const [id,name,,uri] of SETTINGS_CATALOG){
    assert.match(id,/-settings$/);assert.match(uri,SETTINGS_URI);
    const r=resolved(name);assert.equal(r.app?.id,id,`${name}: ${JSON.stringify(r.matches?.slice(0,3)||r.app?.id)}`);
  }
  assert.ok(Object.isFrozen(SETTINGS_CATALOG));
});
test('trustedSystemCapability rejects hostile explorer, control and mmc arguments',()=>{
  const base=id=>systemCapabilities().find(a=>a.id===id);
  const settings=base('wifi-settings');assert.ok(trustedSystemCapability(settings));
  for(const launchArgs of [['ms-settings:foo bar'],['ms-settings:x&calc'],['ms-settings:network-wifi','calc'],['https://example.com'],['ms-settings:NETWORK'],['ms-settings:a;b'],[]])
    assert.equal(trustedSystemCapability({...settings,launchArgs}),undefined,JSON.stringify(launchArgs));
  assert.equal(trustedSystemCapability({...settings,executablePath:path.win32.join(system32,'explorer.exe')}),undefined);
  const panel={id:'x',name:'Programs and Features',source:'control_panel',launchType:'windows_system_command',executablePath:path.win32.join(system32,'control.exe'),launchArgs:['/name','Microsoft.ProgramsAndFeatures']};
  assert.ok(trustedSystemCapability(panel));
  for(const launchArgs of [['/name','Microsoft.X;calc'],['/name','Microsoft.X','extra'],['Microsoft.X'],['/name'],['/name','Evil.Thing'],['/name','Microsoft.X Y'],['/runas','Microsoft.X'],['/name','Microsoft.'] ])
    assert.equal(trustedSystemCapability({...panel,launchArgs}),undefined,JSON.stringify(launchArgs));
  assert.equal(trustedSystemCapability({...panel,executablePath:'C:\\Temp\\control.exe'}),undefined);
  const mmc={name:'Console',source:'windows_management',launchType:'windows_system_command',executablePath:path.win32.join(system32,'mmc.exe'),launchArgs:[path.win32.join(system32,'ok.msc')]};
  assert.ok(trustedSystemCapability(mmc));
  for(const launchArgs of [['C:\\Temp\\evil.msc'],[path.win32.join(root,'evil.msc')],[path.win32.join(system32,'sub','evil.msc')],[path.win32.join(system32,'ok.msc'),'/a']])
    assert.equal(trustedSystemCapability({...mmc,launchArgs}),undefined,JSON.stringify(launchArgs));
});
test('validateTarget admits every code-owned capability and control panel row (mock exists)',()=>{
  for(const app of apps.filter(a=>a.source==='windows_system'||a.source==='control_panel'))assert.doesNotThrow(()=>validateTarget(app,()=>true),app.id);
  assert.throws(()=>validateTarget(apps.find(a=>a.id==='wifi-settings'),()=>false),/APP_TARGET_MISSING/);
  // msconfig is launchable only through the trusted entry, never as a discovered executable.
  const msconfig=apps.find(a=>a.id==='system-configuration');
  assert.doesNotThrow(()=>validateTarget(msconfig,()=>true));
  assert.throws(()=>validateTarget({...msconfig,id:'discovered',source:'start_menu',launchType:'executable',launchArgs:[]},()=>true),/APP_UNSAFE_TARGET/);
});
test('control_panel discovery rows map to code-built launch arguments',()=>{
  const [entry]=mapDiscoveredRows([controlRow]);
  assert.equal(entry.launchType,'windows_system_command');assert.equal(entry.executablePath.toLowerCase(),path.win32.join(system32,'control.exe').toLowerCase());
  assert.deepEqual(entry.launchArgs,['/name','Microsoft.ProgramsAndFeatures']);assert.equal(entry.windowTitle,'Programs and Features');
  assert.equal(entry.resolutionRisk,'normal');assert.ok(trustedSystemCapability(entry));assert.ok(['explorer','rundll32'].every(n=>systemProcessNames(entry).includes(n)));
  for(const canonical of ['Microsoft.AdministrativeTools','Microsoft.UserAccounts','Microsoft.CredentialManager','Microsoft.BitLockerDriveEncryption','Microsoft.WindowsFirewall'])
    assert.equal(mapDiscoveredRows([{name:'X item',canonicalName:canonical,source:'control_panel'}])[0].resolutionRisk,'sensitive',canonical);
  // Rows that could smuggle an argument or an unresolved name are dropped, not sanitised.
  for(const bad of [{...controlRow,canonicalName:'Microsoft.X;calc'},{...controlRow,canonicalName:'Contoso.Thing'},{...controlRow,name:''},{...controlRow,name:'a\nb'},{...controlRow,name:'a"b'},{...controlRow,canonicalName:undefined}])
    assert.deepEqual(mapDiscoveredRows([bad]),[],JSON.stringify(bad));
  assert.equal(mapDiscoveredRows([controlRow,controlRow]).length,1);
});
test('registry keeps code-owned capabilities when discovery is empty or degraded, and rejects the v1 cache',async()=>{
  const empty=new AppRegistryService({discovery:{discover:async()=>({apps:mergeSystemCapabilities([]),errors:['powershell_partial']})}});
  await empty.refresh();assert.ok(empty.apps.some(a=>a.id==='device-manager'&&a.capabilities));
  const {AppDiscoveryService}=await import('../apps/AppDiscoveryService.js');assert.equal(typeof new AppDiscoveryService().discover,'function');
  let degraded=false;const registry=new AppRegistryService({discovery:{discover:async()=>degraded?{apps:mergeSystemCapabilities([]),errors:['discovery_script_failed'],degraded:true}:{apps:mergeSystemCapabilities([discovered('Unseen Painter')]),errors:[]}}});
  await registry.refresh();degraded=true;assert.equal((await registry.refresh()).retained,true);assert.ok(registry.apps.some(a=>a.name==='Unseen Painter'));
  const fs=await import('node:fs/promises'),os=await import('node:os');
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'reg-'));
  try {
    await fs.writeFile(path.join(directory,'app-registry.json'),JSON.stringify({schemaVersion:1,scannedAt:Date.now(),apps:[{name:'Stale',aliases:['stale']}]}));
    const cached=new AppRegistryService({directory,discovery:{discover:async()=>({apps:[],errors:[]})}});await cached.ready;assert.deepEqual(cached.apps,[]);
    await cached.refresh();assert.equal(JSON.parse(await fs.readFile(path.join(directory,'app-registry.json'),'utf8')).schemaVersion,2);
  } finally {await fs.rm(directory,{recursive:true,force:true});}
});
test('window observation maps each system tool to its owning process',()=>{
  const by=id=>apps.find(a=>a.id===id);
  assert.deepEqual(systemProcessNames(by('wifi-settings')),['SystemSettings','ApplicationFrameHost']);
  assert.deepEqual(systemProcessNames(by('windows-features')),['OptionalFeatures']);
  assert.deepEqual(systemProcessNames(by('control-panel')),['explorer']);
  assert.deepEqual(systemProcessNames(by('device-manager')),['mmc']);
  assert.ok(systemProcessNames(by('resource-monitor')).includes('resmon'));
  for(const a of apps.filter(a=>a.source==='windows_system'))assert.ok(a.windowTitle,a.id);
});
test('routing sends natural settings phrasings to the app tool and still rejects unsafe text',()=>{
  for(const [text,query] of [['open wifi settings','wifi settings'],['open settings for bluetooth','settings for bluetooth'],['open control panel','control panel'],['open device manager','device manager'],
    ['open windows features','windows features'],['open dark mode settings','dark mode settings'],['launch task manager','task manager'],['open programs and features','programs and features'],['Open the Windows Update settings','Windows Update settings']]) {
    assert.deepEqual(appLaunchTask(text),{tool:'app',action:'openApp',params:{query}},text);
    assert.deepEqual(computerTask(text)?.call,{tool:'app',action:'openApp',params:{query}},`policy: ${text}`);
  }
  for(const text of ['open ms-settings:network-wifi','open control.exe /name Microsoft.X','open C:\\Windows\\System32\\devmgmt.msc','open control panel and delete files','open programs and features and then format c','open device manager; calc'])assert.equal(appLaunchTask(text),null,text);
});
test('elevation-manifest tools and MMC consoles are spawned through Explorer with validated arguments only',()=>{
  const by=id=>apps.find(a=>a.id===id),explorer=path.win32.join(root,'explorer.exe');
  assert.deepEqual(systemLaunchCommand(by('device-manager')),{executable:explorer,args:[path.win32.join(system32,'devmgmt.msc')]});
  assert.deepEqual(systemLaunchCommand(by('windows-features')),{executable:explorer,args:[path.win32.join(system32,'optionalfeatures.exe')]});
  assert.deepEqual(systemLaunchCommand(by('wifi-settings')),{executable:path.win32.join(root,'explorer.exe'),args:['ms-settings:network-wifi']});
  assert.deepEqual(systemLaunchCommand(by('task-manager')).args,[]);
  const [panel]=mapDiscoveredRows([controlRow]);assert.deepEqual(systemLaunchCommand(panel).args,['/name','Microsoft.ProgramsAndFeatures']);
  assert.equal(systemLaunchCommand({...by('device-manager'),launchArgs:['C:\Temp\evil.msc']}),undefined);
  assert.equal(systemLaunchCommand({...panel,launchArgs:['/name','Microsoft.X;calc']}),undefined);
});
