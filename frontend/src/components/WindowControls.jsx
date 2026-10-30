import React from 'react';
import { Minus, Maximize2, Minimize2, CircleDot, X } from 'lucide-react';
import { useAppStore } from '../stores/useAppStore.js';

const buttonClass =
  'h-7 w-7 flex items-center justify-center rounded-lg text-stone-500 transition-colors cursor-pointer';

/**
 * Minimize, full-screen/windowed, bubble and close for the frameless window.
 * Shared by the top bar and the sign-in screen so the window is never without
 * a way to be minimized or closed. Renders nothing outside the desktop app.
 */
export default function WindowControls({ className = '' }) {
  const windowMode = useAppStore((state) => state.windowMode);
  const setWindowMode = useAppStore((state) => state.setWindowMode);
  const toggleWindowSize = useAppStore((state) => state.toggleWindowSize);

  if (!window.electronAPI) return null;

  const isFull = windowMode === 'full';

  return (
    <div className={`flex shrink-0 items-center gap-0.5 ${className}`}>
      <button
        type="button"
        onClick={() => window.electronAPI.minimize()}
        className={`${buttonClass} hover:bg-white/5 hover:text-white`}
        title="Minimize"
        aria-label="Minimize"
      >
        <Minus size={14} />
      </button>

      <button
        type="button"
        onClick={() => setWindowMode('bubble')}
        className={`${buttonClass} hover:bg-white/5 hover:text-white`}
        title="Collapse to bubble"
        aria-label="Collapse to bubble"
      >
        <CircleDot size={13} />
      </button>

      <button
        type="button"
        onClick={() => toggleWindowSize()}
        className={`${buttonClass} hover:bg-white/5 hover:text-white`}
        title={isFull ? 'Switch to windowed' : 'Switch to full screen'}
        aria-label={isFull ? 'Switch to windowed' : 'Switch to full screen'}
      >
        {isFull ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
      </button>

      <button
        type="button"
        onClick={() => window.electronAPI.close()}
        className={`${buttonClass} hover:bg-red-500/20 hover:text-red-400`}
        title="Close"
        aria-label="Close"
      >
        <X size={14} />
      </button>
    </div>
  );
}
