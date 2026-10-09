import React from 'react';
import { Check, ShieldAlert, ToggleLeft, ToggleRight } from 'lucide-react';
import { useAppStore } from '../stores/useAppStore.js';

const ACCENT_COLORS = [
  { name: 'Sky Blue', value: '#3b82f6' },
  { name: 'Gold Accent', value: '#bd9134' },
  { name: 'Emerald', value: '#10b981' },
  { name: 'Violet', value: '#8b5cf6' },
  { name: 'Rose Red', value: '#f43f5e' },
];

function ToggleRow({ title, description, checked, onChange, accent }) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <div>
        <div className="font-semibold text-stone-300">{title}</div>
        <div className="text-[10px] text-stone-500">{description}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={title}
        onClick={onChange}
        className="shrink-0 text-stone-400 transition-colors hover:text-white"
      >
        {checked ? <ToggleRight size={28} style={{ color: accent }} /> : <ToggleLeft size={28} />}
      </button>
    </div>
  );
}

export default function AppearanceSettings() {
  const settings = useAppStore((state) => state.settings);
  const updateSetting = useAppStore((state) => state.updateSetting);
  const accent = settings.accentColor || '#3b82f6';

  return (
    <div className="space-y-4">
      <ToggleRow
        title="Dark interface"
        description="Switch between the dark and light theme"
        checked={settings.theme === 'dark'}
        accent={accent}
        onChange={() => updateSetting('theme', settings.theme === 'dark' ? 'light' : 'dark')}
      />
      <ToggleRow
        title="Glass transparency"
        description="Blurred, see-through window background"
        checked={Boolean(settings.transparency)}
        accent={accent}
        onChange={() => updateSetting('transparency', !settings.transparency)}
      />

      {settings.transparency && (
        <div className="space-y-1.5 text-xs">
          <div className="flex justify-between">
            <label htmlFor="window-opacity" className="font-semibold text-stone-300">
              Background opacity
            </label>
            <span className="font-mono text-[10px] text-stone-500">
              {Math.round(settings.windowOpacity * 100)}%
            </span>
          </div>
          <input
            id="window-opacity"
            type="range"
            min="0.5"
            max="1.0"
            step="0.02"
            value={settings.windowOpacity}
            onChange={(event) => updateSetting('windowOpacity', Number(event.target.value))}
            className="h-1 w-full cursor-pointer appearance-none rounded-lg bg-white/5"
            style={{ accentColor: accent }}
          />
        </div>
      )}

      <div className="space-y-1.5 text-xs">
        <div className="font-semibold text-stone-300">Accent colour</div>
        <div className="flex gap-2.5 pt-1">
          {ACCENT_COLORS.map((color) => (
            <button
              key={color.value}
              type="button"
              onClick={() => updateSetting('accentColor', color.value)}
              aria-label={color.name}
              aria-pressed={settings.accentColor === color.value}
              title={color.name}
              className="flex h-6 w-6 items-center justify-center rounded-full border transition-all hover:scale-105 active:scale-95"
              style={{
                backgroundColor: color.value,
                borderColor: settings.accentColor === color.value ? '#ffffff' : 'transparent',
              }}
            >
              {settings.accentColor === color.value && (
                <Check size={11} className="text-black" strokeWidth={3.5} />
              )}
            </button>
          ))}
        </div>
      </div>

      <ToggleRow
        title="Animations"
        description="Smooth transitions and layout motion"
        checked={Boolean(settings.animationsEnabled)}
        accent={accent}
        onChange={() => updateSetting('animationsEnabled', !settings.animationsEnabled)}
      />
      <ToggleRow
        title="Spoken greeting"
        description="Chanakya says its hover greeting aloud"
        checked={Boolean(settings.voiceGreeting)}
        accent={accent}
        onChange={() => updateSetting('voiceGreeting', !settings.voiceGreeting)}
      />

      <div className="mt-2 flex gap-2.5 rounded-xl border border-white/[0.04] bg-[#09090a]/40 p-2.5 text-[10px] leading-4 text-stone-500">
        <ShieldAlert size={14} style={{ color: accent }} className="mt-0.5 shrink-0" />
        <span>
          Chat history, document indexes and diagnostics stay on this computer. No telemetry is
          sent.
        </span>
      </div>
    </div>
  );
}
