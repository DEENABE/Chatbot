import fs from 'node:fs';
import path from 'node:path';
import {desktopPaths,DESKTOP_HELPERS,DESKTOP_TOOLS} from './DesktopRuntime.js';
export function desktopCapabilityDiagnostics(router,{runtime,exists=fs.existsSync,requestedTool='app.openApp'}={}){
 const paths=desktopPaths(runtime),registeredTools=[...router.services.keys()];
 const registered=!!router.registry?.get('app.openApp')&&!!router.registry?.get('desktop.open');
 const uiAutomation=!!router.services.get('uiAutomation')?.run&&!!router.registry?.get('uiAutomation.findWindow');
 const executor=typeof router.services.get('process')?.launchApp==='function';
 const appDiscovery=typeof router.services.get('app')?.registry?.discovery?.discover==='function';
 const files=Object.fromEntries(DESKTOP_HELPERS.map(name=>[name,exists(path.join(paths.helperRoot,name))&&!paths.helperRoot.split(/[\\/]/).some(p=>p.endsWith('.asar'))]));
 const powershell=exists(paths.powershellPath),genericUIScript=files['GenericUI.ps1'];
 const reasons=[];
 if(paths.platform!=='win32')reasons.push('PLATFORM_UNSUPPORTED');
 if(!registered)reasons.push('TOOL_NAME_MISMATCH');
 if(!uiAutomation)reasons.push('UI_AUTOMATION_SERVICE_NOT_REGISTERED');
 if(!genericUIScript)reasons.push('GENERIC_UI_SCRIPT_MISSING');
 if(!powershell)reasons.push('POWERSHELL_UNAVAILABLE');
 if(!appDiscovery)reasons.push('APP_DISCOVERY_UNAVAILABLE');
 if(!executor)reasons.push('DESKTOP_EXECUTOR_UNAVAILABLE');
 for(const [name,present] of Object.entries(files))if(!present&&name!=='GenericUI.ps1')reasons.push('DESKTOP_HELPER_MISSING:'+name);
 const ready=reasons.length===0;
 return {isPackaged:paths.isPackaged,platform:paths.platform,requestedTool,registeredTools,desktopToolRegistered:registered,
  uiAutomationAvailable:uiAutomation,powershellPath:paths.powershellPath,genericUIScriptPath:paths.genericUIScriptPath,scriptExists:genericUIScript,
  desktopControl:{registered,uiAutomation,genericUIScript,powershell,appDiscovery,executor,ready,reasons}};
}
export function desktopDebugLines(d){const c=d.desktopControl;return ['Desktop Control',...Object.entries({'App discovery':c.appDiscovery,'Tool registration':c.registered,'PowerShell':c.powershell,'Generic UI helper':c.genericUIScript,'UI Automation':c.uiAutomation,'Executor':c.executor}).map(([name,ok])=>`${name} ${ok?'PASS':'FAIL'}`)].join('\n');}
export const isDesktopTool=tool=>DESKTOP_TOOLS.includes(tool);
