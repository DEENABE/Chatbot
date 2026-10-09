import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const DESKTOP_TOOLS = Object.freeze([
  'app',
  'uiAutomation',
  'desktop',
  'inspector',
  'browser',
]);
export const DESKTOP_HELPERS = Object.freeze([
  'GenericUI.ps1',
  'DesktopUI.ps1',
  'DiscoverApps.ps1',
  'ActivateApp.ps1',
  'InteractWithApp.ps1',
  'OpenTargetUI.ps1',
  'ObserveApp.ps1',
  'DesktopAccessibility.cs',
]);
// Helpers that are packaged and allowed to run but are NOT required for desktop control to be ready: losing one (for example
// to an antivirus) must only disable that feature, never app launching or UI automation.
export const OPTIONAL_HELPERS = Object.freeze(['SystemSettings.ps1', 'SystemSettingsAdmin.ps1']);
let runtime = Object.freeze({ isPackaged: false });
// Called by trusted Electron startup, never by a tool/model parameter.
export function configureDesktopRuntime(options) {
  runtime = Object.freeze({ ...options });
}
export function desktopPaths(options = runtime) {
  const root = options.isPackaged
    ? path.join(options.resourcesPath, 'desktop-control')
    : fileURLToPath(new URL('./apps/', import.meta.url));
  return {
    isPackaged: options.isPackaged === true,
    platform: options.platform || process.platform,
    powershellPath: path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    ),
    helperRoot: root,
    genericUIScriptPath: path.join(root, 'GenericUI.ps1'),
  };
}
export function helperScriptPath(name) {
  if (!DESKTOP_HELPERS.includes(name) && !OPTIONAL_HELPERS.includes(name))
    throw Object.assign(new Error('Unknown desktop helper.'), {
      code: 'DESKTOP_HELPER_NOT_ALLOWED',
    });
  const target = path.join(desktopPaths().helperRoot, name);
  if (target.split(/[\\/]/).some((part) => part.endsWith('.asar')) || !fs.existsSync(target))
    throw Object.assign(new Error('Desktop helper unavailable.'), {
      code: 'DESKTOP_HELPER_MISSING',
    });
  return target;
}
export const powerShellPath = () => desktopPaths().powershellPath;
