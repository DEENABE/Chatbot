import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { X, Check, ToggleLeft, ToggleRight, ShieldAlert } from 'lucide-react';
import { useAppStore } from '../stores/useAppStore.js';
import { presets } from '../animations/presets.js';

const ACCENT_COLORS = [
  { name: 'Sky Blue', value: '#3b82f6' },
  { name: 'Gold Accent', value: '#bd9134' },
  { name: 'Emerald', value: '#10b981' },
  { name: 'Violet', value: '#8b5cf6' },
  { name: 'Rose Red', value: '#f43f5e' }
];

export default function SettingsModal({ open, onClose }) {
  const settings = useAppStore((state) => state.settings);
  const updateSetting = useAppStore((state) => state.updateSetting);

  const accent = settings.accentColor || '#3b82f6';

  return (
    <AnimatePresence>
      {open && (
        <motion.div 
          initial={{ opacity: 0 }} 
          animate={{ opacity: 1 }} 
          exit={{ opacity: 0 }} 
          className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 backdrop-blur-sm select-none"
          onMouseDown={(e) => e.target === e.currentTarget && onClose()}
        >
          <motion.div 
            initial={{ scale: 0.96, opacity: 0 }} 
            animate={{ scale: 1, opacity: 1 }} 
            exit={{ scale: 0.96, opacity: 0 }}
            className="w-full max-w-sm rounded-2xl border border-white/[0.06] bg-[#121214] p-5 shadow-2xl backdrop-blur-xl"
            transition={presets.appleBounce}
          >
            {/* Header */}
            <div className="flex justify-between items-center mb-4 pb-2 border-b border-white/5">
              <div>
                <h3 className="text-xs font-bold text-stone-200 uppercase tracking-wide">Chanakya Preferences</h3>
                <p className="text-[9px] text-stone-500 mt-0.5">Customize your offline desktop AI assistant.</p>
              </div>
              <button onClick={onClose} className="text-stone-500 hover:text-stone-300 transition-colors">
                <X size={15} />
              </button>
            </div>

            {/* Settings Options */}
            <div className="space-y-4">
              {/* Theme Toggle */}
              <div className="flex justify-between items-center text-xs">
                <div>
                  <div className="font-semibold text-stone-300">Dark Interface Mode</div>
                  <div className="text-[9px] text-stone-500">Toggle light or dark theme interface</div>
                </div>
                <button
                  type="button"
                  onClick={() => updateSetting('theme', settings.theme === 'dark' ? 'light' : 'dark')}
                  className="text-stone-400 hover:text-white transition-colors"
                >
                  {settings.theme === 'dark' ? (
                    <ToggleRight size={28} style={{ color: accent }} />
                  ) : (
                    <ToggleLeft size={28} />
                  )}
                </button>
              </div>

              {/* Glassmorphism Toggles */}
              <div className="flex justify-between items-center text-xs">
                <div>
                  <div className="font-semibold text-stone-300">Glassmorphism Transparency</div>
                  <div className="text-[9px] text-stone-500">Enable premium blurred window borders</div>
                </div>
                <button
                  type="button"
                  onClick={() => updateSetting('transparency', !settings.transparency)}
                  className="text-stone-400 hover:text-white transition-colors"
                >
                  {settings.transparency ? (
                    <ToggleRight size={28} style={{ color: accent }} />
                  ) : (
                    <ToggleLeft size={28} />
                  )}
                </button>
              </div>

              {/* Window Opacity slider */}
              {settings.transparency && (
                <div className="space-y-1.5 text-xs">
                  <div className="flex justify-between">
                    <span className="font-semibold text-stone-300">Background Opacity</span>
                    <span className="text-[9px] text-stone-500 font-mono">{Math.round(settings.windowOpacity * 100)}%</span>
                  </div>
                  <input
                    type="range"
                    min="0.5"
                    max="1.0"
                    step="0.02"
                    value={settings.windowOpacity}
                    onChange={(e) => updateSetting('windowOpacity', Number(e.target.value))}
                    className="w-full h-1 bg-white/5 rounded-lg appearance-none cursor-pointer"
                    style={{ accentColor: accent }}
                  />
                </div>
              )}

              {/* Accent Color picker */}
              <div className="space-y-1.5 text-xs">
                <div className="font-semibold text-stone-300">Interface Accent Color</div>
                <div className="flex gap-2.5 pt-1">
                  {ACCENT_COLORS.map((c) => (
                    <button
                      key={c.value}
                      type="button"
                      onClick={() => updateSetting('accentColor', c.value)}
                      className="w-5 h-5 rounded-full flex items-center justify-center border transition-all hover:scale-105 active:scale-95"
                      style={{
                        backgroundColor: c.value,
                        borderColor: settings.accentColor === c.value ? '#ffffff' : 'transparent'
                      }}
                      title={c.name}
                    >
                      {settings.accentColor === c.value && (
                        <Check size={10} className="text-black" strokeWidth={3.5} />
                      )}
                    </button>
                  ))}
                </div>
              </div>

              {/* Smooth Animations */}
              <div className="flex justify-between items-center text-xs">
                <div>
                  <div className="font-semibold text-stone-300">Framer Animations</div>
                  <div className="text-[9px] text-stone-500">Enable premium easing and layout transitions</div>
                </div>
                <button
                  type="button"
                  onClick={() => updateSetting('animationsEnabled', !settings.animationsEnabled)}
                  className="text-stone-400 hover:text-white transition-colors"
                >
                  {settings.animationsEnabled ? (
                    <ToggleRight size={28} style={{ color: accent }} />
                  ) : (
                    <ToggleLeft size={28} />
                  )}
                </button>
              </div>

              {/* Offline Security Notice */}
              <div className="flex gap-2.5 rounded-xl border border-white/[0.04] bg-[#09090a]/40 p-2.5 text-[9px] text-stone-500 leading-4 mt-2">
                <ShieldAlert size={14} style={{ color: accent }} className="shrink-0 mt-0.5" />
                <span>All chat histories, vector embeddings, and diagnostics remain stored 100% locally. Zero telemetry data is transmitted.</span>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
