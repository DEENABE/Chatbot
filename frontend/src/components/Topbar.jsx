import React, { useEffect, useState } from 'react';
import { percentValue, executionModeLabel } from '../utils/metricsDisplay.js';
import { ChevronDown, Circle, BarChart2 } from 'lucide-react';
import WindowControls from './WindowControls.jsx';
import { useAppStore } from '../stores/useAppStore.js';
import { useNavStore } from '../stores/useNavStore.js';
import { presets } from '../animations/presets.js';

export default function Topbar({ section = 'Chat' }) {
  const tab = useNavStore((state) => state.tab);
  const setTab = useNavStore((state) => state.setTab);
  const models = useAppStore((state) => state.models);
  const selectedModelId = useAppStore((state) => state.selectedModelId);
  const selectModel = useAppStore((state) => state.selectModel);
  const fetchModels = useAppStore((state) => state.fetchModels);
  const isModelsLoading = useAppStore((state) => state.isModelsLoading);

  const windowMode = useAppStore((state) => state.windowMode);
  const selectedAgentProfile = useAppStore((state) => state.selectedAgentProfile);
  const selectAgentProfile = useAppStore((state) => state.selectAgentProfile);

  const settings = useAppStore((state) => state.settings);

  const metrics = useAppStore((state) => state.metrics);
  const fetchMetrics = useAppStore((state) => state.fetchMetrics);

  const [showMetricsPanel, setShowMetricsPanel] = useState(false);

  // Poll metrics every 3 seconds
  useEffect(() => {
    fetchModels();
    fetchMetrics();
    const interval = setInterval(() => {
      fetchMetrics();
    }, 3000);
    return () => clearInterval(interval);
  }, [fetchModels, fetchMetrics]);

  const handleModelChange = (e) => {
    selectModel(e.target.value);
  };

  const currentModel = models.find((m) => m.id === selectedModelId);
  const accent = settings.accentColor || '#3b82f6';
  const themeDark = settings.theme === 'dark';

  // Drag window handler for custom borderless title bar
  const handleHeaderMouseDown = (e) => {
    // Avoid dragging when clicking select inputs or window buttons
    const target = e.target;
    if (windowMode === 'full' || target.closest('select') || target.closest('button')) return;

    if (window.electronAPI) {
      window.electronAPI.dragStart();
      const onMouseMove = () => window.electronAPI.dragMove();
      const onMouseUp = () => {
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
        window.electronAPI.dragEnd();
      };
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    }
  };

  return (
    <header
      onMouseDown={handleHeaderMouseDown}
      className={`flex h-14 shrink-0 items-center justify-between gap-2 border-b border-white/[0.05] px-3 sm:px-4 select-none relative ${windowMode === 'full' ? '' : 'cursor-move'}`}
      style={{
        background: themeDark ? 'rgba(20, 20, 22, 0.4)' : 'rgba(255, 255, 255, 0.4)',
      }}
    >
      {/* Title & Info */}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="text-sm font-bold text-stone-100 truncate tracking-tight">Chanakya AI</h1>
          <span
            className="hidden shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider min-[560px]:inline-flex"
            style={{ borderColor: `${accent}40`, color: accent }}
            title="Runs on this computer — no cloud connection needed"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            Local AI
          </span>
        </div>
        <p className="text-[10px] text-stone-500 truncate mt-0.5">{section}</p>
      </div>

      {['chat', 'coding'].includes(tab) && (
        <nav
          aria-label="Assistant mode"
          className="flex shrink-0 rounded-lg border border-white/10 bg-black/20 p-0.5"
        >
          {[
            ['chat', 'Chat'],
            ['coding', 'Code'],
          ].map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-current={tab === id ? 'page' : undefined}
              onClick={() => setTab(id)}
              className={`rounded-md px-2.5 py-1.5 text-xs transition-colors ${tab === id ? 'bg-white/10 text-white' : 'text-stone-500 hover:text-white'}`}
            >
              {label}
            </button>
          ))}
        </nav>
      )}
      {/* Model Selection and Controls */}
      <div className="flex shrink-0 items-center gap-1 sm:gap-2">
        {/* Performance Hover Diagnostics */}
        <div
          className="relative hidden sm:block"
          onMouseEnter={() => setShowMetricsPanel(true)}
          onMouseLeave={() => setShowMetricsPanel(false)}
        >
          <button className="flex h-8 w-8 items-center justify-center rounded-xl hover:bg-white/5 text-stone-400 hover:text-white transition-colors cursor-pointer">
            <BarChart2 size={14} />
          </button>

          {/* Popover dashboard */}
          {showMetricsPanel && (
            <div className="absolute right-0 top-9 w-48 rounded-xl border border-white/[0.08] bg-[#121214] p-3 shadow-xl z-50 space-y-2">
              <div className="text-[9px] font-bold uppercase tracking-widest text-stone-500 mb-1 border-b border-white/5 pb-1">
                Active System Metrics
              </div>
              <div className="flex justify-between text-xs text-stone-400">
                <span>CPU Load:</span>
                <span className="font-semibold text-white">{percentValue(metrics.cpu)}</span>
              </div>
              <div className="flex justify-between text-xs text-stone-400">
                <span>RAM Usage:</span>
                <span className="font-semibold text-white">{percentValue(metrics.ram)}</span>
              </div>
              <div className="flex justify-between text-xs text-stone-400">
                <span>GPU Usage:</span>
                <span className="font-semibold text-white" title={metrics.gpuUnavailableReason}>
                  {percentValue(metrics.gpu)}
                </span>
              </div>
              <div className="flex justify-between text-xs text-stone-400">
                <span>Disk Drive:</span>
                <span className="font-semibold text-white">{percentValue(metrics.disk)}</span>
              </div>
              <div className="flex justify-between gap-2 text-[10px] text-stone-400">
                <span>AI device:</span>
                <span className="font-semibold text-white text-right">
                  {executionModeLabel(metrics.acceleration)}
                </span>
              </div>
              {metrics.tokensPerSec > 0 && (
                <div className="border-t border-white/5 pt-1.5 mt-1.5 space-y-1">
                  <div className="flex justify-between text-[10px] text-stone-400">
                    <span>Speed:</span>
                    <span className="font-semibold" style={{ color: accent }}>
                      {metrics.tokensPerSec} t/s
                    </span>
                  </div>
                  <div className="flex justify-between text-[10px] text-stone-400">
                    <span>Latency:</span>
                    <span className="font-semibold" style={{ color: accent }}>
                      {metrics.latency}ms
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Agent Persona dropdown */}
        <div className={`relative items-center ${tab === 'coding' ? 'hidden' : 'flex'}`}>
          <select
            value={selectedAgentProfile}
            onChange={(e) => selectAgentProfile(e.target.value)}
            className="w-[6.75rem] appearance-none truncate rounded-xl border border-white/10 bg-[#09090a]/80 py-1.5 pl-2.5 pr-7 text-xs text-stone-200 outline-none cursor-pointer sm:w-auto sm:pl-3 sm:pr-8"
            style={{
              borderColor: 'rgba(255,255,255,0.08)',
              focusBorderColor: accent,
            }}
            title="Choose active agent"
          >
            <option value="default">Chanakya Core</option>
            <option value="coder">Coder Agent</option>
            <option value="writer">Writer Agent</option>
            <option value="analyst">Analyst Agent</option>
          </select>
          <ChevronDown
            size={11}
            className="pointer-events-none absolute right-2.5 text-stone-500"
          />
        </div>

        <span
          className="hidden min-w-0 truncate text-[10px] text-stone-500 lg:inline"
          title="Model routes are selected in Settings"
        >
          Automatic model routing
        </span>

        {/* Status indicator */}
        <div className="hidden items-center gap-1 px-1 sm:flex">
          <Circle
            size={6}
            fill={currentModel?.installed ? 'currentColor' : 'transparent'}
            className={
              currentModel?.installed
                ? 'text-emerald-500'
                : 'text-amber-500 border border-amber-500 rounded-full'
            }
          />
        </div>

        <hr className="mx-1 hidden h-4 border-l border-white/5 sm:block" />

        {/* Window controls */}
        <WindowControls />
      </div>
    </header>
  );
}
