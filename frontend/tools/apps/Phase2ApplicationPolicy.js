import path from 'node:path';
import { SETTINGS_URI } from './SettingsCatalog.js';
// Phase 1 may launch Windows tools; the Phase 2 executor controls third-party apps and, as the one Windows exception, the
// Settings app. Settings pages are driven through the same grounded loop: every change is a DANGEROUS action that needs
// human confirmation, and SemanticUI still refuses CRITICAL controls (security, permissions, credentials...).
// Terminals, Control Panel, MMC consoles, Registry Editor, Task Manager, Windows Security and sensitive Settings pages
// (recovery, activation, sign-in, encryption...) stay out of scope.
export const SETTINGS_APP_ID =
  'windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel';

/** A normal (non-sensitive) Windows Settings page launched through its ms-settings: URI. */
export function isWindowsSettingsPage(app) {
  return (
    !!app &&
    app.source === 'windows_system' &&
    app.trusted !== false &&
    app.resolutionRisk !== 'sensitive' &&
    /^(?:settings|[a-z0-9-]+-settings)$/.test(String(app.id || '')) &&
    Array.isArray(app.launchArgs) &&
    app.launchArgs.length === 1 &&
    SETTINGS_URI.test(String(app.launchArgs[0] || ''))
  );
}

/** Identity the UI reader uses for the window: the Settings app is found by its AUMID (it may be hosted by ApplicationFrameHost). */
export function desktopIdentity(app) {
  if (isWindowsSettingsPage(app))
    return {
      ...app,
      executablePath: '',
      appUserModelId: SETTINGS_APP_ID,
      windowsSettings: true,
    };
  return app;
}

export function assertDesktopApplication(app) {
  if (!app)
    throw Object.assign(new Error('Application identity is required.'), {
      code: 'SYSTEM_APPLICATION_OUT_OF_SCOPE',
    });
  if (isWindowsSettingsPage(app)) return;
  const root = path.win32.normalize(process.env.SystemRoot || 'C:\\Windows').toLowerCase();
  const exe = path.win32.normalize(app.executablePath || '').toLowerCase();
  const commandSurface = /\b(?:terminal|shell|powershell|bash|command prompt)\b/i.test(
    [app.name, app.fileDescription, path.win32.basename(exe)].join(' '),
  );
  const inWindows = exe === root || exe.startsWith(root + '\\');
  if (
    app.source === 'windows_system' ||
    app.source === 'windows_management' ||
    app.launchType === 'windows_system_command' ||
    app.resolutionRisk === 'sensitive' ||
    inWindows ||
    commandSurface
  )
    throw Object.assign(
      new Error(
        'Windows system-management automation is outside Phase 2 (only the Windows Settings app can be controlled).',
      ),
      { code: 'SYSTEM_APPLICATION_OUT_OF_SCOPE' },
    );
}
