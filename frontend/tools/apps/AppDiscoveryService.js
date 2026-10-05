import {helperScriptPath,powerShellPath} from '../DesktopRuntime.js';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validateTarget } from './AppTargetPolicy.js';
import { normalize, aliasesFor } from './AppResolverService.js';
import { systemCapabilities } from './WindowsSystemCapabilityRegistry.js';
import {validAppQuery} from './AppQueryNormalizer.js';
// Control Panel items that can change security posture: never opened by a fuzzy match.
const SENSITIVE_CONTROL_PANEL = new Set(['Microsoft.AdministrativeTools','Microsoft.UserAccounts','Microsoft.CredentialManager','Microsoft.BitLockerDriveEncryption','Microsoft.WindowsFirewall']);
const CANONICAL = /^Microsoft\.[A-Za-z]+$/;
/** Pure mapping of DiscoverApps.ps1 rows to registry entries (no I/O), so it can be tested without PowerShell. */
export function mapDiscoveredRows(rows) {
    const apps = new Map();
    for (const row of rows) {
      if(row.source==='control_panel') {
        // Only the canonical name and a printable display name are read from the registry; argv is code-built.
        if(!CANONICAL.test(row.canonicalName||'') || typeof row.name!=='string' || !/^[^\x00-\x1f"`$]{1,100}$/u.test(row.name))continue;
        const identity=`control_panel:${row.canonicalName}`.toLowerCase();
        if(apps.has(identity))continue;
        const entry={id:createHash('sha256').update(identity).digest('hex').slice(0,24),name:row.name,normalizedName:normalize(row.name),canonicalName:row.canonicalName,source:'control_panel',launchType:'windows_system_command',
          executablePath:path.win32.join(process.env.SystemRoot||'C:\\Windows','System32','control.exe'),launchArgs:['/name',row.canonicalName],windowTitle:row.name,supportedExtensions:[],supportedProtocols:[],available:true,
          resolutionRisk:SENSITIVE_CONTROL_PANEL.has(row.canonicalName)?'sensitive':'normal',lastSeen:new Date().toISOString()};
        try { validateTarget(entry); } catch(error) {entry.available=false;entry.blockedReason=error.message;}
        entry.displayName=entry.name;entry.executable='control.exe';entry.launchTarget=entry.executablePath;entry.aliases=aliasesFor(entry);
        apps.set(identity,entry);continue;
      }
      // Shared host executables must never absorb shortcut names as aliases.
      if (/^(explorer|control|mmc|regedit|taskmgr)\.exe$/i.test(path.win32.basename(row.executablePath||''))) continue;
      const identity = (row.appUserModelId || row.executablePath || '').toLowerCase();
      const entry = {...row,id:createHash('sha256').update(identity).digest('hex').slice(0,24),normalizedName:normalize(row.name),
        launchType:row.appUserModelId?'app_user_model_id':'executable',launchArgs:[],supportedExtensions:row.supportedExtensions||[],supportedProtocols:row.supportedProtocols||[],available:true,iconPath:row.executablePath||null,lastSeen:new Date().toISOString()};
      if(row.source==='windows_management'){entry.launchType='windows_system_command';entry.launchArgs=[row.executablePath];entry.executablePath=path.win32.join(process.env.SystemRoot,'System32','mmc.exe');entry.windowTitle=row.name;entry.resolutionRisk='sensitive';}
      try { validateTarget(entry); } catch(error) {entry.available=false;entry.blockedReason=error.message;}
      entry.displayName=entry.name;entry.executable=path.win32.basename(entry.executablePath||'');entry.launchTarget=entry.appUserModelId||entry.executablePath;

      if(row.requiresArguments){entry.available=false;entry.blockedReason='APP_UNSAFE_ARGUMENTS';}
      entry.aliases = aliasesFor(entry);
      const prior=apps.get(identity);
      if(prior) { prior.aliases=[...new Set([...prior.aliases,...entry.aliases])]; prior.supportedExtensions=[...new Set([...prior.supportedExtensions,...entry.supportedExtensions])];prior.supportedProtocols=[...new Set([...prior.supportedProtocols,...entry.supportedProtocols])];prior.publisher ||= entry.publisher; prior.version ||= entry.version; prior.installLocation ||= entry.installLocation;
        if(!prior.available&&entry.available)apps.set(identity,{...entry,aliases:prior.aliases}); }
      // Uninstall entries supply metadata only: an icon may itself be an installer.
      else if(row.source!=='uninstall') apps.set(identity,entry);
    }
    for(const [identity,entry] of apps) {
      const packageName=entry.executablePath?.match(/\\WindowsApps\\([^\\]+?)_\d[^\\]*\\/i)?.[1];
      if(!packageName)continue;
      const packagedMatches=[...apps.values()].filter(a=>a.launchType==='app_user_model_id' && a.appUserModelId.toLowerCase().startsWith(packageName.toLowerCase()+'_'));
      const packaged=packagedMatches.length===1?packagedMatches[0]:null;
      if(packaged){packaged.aliases=[...new Set([...packaged.aliases,...entry.aliases])];apps.delete(identity);}
    }
    return [...apps.values()];
}
/** Code-owned capabilities in registry-entry shape, plus discovered rows minus exact-name collisions. */
export function mergeSystemCapabilities(discovered) {
  const now=new Date().toISOString();
  const system=systemCapabilities().map(a=>({...a,displayName:a.name,executable:path.win32.basename(a.executablePath),launchTarget:a.executablePath,iconPath:a.executablePath,supportedExtensions:[],supportedProtocols:[],lastSeen:now}));
  // Get-StartApps also reports "Settings"/"Task Manager"; keeping both would give two EXACT matches (AMBIGUOUS_APP).
  const reserved=new Set(system.map(a=>normalize(a.name)));
  return [...system,...discovered.filter(a=>!reserved.has(a.normalizedName))];
}
export class AppDiscoveryService {
  // Merging happens here rather than in AppRegistryService.refresh(): the merged list is what gets cached, and
  // every consumer of discover() (registry, integration tests) sees the same code-owned capabilities.
  async discover({query}={}) {
    if (process.platform !== 'win32') throw new Error('APP_PLATFORM_UNSUPPORTED');
    if(query!==undefined&&!validAppQuery(query))throw new Error('APP_INVALID_QUERY');
    let raw;
    try {
      raw = await new Promise((resolve,reject) => execFile(powerShellPath(),
        ['-NoProfile','-NonInteractive','-File',helperScriptPath('DiscoverApps.ps1'),...(query?['-Query',query]:[])],
        {windowsHide:true,timeout:40000,maxBuffer:8*1024*1024,encoding:'utf8'}, (error,out)=>{if(error)return reject(error);try{resolve(JSON.parse(out.replace(/^\uFEFF/,'')));}catch(e){reject(e);}}));
    } catch {
      // Code-owned capabilities do not depend on the script; `degraded` lets the registry keep a richer prior cache.
      return {apps:mergeSystemCapabilities([]),errors:['discovery_script_failed'],degraded:true};
    }
    return {apps:mergeSystemCapabilities(mapDiscoveredRows(raw.apps||[])),errors:raw.errors||[]};
  }
}
