import React, { useEffect, useState } from 'react';
import { ChevronDown, Circle, Settings, Minimize2, Square, X, BarChart2 } from 'lucide-react';
import { useAppStore } from '../stores/useAppStore.js';
import { presets } from '../animations/presets.js';

export default function Topbar() {
  const models = useAppStore((state) => state.models);
  const selectedModelId = useAppStore((state) => state.selectedModelId);
  const selectModel = useAppStore((state) => state.selectModel);
  const fetchModels = useAppStore((state) => state.fetchModels);
  const isModelsLoading = useAppStore((state) => state.isModelsLoading);
  
  const toggleExpand = useAppStore((state) => state.toggleExpand);
  const collapseToBubble = useAppStore((state) => state.collapseToBubble);
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

  // Both actions shrink the window back to the bubble in the main process, so
  // mirror that in the store to keep the rendered view in sync on restore.
  const handleMinimize = () => {
    if (window.electronAPI) window.electronAPI.minimize();
    collapseToBubble();
  };

  const handleClose = () => {
    if (window.electronAPI) window.electronAPI.close();
    collapseToBubble();
  };

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
    if (target.closest('select') || target.closest('button')) return;

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
      className="flex h-14 shrink-0 items-center justify-between border-b border-white/[0.05] px-4 select-none relative cursor-move"
      style={{ background: themeDark ? 'rgba(20, 20, 22, 0.4)' : 'rgba(255, 255, 255, 0.4)' }}
    >
      {/* Title & Info */}
      <div className="min-w-0">
        <h1 className="text-xs font-bold text-stone-300 truncate uppercase tracking-wider">Chanakya Workspace</h1>
        <p className="text-[9px] text-stone-500 truncate mt-0.5 font-mono">100% offline intelligence</p>
      </div>

      {/* Model Selection and Controls */}
      <div className="flex items-center gap-2">
        {/* Performance Hover Diagnostics */}
        <div 
          className="relative"
          onMouseEnter={() => setShowMetricsPanel(true)}
          onMouseLeave={() => setShowMetricsPanel(false)}
        >
          <button 
            className="flex h-8 w-8 items-center justify-center rounded-xl hover:bg-white/5 text-stone-400 hover:text-white transition-colors cursor-pointer"
          >
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
                <span className="font-semibold text-white">{metrics.cpu}%</span>
              </div>
              <div className="flex justify-between text-xs text-stone-400">
                <span>RAM Usage:</span>
                <span className="font-semibold text-white">{metrics.ram}%</span>
              </div>
              <div className="flex justify-between text-xs text-stone-400">
                <span>GPU Usage:</span>
                <span className="font-semibold text-white">{metrics.gpu}%</span>
              </div>
              <div className="flex justify-between text-xs text-stone-400">
                <span>Disk Drive:</span>
                <span className="font-semibold text-white">{metrics.disk}%</span>
              </div>
              {metrics.tokensPerSec > 0 && (
                <div className="border-t border-white/5 pt-1.5 mt-1.5 space-y-1">
                  <div className="flex justify-between text-[10px] text-stone-400">
                    <span>Speed:</span>
                    <span className="font-semibold" style={{ color: accent }}>{metrics.tokensPerSec} t/s</span>
                  </div>
                  <div className="flex justify-between text-[10px] text-stone-400">
                    <span>Latency:</span>
                    <span className="font-semibold" style={{ color: accent }}>{metrics.latency}ms</span>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Agent Persona dropdown */}
        <div className="relative flex items-center">
          <select 
            value={selectedAgentProfile} 
            onChange={(e) => selectAgentProfile(e.target.value)}
            className="appearance-none rounded-xl border border-white/10 bg-[#09090a]/80 py-1.5 pl-3 pr-8 text-xs text-stone-200 outline-none cursor-pointer"
            style={{ 
              borderColor: 'rgba(255,255,255,0.08)',
              focusBorderColor: accent 
            }}
            title="Choose active agent"
          >
            <option value="default">Chanakya Core</option>
            <option value="coder">Coder Agent</option>
            <option value="writer">Writer Agent</option>
            <option value="analyst">Analyst Agent</option>
          </select>
          <ChevronDown size={11} className="pointer-events-none absolute right-2.5 text-stone-500" />
        </div>

        {/* Local Model dropdown */}
        <div className="relative flex items-center">
          <select 
            value={selectedModelId} 
            onChange={handleModelChange}
            className="appearance-none rounded-xl border border-white/10 bg-[#09090a]/80 py-1.5 pl-3 pr-8 text-xs text-stone-200 outline-none cursor-pointer"
            style={{ 
              borderColor: 'rgba(255,255,255,0.08)',
              focusBorderColor: accent 
            }}
          >
            {models.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label} {!item.installed ? ' (Not Pulled)' : ''}
              </option>
            ))}
          </select>
          <ChevronDown size={11} className="pointer-events-none absolute right-2.5 text-stone-500" />
        </div>

        {/* Status indicator */}
        <div className="flex items-center gap-1 px-1">
          <Circle 
            size={6} 
            fill={currentModel?.installed ? 'currentColor' : 'transparent'} 
            className={currentModel?.installed ? 'text-emerald-500' : 'text-amber-500 border border-amber-500 rounded-full'} 
          />
        </div>

        <hr className="h-4 border-l border-white/5 mx-1" />

        {/* Window controls */}
        <div className="flex items-center gap-0.5">
          <button 
            onClick={handleMinimize}
            className="h-7 w-7 flex items-center justify-center rounded-lg hover:bg-white/5 text-stone-500 hover:text-white transition-colors cursor-pointer"
            title="Minimize"
          >
            <Minimize2 size={13} />
          </button>
          
          <button 
            onClick={() => toggleExpand()}
            className="h-7 w-7 flex items-center justify-center rounded-lg hover:bg-white/5 text-stone-500 hover:text-white transition-colors cursor-pointer"
            title="Collapse to Bubble"
          >
            <Square size={11} />
          </button>
          
          <button 
            onClick={handleClose}
            className="h-7 w-7 flex items-center justify-center rounded-lg hover:bg-red-500/20 text-stone-500 hover:text-red-400 transition-colors cursor-pointer"
            title="Hide window"
          >
            <X size={14} />
          </button>
        </div>
      </div>
    </header>
  );
}
