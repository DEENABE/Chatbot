import React, { useEffect } from 'react';
import { Palette, UserRound, Cpu, X } from 'lucide-react';
import { useAppStore } from '../stores/useAppStore.js';
import { useNavStore } from '../stores/useNavStore.js';
import ProfileSettings from '../profile/ProfileSettings.jsx';
import ModelSettings from './ModelSettings.jsx';
import AppearanceSettings from './AppearanceSettings.jsx';
import SoftwareSourcesPanel from './SoftwareSourcesPanel.jsx';

// Full-page Settings. The tab ids are lower-case words on purpose: they are the
// accessible names of the tabs.
const SECTIONS = [
  { id: 'profile', icon: UserRound },
  { id: 'models', icon: Cpu },
  { id: 'appearance', icon: Palette },
  { id: 'software', icon: Cpu },
];

export default function SettingsPanel() {
  const settingsTab = useNavStore((state) => state.settingsTab);
  const setSettingsTab = useNavStore((state) => state.setSettingsTab);
  const setTab = useNavStore((state) => state.setTab);
  const settings = useAppStore((state) => state.settings);
  const accent = settings.accentColor || '#3b82f6';
  const current = SECTIONS.some((item) => item.id === settingsTab) ? settingsTab : 'profile';

  // Escape leaves Settings, unless the user is typing in a field.
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const tag = event.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      setTab('chat');
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [setTab]);

  return (
    <div className="h-full overflow-y-auto p-4 text-stone-300">
      <div className="mx-auto max-w-2xl space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-white">Settings</h2>
            <p className="mt-1 text-xs text-stone-500">
              Profile, model routing, software sources and appearance.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setTab('chat')}
            aria-label="Close settings"
            title="Back to chat"
            className="rounded-lg p-2 text-stone-500 transition-colors hover:bg-white/5 hover:text-white"
          >
            <X size={16} />
          </button>
        </div>

        <div
          role="tablist"
          aria-label="Settings sections"
          className="flex flex-wrap gap-1 border-b border-white/10 pb-2"
        >
          {SECTIONS.map((item) => {
            const Icon = item.icon;
            const active = current === item.id;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                id={`settings-tab-${item.id}`}
                aria-selected={active}
                aria-controls="settings-panel"
                onClick={() => setSettingsTab(item.id)}
                className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-xs capitalize transition-colors ${active ? 'bg-white/10 text-white' : 'text-stone-500 hover:text-white'}`}
                style={active ? { boxShadow: `inset 0 -2px 0 ${accent}` } : undefined}
              >
                <Icon size={13} style={{ color: active ? accent : undefined }} />
                {item.id}
              </button>
            );
          })}
        </div>

        <div
          id="settings-panel"
          role="tabpanel"
          aria-labelledby={`settings-tab-${current}`}
          className="pb-6"
        >
          {current === 'profile' && <ProfileSettings />}
          {current === 'models' && <ModelSettings />}
          {current === 'appearance' && <AppearanceSettings />}
          {current === 'software' && <SoftwareSourcesPanel />}
        </div>
      </div>
    </div>
  );
}
