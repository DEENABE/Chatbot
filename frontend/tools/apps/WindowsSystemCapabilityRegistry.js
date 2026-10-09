import path from 'node:path';
import { SETTINGS_CATALOG, SENSITIVE_SETTINGS, SETTINGS_URI } from './SettingsCatalog.js';
// Only code-owned launchers. Discovered shortcuts cannot add arguments here.
// Entry: [id, name, aliases, exe, args, windowTitle, processNames?]. processNames lists the process(es) that own the
// window when it differs from the launched exe; the default is the exe's own name.
const definitions = [
  [
    'control-panel',
    'Control Panel',
    ['control panel', 'controlpanel', 'control pnl'],
    'control.exe',
    [],
    'Control Panel',
  ],
  [
    'powershell',
    'PowerShell',
    ['windows powershell'],
    'WindowsPowerShell\\v1.0\\powershell.exe',
    [],
    'Windows PowerShell',
  ],
  ['command-prompt', 'Command Prompt', ['cmd'], 'cmd.exe', [], 'Command Prompt'],
  [
    'bluetooth-settings',
    'Bluetooth Settings',
    ['bluetooth settings'],
    'explorer.exe',
    ['ms-settings:bluetooth'],
    'Settings',
  ],
  ['settings', 'Settings', ['windows settings'], 'explorer.exe', ['ms-settings:'], 'Settings'],
  ...SETTINGS_CATALOG.map(([id, name, aliases, uri]) => [
    id,
    name,
    aliases,
    'explorer.exe',
    [uri],
    'Settings',
  ]),
  [
    'file-explorer',
    'File Explorer',
    ['explorer', 'windows explorer'],
    'explorer.exe',
    [],
    'File Explorer',
  ],
  ['task-manager', 'Task Manager', [], 'Taskmgr.exe', [], 'Task Manager'],
  ['device-manager', 'Device Manager', [], 'mmc.exe', ['devmgmt.msc'], 'Device Manager'],
  ['services', 'Services', ['windows services'], 'mmc.exe', ['services.msc'], 'Services'],
  ['event-viewer', 'Event Viewer', [], 'mmc.exe', ['eventvwr.msc'], 'Event Viewer'],
  ['disk-management', 'Disk Management', [], 'mmc.exe', ['diskmgmt.msc'], 'Disk Management'],
  ['registry-editor', 'Registry Editor', [], 'regedit.exe', [], 'Registry Editor'],
  [
    'windows-security',
    'Windows Security',
    [],
    'explorer.exe',
    ['windowsdefender:'],
    'Windows Security',
  ],
  // Built-in system tools: no arguments, resolved only through this code-owned list.
  [
    'windows-features',
    'Windows Features',
    ['turn windows features on or off'],
    'optionalfeatures.exe',
    [],
    'Windows Features',
    ['OptionalFeatures'],
  ],
  [
    'system-information',
    'System Information',
    ['msinfo'],
    'msinfo32.exe',
    [],
    'System Information',
  ],
  [
    'resource-monitor',
    'Resource Monitor',
    [],
    'resmon.exe',
    [],
    'Resource Monitor',
    ['resmon', 'perfmon'],
  ],
  ['disk-cleanup', 'Disk Cleanup', [], 'cleanmgr.exe', [], 'Disk Cleanup'],
  [
    'directx-diagnostic-tool',
    'DirectX Diagnostic Tool',
    ['dxdiag'],
    'dxdiag.exe',
    [],
    'DirectX Diagnostic Tool',
  ],
  ['about-windows', 'About Windows', ['winver'], 'winver.exe', [], 'About Windows'],
  ['on-screen-keyboard', 'On-Screen Keyboard', ['osk'], 'osk.exe', [], 'On-Screen Keyboard'],
  ['magnifier', 'Magnifier', [], 'magnify.exe', [], 'Magnifier', ['Magnify']],
  ['character-map', 'Character Map', [], 'charmap.exe', [], 'Character Map'],
  // msconfig stays blocked for discovered executables (AppTargetPolicy); only this trusted entry may launch it.
  [
    'system-configuration',
    'System Configuration',
    ['msconfig'],
    'msconfig.exe',
    [],
    'System Configuration',
  ],
  // The Snipping Tool is packaged/discovered on current Windows; a fixed path here would only shadow it.
];
const sensitive = new Set([
  'powershell',
  'command-prompt',
  'services',
  'disk-management',
  'registry-editor',
  'windows-security',
  'windows-features',
  'system-configuration',
  ...SENSITIVE_SETTINGS,
]);
// explorer.exe/mmc.exe/control.exe live in a fixed location and host many distinct capabilities.
// Tools whose manifest demands elevation: CreateProcess fails with EACCES, so they open through Explorer, which
// applies Windows' own consent (UAC) rules.
const shellLaunched = new Set([
  'windows-features',
  'system-configuration',
  'on-screen-keyboard',
  'magnifier',
]);
const systemRootExecutables = new Set(['explorer.exe', 'regedit.exe']);
const validArguments = (exe, args) => {
  if (exe.toLowerCase() !== 'explorer.exe' || !args.length) return true;
  return (
    args.length === 1 &&
    typeof args[0] === 'string' &&
    (SETTINGS_URI.test(args[0]) || args[0] === 'windowsdefender:')
  );
};
export function systemCapabilities() {
  const root = process.env.SystemRoot || 'C:\\Windows';
  return definitions.map(([id, name, aliases, exe, args, title, processNames]) => ({
    id,
    name,
    normalizedName: name.toLowerCase(),
    aliases: [name.toLowerCase(), ...aliases],
    canonicalName: name,
    resolutionRisk: sensitive.has(id) ? 'sensitive' : 'normal',
    source: 'windows_system',
    launchType: 'windows_system_command',
    available: true,
    trusted: true,
    executablePath: path.win32.join(
      root,
      systemRootExecutables.has(exe.toLowerCase()) ? '' : 'System32',
      exe,
    ),
    launchArgs: args.map((a) => (a.endsWith('.msc') ? path.win32.join(root, 'System32', a) : a)),
    windowTitle: title,
    ...(processNames ? { processNames } : {}),
  }));
}
/** Process names that may own the visible window of a trusted system app (used to verify a launch). */
export function systemProcessNames(app) {
  if (app?.processNames?.length) return app.processNames;
  // Applets are hosted by explorer, or by rundll32/control for .cpl based ones (Sound, Mouse, Date and Time...).
  if (app?.source === 'control_panel')
    return ['explorer', 'rundll32', 'control', 'ApplicationFrameHost'];
  const id = app?.id || '';
  return id.includes('settings')
    ? ['SystemSettings', 'ApplicationFrameHost']
    : id === 'windows-security'
      ? ['SecHealthUI', 'ApplicationFrameHost']
      : id === 'control-panel' || id === 'file-explorer'
        ? ['explorer']
        : [path.win32.basename(app?.executablePath || '', '.exe')];
}
/**
 * The process actually spawned for a trusted capability. mmc.exe carries a requireAdministrator manifest, so a
 * non-elevated CreateProcess fails with EACCES; opening the validated System32 .msc through Explorer is the same
 * association launch a double-click performs and lets Windows decide about elevation. Nothing user-derived is used.
 */
