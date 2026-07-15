import React, { useEffect } from 'react';
import { motion } from 'framer-motion';
import { Cpu, HardDrive, Zap, RefreshCw, BarChart2, Activity } from 'lucide-react';
import { useAppStore } from '../stores/useAppStore.js';
import { presets } from '../animations/presets.js';

export default function SystemMonitor() {
  const metrics = useAppStore((state) => state.metrics);
  const fetchMetrics = useAppStore((state) => state.fetchMetrics);
  const settings = useAppStore((state) => state.settings);

  const accent = settings.accentColor || '#3b82f6';

  // Poll metrics on mount
  useEffect(() => {
    fetchMetrics();
    const interval = setInterval(() => {
      fetchMetrics();
    }, 2000);
    return () => clearInterval(interval);
  }, [fetchMetrics]);

  // Helper to format bytes to MB/GB
  const formatBytes = (bytes) => {
    if (bytes === 0 || !bytes) return '0 MB';
    const mb = bytes / (1024 * 1024);
    if (mb > 1024) {
      return `${(mb / 1024).toFixed(1)} GB`;
    }
    return `${Math.round(mb)} MB`;
  };

  const getMeterColor = (val) => {
    if (val > 85) return '#ef4444'; // Red
    if (val > 65) return '#f59e0b'; // Amber
    return accent; // Accent theme color
  };

  return (
    <div className="flex flex-col h-full bg-[#0c0c0e]/95 text-stone-200 select-none overflow-y-auto font-sans p-4">
      {/* Title Header */}
      <div className="flex items-center gap-2 border-b border-white/5 pb-3 mb-4 shrink-0">
        <Activity size={16} style={{ color: accent }} />
        <span className="text-xs font-bold uppercase tracking-wider text-stone-300">Chanakya Diagnostics</span>
      </div>

      <div className="flex flex-col gap-4">
        {/* Core Hardware Metrics Grid */}
        <div className="grid grid-cols-2 gap-3">
          {/* CPU Card */}
          <div className="bg-[#141416]/80 border border-white/5 rounded-2xl p-3 flex flex-col gap-2">
            <div className="flex items-center justify-between text-stone-400">
              <span className="text-[10px] uppercase font-bold tracking-wider">CPU Average</span>
              <Cpu size={12} />
            </div>
            <div className="flex items-baseline gap-1 mt-1">
              <span className="text-xl font-bold text-white font-mono">{metrics.cpu || 0}</span>
              <span className="text-[10px] text-stone-500">%</span>
            </div>
            <div className="w-full bg-white/5 h-1.5 rounded-full overflow-hidden mt-1">
              <motion.div
                className="h-full rounded-full"
                animate={{ width: `${metrics.cpu || 0}%`, backgroundColor: getMeterColor(metrics.cpu) }}
                transition={presets.glide}
              />
            </div>
          </div>

          {/* RAM Card */}
          <div className="bg-[#141416]/80 border border-white/5 rounded-2xl p-3 flex flex-col gap-2">
            <div className="flex items-center justify-between text-stone-400">
              <span className="text-[10px] uppercase font-bold tracking-wider">System RAM</span>
              <Activity size={12} />
            </div>
            <div className="flex items-baseline gap-1 mt-1">
              <span className="text-xl font-bold text-white font-mono">{metrics.ram || 0}</span>
              <span className="text-[10px] text-stone-500">%</span>
            </div>
            <div className="w-full bg-white/5 h-1.5 rounded-full overflow-hidden mt-1">
              <motion.div
                className="h-full rounded-full"
                animate={{ width: `${metrics.ram || 0}%`, backgroundColor: getMeterColor(metrics.ram) }}
                transition={presets.glide}
              />
            </div>
          </div>

          {/* GPU Card */}
          <div className="bg-[#141416]/80 border border-white/5 rounded-2xl p-3 flex flex-col gap-2">
            <div className="flex items-center justify-between text-stone-400">
              <span className="text-[10px] uppercase font-bold tracking-wider">GPU Engine</span>
              <BarChart2 size={12} />
            </div>
            <div className="flex items-baseline gap-1 mt-1">
              <span className="text-xl font-bold text-white font-mono">{metrics.gpu || 0}</span>
              <span className="text-[10px] text-stone-500">%</span>
            </div>
            <div className="w-full bg-white/5 h-1.5 rounded-full overflow-hidden mt-1">
              <motion.div
                className="h-full rounded-full"
                animate={{ width: `${metrics.gpu || 0}%`, backgroundColor: getMeterColor(metrics.gpu) }}
                transition={presets.glide}
              />
            </div>
          </div>

          {/* Disk Card */}
          <div className="bg-[#141416]/80 border border-white/5 rounded-2xl p-3 flex flex-col gap-2">
            <div className="flex items-center justify-between text-stone-400">
              <span className="text-[10px] uppercase font-bold tracking-wider">C: Disk Drive</span>
              <HardDrive size={12} />
            </div>
            <div className="flex items-baseline gap-1 mt-1">
              <span className="text-xl font-bold text-white font-mono">{metrics.disk || 0}</span>
              <span className="text-[10px] text-stone-500">%</span>
            </div>
            <div className="w-full bg-white/5 h-1.5 rounded-full overflow-hidden mt-1">
              <motion.div
                className="h-full rounded-full"
                animate={{ width: `${metrics.disk || 0}%`, backgroundColor: getMeterColor(metrics.disk) }}
                transition={presets.glide}
              />
            </div>
          </div>
        </div>

        {/* AI Performance Statistics */}
        <div className="bg-[#141416]/50 border border-white/5 rounded-2xl p-4 flex flex-col gap-3">
          <span className="text-[9px] uppercase font-bold text-stone-500 tracking-widest block">AI Inference performance</span>
          
          <div className="flex items-center justify-between border-b border-white/5 pb-2">
            <div className="flex items-center gap-2">
              <Zap size={13} style={{ color: accent }} />
              <span className="text-xs text-stone-300">Stream Generation Speed</span>
            </div>
            <span className="text-xs font-mono font-bold text-white">
              {metrics.tokensPerSec || 0} <span className="text-[10px] text-stone-500">tok/s</span>
            </span>
          </div>

          <div className="flex items-center justify-between border-b border-white/5 pb-2">
            <div className="flex items-center gap-2">
              <Zap size={13} style={{ color: accent }} />
              <span className="text-xs text-stone-300">First Token Latency</span>
            </div>
            <span className="text-xs font-mono font-bold text-white">
              {metrics.latency || 0} <span className="text-[10px] text-stone-500">ms</span>
            </span>
          </div>

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <RefreshCw size={13} style={{ color: accent }} />
              <span className="text-xs text-stone-300">Process Memory Usage</span>
            </div>
            <span className="text-xs font-mono font-bold text-white">
              {formatBytes(metrics.electronMemory)}
            </span>
          </div>
        </div>

        {/* System Details (Diagnostics information) */}
        <div className="bg-[#141416]/50 border border-white/5 rounded-2xl p-4">
          <span className="text-[9px] uppercase font-bold text-stone-500 tracking-widest block mb-2">Offline Execution Environment</span>
          <div className="flex flex-col gap-1.5 text-[10px] text-stone-400 font-mono">
            <div className="flex justify-between">
              <span>Platform OS:</span>
              <span className="text-stone-300">Windows (Native x64)</span>
            </div>
            <div className="flex justify-between">
              <span>Llama Engine:</span>
              <span className="text-stone-300">Ollama API (Localhost)</span>
            </div>
            <div className="flex justify-between">
              <span>Vector Database:</span>
              <span className="text-stone-300">LanceDB Vector (SQLite fallback)</span>
            </div>
            <div className="flex justify-between">
              <span>Active Agent:</span>
              <span className="text-stone-300 uppercase">Offline Multitasking Core</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
