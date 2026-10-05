import path from 'node:path';
// Phase 1 may launch Windows tools; the Phase 2 executor must not control them.
export function assertDesktopApplication(app){
 if(!app)throw Object.assign(new Error('Application identity is required.'),{code:'SYSTEM_APPLICATION_OUT_OF_SCOPE'});
 const root=path.win32.normalize(process.env.SystemRoot||'C:\\Windows').toLowerCase();
 const exe=path.win32.normalize(app.executablePath||'').toLowerCase();
 const commandSurface=/\b(?:terminal|shell|powershell|bash|command prompt)\b/i.test([app.name,app.fileDescription,path.win32.basename(exe)].join(' '));
 const inWindows=exe===root||exe.startsWith(root+'\\');
 if(!app || app.source==='windows_system'||app.source==='windows_management'||app.launchType==='windows_system_command'||app.resolutionRisk==='sensitive'||inWindows||commandSurface)
  throw Object.assign(new Error('Windows system-management automation is outside Phase 2.'),{code:'SYSTEM_APPLICATION_OUT_OF_SCOPE'});
}
