import { useEffect } from 'react';
import { useAppStore } from '../stores/useAppStore.js';
import { shouldCollapse } from './idlePolicy.js';

const ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart'];
const CHECK_INTERVAL_MS = 10 * 1000;

/**
 * Shrinks the full-screen or windowed app back to the bubble after a stretch
 * with no mouse or keyboard use. Desktop app only.
 */
export function useIdleCollapse() {
  const isExpanded = useAppStore((state) => state.isExpanded);

  useEffect(() => {
    if (!isExpanded || !window.electronAPI) return undefined;

    let lastActivity = Date.now();
    const markActive = () => {
      lastActivity = Date.now();
    };
    ACTIVITY_EVENTS.forEach((name) => window.addEventListener(name, markActive, { passive: true }));

    const timer = setInterval(() => {
      const state = useAppStore.getState();
      const busy =
        state.isGenerating ||
        state.pendingConfirmations.length > 0 ||
        !!state.ocrScreenshot ||
        document.hidden;
      if (shouldCollapse({ idleMs: Date.now() - lastActivity, busy })) {
        state.setWindowMode('bubble');
      }
    }, CHECK_INTERVAL_MS);

    return () => {
      clearInterval(timer);
      ACTIVITY_EVENTS.forEach((name) => window.removeEventListener(name, markActive));
    };
  }, [isExpanded]);
}
