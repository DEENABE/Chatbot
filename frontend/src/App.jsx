import React, { Suspense, useEffect } from 'react';
import { useAppStore } from './stores/useAppStore.js';
import ConfirmationModal from './components/ConfirmationModal.jsx';

// Lazy load restructured components
const FloatingBubble = React.lazy(() => import('./widget/FloatingBubble.jsx'));
const MainLayout = React.lazy(() => import('./components/MainLayout.jsx'));
const OcrCropModal = React.lazy(() => import('./screen/OcrCropModal.jsx'));

export default function App() {
  const isExpanded = useAppStore((state) => state.isExpanded);
  const toggleExpand = useAppStore((state) => state.toggleExpand);
  const checkAuth = useAppStore((state) => state.checkAuth);
  const fetchModels = useAppStore((state) => state.fetchModels);
  const unloadIdleModel = useAppStore((state) => state.unloadIdleModel);
  const ocrScreenshot = useAppStore((state) => state.ocrScreenshot);
  const setInputText = useAppStore((state) => state.setInputText);
  const showClipboardToast = useAppStore((state) => state.showClipboardToast);
  const addConfirmation = useAppStore((state) => state.addConfirmation);
  const accentColor = useAppStore((state) => state.settings.accentColor) || '#3b82f6';

  // Free the model from memory when the assistant is collapsed to the bubble
  // (with a short grace period in case the user reopens it right away).
  useEffect(() => {
    if (isExpanded) return;
    const timer = setTimeout(() => unloadIdleModel(), 3000);
    return () => clearTimeout(timer);
  }, [isExpanded, unloadIdleModel]);

  // Also free memory when the window is hidden / minimized.
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) unloadIdleModel();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [unloadIdleModel]);

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
      
      return () => {
        unsubscribeWake();
        unsubscribeClip();
      };
    }
  }, [checkAuth, fetchModels, toggleExpand, showClipboardToast, addConfirmation]);

  return (
    <Suspense
      fallback={
        <div className="w-screen h-screen flex flex-col items-center justify-center bg-[#09090a] text-white select-none">
          <div className="h-10 w-10 animate-spin rounded-full border-2 border-blue-500/20 border-t-blue-500 mb-4" />
          <div className="text-[10px] uppercase font-bold tracking-widest text-stone-500 animate-pulse font-mono">
            Chanakya AI Desktop Assistant
          </div>
        </div>
      }
    >
      <div className="relative w-screen h-screen overflow-hidden bg-[#060608] flex items-center justify-center noise">
        {/* Soft neon ambient orbs */}
        <div className="orb-glow -top-32 -left-32" style={{ background: accentColor }} />
        <div className="orb-glow -bottom-32 -right-32" style={{ background: '#7c3aed' }} />

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
        
        <ConfirmationModal />
      </div>
    </Suspense>
  );
}
