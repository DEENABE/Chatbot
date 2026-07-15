import React, { Suspense, useState, useRef } from 'react';
import { useAppStore } from '../stores/useAppStore.js';

const LoginScreen = React.lazy(() => import('./LoginScreen.jsx'));
const Sidebar = React.lazy(() => import('../sidebar/Sidebar.jsx'));
const Topbar = React.lazy(() => import('./Topbar.jsx'));
const ChatArea = React.lazy(() => import('../chat/ChatArea.jsx'));
const InputArea = React.lazy(() => import('../chat/InputArea.jsx'));

export default function MainLayout() {
  const user = useAppStore((state) => state.user);
  const settings = useAppStore((state) => state.settings);
  const [activeTab, setActiveTab] = useState('chat'); // 'chat', 'documents', 'memories', 'diagnostics'
  const resizeRef = useRef(null);

  if (!user) {
    return (
      <Suspense fallback={<div className="text-white text-center p-10 text-xs font-mono uppercase tracking-widest animate-pulse">Checking credentials...</div>}>
        <LoginScreen />
      </Suspense>
    );
  }

  // Handle Electron window resizing via custom border-drag handles
  const startResize = (e, direction) => {
    e.preventDefault();
    if (!window.electronAPI) return;

    const w = window.innerWidth;
    const h = window.innerHeight;

    resizeRef.current = {
      startX: e.screenX,
      startY: e.screenY,
      startW: w,
      startH: h
    };

    const handleMouseMove = (moveEvent) => {
      if (!resizeRef.current) return;
      const deltaX = moveEvent.screenX - resizeRef.current.startX;
      const deltaY = moveEvent.screenY - resizeRef.current.startY;

      let newW = resizeRef.current.startW;
      let newH = resizeRef.current.startH;

      if (direction === 'se') {
        newW = Math.max(380, resizeRef.current.startW + deltaX);
        newH = Math.max(500, resizeRef.current.startH + deltaY);
      } else if (direction === 's') {
        newH = Math.max(500, resizeRef.current.startH + deltaY);
      } else if (direction === 'w') {
        newW = Math.max(380, resizeRef.current.startW + deltaX);
      }

      window.electronAPI.resize(newW, newH);
    };

    const handleMouseUp = () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      resizeRef.current = null;
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  const accent = settings.accentColor || '#3b82f6';
  const glassBg = settings.transparency 
    ? `rgba(${settings.theme === 'dark' ? '14, 14, 16' : '240, 240, 243'}, ${settings.windowOpacity})`
    : settings.theme === 'dark' ? '#0c0c0e' : '#ffffff';

  return (
    <div 
      className="w-screen h-screen flex flex-col overflow-hidden relative select-none rounded-2xl border"
      style={{
        background: glassBg,
        borderColor: `${accent}20`,
        color: settings.theme === 'dark' ? '#f5f5f7' : '#1c1c1e',
        backdropFilter: settings.transparency ? 'blur(16px)' : 'none',
        WebkitBackdropFilter: settings.transparency ? 'blur(16px)' : 'none',
      }}
    >
      <div className="flex flex-1 overflow-hidden relative">
        <Suspense fallback={<div className="w-64 border-r border-white/5 animate-pulse bg-[#0c0c0e]/50" />}>
          <Sidebar activeTab={activeTab} setActiveTab={setActiveTab} />
        </Suspense>

        <div className="flex-1 flex flex-col overflow-hidden relative">
          <Suspense fallback={<div className="h-14 border-b border-white/5 animate-pulse bg-zinc-900/50" />}>
            <Topbar />
          </Suspense>

          <div className="flex-1 overflow-hidden relative">
            <Suspense fallback={
              <div className="w-full h-full flex flex-col items-center justify-center text-xs text-stone-500 uppercase tracking-widest animate-pulse">
                <span>Synchronizing workspace...</span>
              </div>
            }>
              <ChatArea activeTab={activeTab} />
            </Suspense>
          </div>

          {activeTab === 'chat' && (
            <Suspense fallback={<div className="h-20 animate-pulse bg-zinc-900/30" />}>
              <InputArea />
            </Suspense>
          )}
        </div>
      </div>

      {/* Resize corner and edge drag handles */}
      <div 
        onMouseDown={(e) => startResize(e, 'se')}
        className="absolute bottom-0 right-0 w-4 h-4 cursor-se-resize z-50 flex items-end justify-end p-0.5 pointer-events-auto"
      >
        <svg width="8" height="8" viewBox="0 0 8 8" className="opacity-45" style={{ fill: accent }}>
          <path d="M6 0l2 2-6 6h-2v-2z" />
        </svg>
      </div>
      <div 
        onMouseDown={(e) => startResize(e, 's')}
        className="absolute bottom-0 left-4 right-4 h-1.5 cursor-s-resize z-50"
      />
    </div>
  );
}