export function systemLaunchCommand(app) {
  const trusted = trustedSystemCapability(app);
  if (!trusted) return undefined;
  const system32 = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  if (
    path.win32.basename(trusted.executablePath).toLowerCase() === 'mmc.exe' &&
    trusted.launchArgs.length === 1 &&
    path.win32.dirname(trusted.launchArgs[0]).toLowerCase() === system32.toLowerCase() &&
    /\.msc$/i.test(trusted.launchArgs[0])
  )
    return {
      executable: path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe'),
      args: [...trusted.launchArgs],
    };
  if (shellLaunched.has(trusted.id))
    return {
      executable: path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe'),
      args: [trusted.executablePath],
    };
  return { executable: trusted.executablePath, args: [...trusted.launchArgs] };
}
export function trustedSystemCapability(app) {
  const system32 = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const exePath = String(app?.executablePath || '').toLowerCase();
  // Management consoles are discovered from Windows shortcuts, not a product-name list.
  if (app?.source === 'windows_management' && app.launchType === 'windows_system_command') {
    const target = app.launchArgs?.[0];
    if (
      exePath === path.win32.join(system32, 'mmc.exe').toLowerCase() &&
      app.launchArgs?.length === 1 &&
      typeof target === 'string' &&
      path.win32.dirname(target).toLowerCase() === system32.toLowerCase() &&
      /^[a-zA-Z0-9._-]+\.msc$/.test(path.win32.basename(target))
    )
      return app;
  }
  // Control Panel applets are discovered from the registry; the launcher accepts a canonical name only.
  if (app?.source === 'control_panel' && app.launchType === 'windows_system_command') {
    const [flag, canonical] = Array.isArray(app.launchArgs) ? app.launchArgs : [];
    if (
      exePath === path.win32.join(system32, 'control.exe').toLowerCase() &&
      app.launchArgs.length === 2 &&
      flag === '/name' &&
      typeof canonical === 'string' &&
      /^Microsoft\.[A-Za-z]+$/.test(canonical)
    )
      return app;
    return undefined;
  }
  return systemCapabilities().find(
    (a) =>
      a.id === app?.id &&
      a.source === app.source &&
      a.launchType === app.launchType &&
      a.executablePath === app.executablePath &&
      JSON.stringify(a.launchArgs) === JSON.stringify(app.launchArgs) &&
      validArguments(path.win32.basename(a.executablePath), a.launchArgs),
  );
}
