import React, { Suspense, useEffect } from 'react';
import { useAppStore } from './stores/useAppStore.js';
import ConfirmationModal from './components/ConfirmationModal.jsx';
import AppChoiceModal from './components/AppChoiceModal.jsx';
import SoftwareChoiceModal from './components/SoftwareChoiceModal.jsx';
import { useIdleCollapse } from './hooks/useIdleCollapse.js';

// Lazy load restructured components
const FloatingBubble = React.lazy(() => import('./widget/FloatingBubble.jsx'));
const MainLayout = React.lazy(() => import('./components/MainLayout.jsx'));
const OcrCropModal = React.lazy(() => import('./screen/OcrCropModal.jsx'));

export default function App() {
  const isExpanded = useAppStore((state) => state.isExpanded);
  const toggleExpand = useAppStore((state) => state.toggleExpand);
  const checkAuth = useAppStore((state) => state.checkAuth);
  const fetchModels = useAppStore((state) => state.fetchModels);
  const ocrScreenshot = useAppStore((state) => state.ocrScreenshot);
  const setInputText = useAppStore((state) => state.setInputText);
  const showClipboardToast = useAppStore((state) => state.showClipboardToast);
  const addConfirmation = useAppStore((state) => state.addConfirmation);
  const [executionProgress, setExecutionProgress] = React.useState({});
  const progressUserId = useAppStore((state) => state.user?.id);
  useEffect(() => setExecutionProgress({}), [progressUserId]);
  const accentColor = useAppStore((state) => state.settings.accentColor) || '#3b82f6';
  const user = useAppStore((state) => state.user);
  const previousUser = React.useRef(null);

  useIdleCollapse();

  // Sign-in happens in the small window; once signed in the app goes full
  // screen, and signing out returns to the small window for the login form.
  // A session restored while the app is still a bubble must not pop it open —
  // it only decides what the bubble opens into.
  useEffect(() => {
    const wasSignedIn = !!previousUser.current;
    previousUser.current = user;
    const state = useAppStore.getState();
    if (user && !wasSignedIn) {
      if (state.isExpanded) state.setWindowMode('full');
      else useAppStore.setState({ lastExpandedMode: 'full' });
    } else if (!user && wasSignedIn && state.windowMode === 'full') {
      state.setWindowMode('compact');
    }
  }, [user]);

  // Per-request keepAlive settings control residency. Collapsing the GUI must
  // never unload Ollama models used by indexing or another local application.

  useEffect(
    () =>
      window.toolEngine?.onProgress?.((progress) => {
        const userId = useAppStore.getState().user?.id;
        if (!userId || !progress.scope?.startsWith(`renderer:${userId}-`) || !progress.requestId)
          return;
        setExecutionProgress((previous) => {
          const next = { ...previous };
          if (progress.stage === 'complete') delete next[progress.requestId];
          else next[progress.requestId] = progress.message;
          return Object.fromEntries(Object.entries(next).slice(-8));
        });
      }),
    [],
  );

  useEffect(() => {
    checkAuth();
    fetchModels();

    if (window.electronAPI) {
      // Register wake word listener
      const unsubscribeWake = window.electronAPI.onWakewordDetected((data) => {
        console.log('[App] Wake word detected:', data);
        if (!useAppStore.getState().isExpanded) {
          toggleExpand();
        }
        window.electronAPI.showNotification('Chanakya AI', 'Chanakya is activated and listening.');
      });

      // Register clipboard monitoring listener
      const unsubscribeClip = window.electronAPI.onClipboardChanged((text) => {
        console.log('[App] Clipboard text changed');
        if (text && text.trim().length > 3) {
          showClipboardToast(text.trim());
        }
      });

      // The main process owns the real window layout; follow it, and pick up
      // the mode it started in (full screen) in case it changed before we mounted.
      const unsubscribeMode = window.electronAPI.onWindowModeChanged((mode) =>
        useAppStore.getState().syncWindowMode(mode),
      );
      window.electronAPI
        .getWindowMode()
        .then((mode) => useAppStore.getState().syncWindowMode(mode))
        .catch(() => {});

      return () => {
        unsubscribeWake();
        unsubscribeClip();
        unsubscribeMode();
      };
    }
  }, [checkAuth, fetchModels, toggleExpand, showClipboardToast, addConfirmation]);

  return (
    <Suspense
      fallback={
        <div
          className={`w-screen h-screen flex flex-col items-center justify-center text-white select-none ${
            isExpanded ? 'bg-[#09090a]' : 'bg-transparent'
          }`}
        >
          <div className="h-10 w-10 animate-spin rounded-full border-2 border-blue-500/20 border-t-blue-500" />
          {isExpanded && (
            <div className="mt-4 text-[10px] uppercase font-bold tracking-widest text-stone-500 animate-pulse font-mono">
              Chanakya AI Desktop Assistant
            </div>
          )}
        </div>
      }
    >
      <div
        className={`relative w-screen h-screen overflow-clip flex items-center justify-center ${
          isExpanded ? 'bg-[#060608] noise' : 'bg-transparent'
        }`}
      >
        {/* Soft neon ambient orbs — only in the chat window. In bubble mode the
            window is 80px, so these would just paint a dark square behind the
            floating avatar. */}
        {isExpanded && (
          <>
            <div className="orb-glow -top-32 -left-32" style={{ background: accentColor }} />
            <div className="orb-glow -bottom-32 -right-32" style={{ background: '#7c3aed' }} />
          </>
        )}

        {isExpanded ? <MainLayout /> : <FloatingBubble />}

        {ocrScreenshot && (
          <OcrCropModal
            onSuccess={(text) => {
              setInputText(text);
              if (!useAppStore.getState().isExpanded) {
                toggleExpand();
              }
            }}
          />
        )}

        <AppChoiceModal />
        <SoftwareChoiceModal />
        <ConfirmationModal />
        {Object.values(executionProgress).length > 0 && (
          <div
            role="status"
            aria-live="polite"
            className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-xl border border-blue-400/30 bg-stone-950 px-4 py-3 text-sm text-stone-200 shadow-lg"
          >
            {Object.entries(executionProgress).map(([id, message]) => (
              <p key={id}>{message}</p>
            ))}
          </div>
        )}
      </div>
    </Suspense>
  );
}
