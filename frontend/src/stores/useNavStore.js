// Navigation state for the main window: which of the four top-level sections
// (Chat / Workspace / History / Settings) is open and which sub-section the
// Workspace and Settings pages last showed. Kept in its own small store so any
// component can navigate (e.g. "open my profile") without prop drilling.
//
// Sub-section choices are remembered between launches; the app always opens on
// Chat so a demo or a fresh start never lands on a settings page.
import { create } from 'zustand';

export const NAV_TABS = ['chat', 'coding', 'workspace', 'history', 'settings'];
export const WORKSPACE_TABS = [
  'files',
  'coding',
  'knowledge',
  'memories',
  'translator',
  'apps',
  'diagnostics',
];
export const SETTINGS_TABS = ['profile', 'models', 'appearance', 'software'];

const STORAGE_KEYS = {
  workspace: 'chanakya-nav-workspace',
  settings: 'chanakya-nav-settings',
};

function readStored(key, allowed, fallback) {
  try {
    const value = window.localStorage.getItem(key);
    return allowed.includes(value) ? value : fallback;
  } catch {
    // Storage can be blocked or empty; navigation must still work.
    return fallback;
  }
}

function writeStored(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable — the choice just isn't remembered */
  }
}

export const useNavStore = create((set) => ({
  tab: 'chat',
  workspaceTab: readStored(STORAGE_KEYS.workspace, WORKSPACE_TABS, 'files'),
  settingsTab: readStored(STORAGE_KEYS.settings, SETTINGS_TABS, 'profile'),

  setTab: (tab) => {
    if (NAV_TABS.includes(tab)) set({ tab });
  },

  setWorkspaceTab: (workspaceTab) => {
    if (!WORKSPACE_TABS.includes(workspaceTab)) return;
    writeStored(STORAGE_KEYS.workspace, workspaceTab);
    set({ workspaceTab });
  },

  setSettingsTab: (settingsTab) => {
    if (!SETTINGS_TABS.includes(settingsTab)) return;
    writeStored(STORAGE_KEYS.settings, settingsTab);
    set({ settingsTab });
  },

  /** Open the Workspace page, optionally on a specific sub-section. */
  openWorkspace: (workspaceTab) => {
    if (WORKSPACE_TABS.includes(workspaceTab)) {
      writeStored(STORAGE_KEYS.workspace, workspaceTab);
      set({ tab: 'workspace', workspaceTab });
    } else {
      set({ tab: 'workspace' });
    }
  },

  /** Open the Settings page, optionally on a specific sub-section. */
  openSettings: (settingsTab) => {
    if (SETTINGS_TABS.includes(settingsTab)) {
      writeStored(STORAGE_KEYS.settings, settingsTab);
      set({ tab: 'settings', settingsTab });
    } else {
      set({ tab: 'settings' });
    }
  },
}));
