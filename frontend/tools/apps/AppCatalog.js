import path from 'node:path';
import { capabilitiesFor } from './AppCapabilities.js';
import { levelSummary } from './AppPermissionStore.js';

// Categories only help the model choose an application and describe it; they never grant access. They come from
// generic name/publisher/description wording, not from a list of products, and unknown applications stay "General".
const CATEGORY_WORDS = [
  ['Browser', /\b(?:browser|chrome|firefox|edge|brave|opera|vivaldi)\b/i],
  ['Code editor', /\b(?:code|studio|editor|ide|notepad\+\+|sublime|pycharm|intellij)\b/i],
  ['Media', /\b(?:media|player|vlc|music|spotify|video|audio|podcast)\b/i],
  [
    'Communication',
    /\b(?:chat|message|messenger|whatsapp|telegram|slack|teams|discord|zoom|skype|mail|outlook)\b/i,
  ],
  ['Office', /\b(?:word|excel|powerpoint|onenote|office|libreoffice|pdf|reader|acrobat)\b/i],
  ['Creative', /\b(?:photo|paint|draw|design|blender|gimp|obs|studio one|adobe|figma|canva)\b/i],
  ['Games', /\b(?:game|steam|epic games|xbox|launcher)\b/i],
  [
    'Utilities',
    /\b(?:zip|rar|archive|sync|backup|recorder|screen|clean|utility|manager|explorer)\b/i,
  ],
];
const PROFILE_CATEGORY = {
  editor: 'Code editor',
  media: 'Media',
  browser: 'Browser',
  text: 'Text editor',
};
const SYSTEM_SOURCES = new Set(['windows_system', 'windows_management', 'control_panel']);

// Sources that describe an application a person launches (shortcuts, Store apps, registered apps, running windows).
// Executable scans (install_roots, path) also find helpers and updaters, which stay launchable by name but are not listed.
const CATALOG_SOURCES = new Set(['start_menu', 'msix', 'shell_apps', 'app_paths', 'running']);
export const isCatalogApp = (app) => isThirdPartyApp(app) && CATALOG_SOURCES.has(app.source);

/** Third-party, user-facing applications the assistant may work with (Windows tools are a separate capability). */
export function isThirdPartyApp(app) {
  if (
    !app ||
    app.available !== true ||
    SYSTEM_SOURCES.has(app.source) ||
    app.resolutionRisk === 'sensitive'
  )
    return false;
  const exe = path.win32.normalize(app.executablePath || '').toLowerCase();
  const root = path.win32.normalize(process.env.SystemRoot || 'C:\\Windows').toLowerCase();
  return !(exe === root || exe.startsWith(root + '\\'));
}

export function categoryFor(app) {
  const profile = capabilitiesFor(app).profile;
  if (profile && PROFILE_CATEGORY[profile]) return PROFILE_CATEGORY[profile];
  const text = [app.name, app.fileDescription, app.productName].filter(Boolean).join(' ');
  return CATEGORY_WORDS.find(([, words]) => words.test(text))?.[0] || 'General';
}

/** What the assistant can do with an application: open targets it supports plus generic UI abilities. */
export function abilitiesFor(app) {
  const caps = capabilitiesFor(app);
  const abilities = ['launch_or_focus', 'read_visible_ui'];
  if (caps.openFile) abilities.push('open_file');
  if (caps.openFolder) abilities.push('open_folder');
  if (caps.openUrl) abilities.push('open_url');
  if (caps.openMedia) abilities.push('play_media');
  abilities.push('operate_controls_via_ui_automation');
  return abilities;
}

export const catalogEntry = (app, level) => ({
  id: app.id,
  name: app.name,
  category: categoryFor(app),
  permission: level,
});

export function describeApp(app, level) {
  const caps = capabilitiesFor(app);
  return {
    id: app.id,
    name: app.name,
    publisher: app.publisher || undefined,
    version: app.version || undefined,
    category: categoryFor(app),
    permission: levelSummary(level),
    canOpenTargets: caps.types,
    abilities: abilitiesFor(app),
    uiAccess:
      'Windows UI Automation (falls back to accessibility). Apps that draw their own UI (games, some Electron or canvas apps) may expose few or no controls.',
    nextSteps:
      level === 'blocked'
        ? [
            'The user has blocked this application. Ask them to raise its permission in App Permissions if they want help with it.',
          ]
        : [
            'Call desktop_open with this app name to launch it and read its current UI.',
            'Then use desktop_act with an elementId from that snapshot, only for actions marked allowed:true.',
          ],
  };
}
