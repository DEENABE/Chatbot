import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Brain, Trash2, Plus, Search, HelpCircle, ShieldCheck, X, LoaderCircle } from 'lucide-react';
import { useAppStore } from '../stores/useAppStore.js';
import { presets } from '../animations/presets.js';

export default function MemoryPanel() {
  const memories = useAppStore((state) => state.memories);
  const isMemoriesLoading = useAppStore((state) => state.isMemoriesLoading);
  const fetchMemories = useAppStore((state) => state.fetchMemories);
  const addMemory = useAppStore((state) => state.addMemory);
  const deleteMemory = useAppStore((state) => state.deleteMemory);
  const clearMemories = useAppStore((state) => state.clearMemories);
  const settings = useAppStore((state) => state.settings);

  const [searchQuery, setSearchQuery] = useState('');
  const [newMemoryText, setNewMemoryText] = useState('');
  const [memoryType, setMemoryType] = useState('project'); // 'project' or 'general'
  const [isAdding, setIsAdding] = useState(false);

  const accent = settings.accentColor || '#3b82f6';

  // Fetch memories on mount
  useEffect(() => {
    fetchMemories();
  }, [fetchMemories]);

  const handleAddMemory = async (e) => {
    e.preventDefault();
    if (!newMemoryText.trim()) return;
    try {
      await addMemory(newMemoryText.trim(), memoryType);
      setNewMemoryText('');
      setIsAdding(false);
    } catch (err) {
      console.error('Failed to add memory:', err);
    }
  };

  const filteredMemories = memories.filter((m) =>
    (m.content || '').toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="flex flex-col h-full bg-[#0c0c0e]/95 text-stone-200 select-none font-sans overflow-hidden">
      {/* Title Header */}
      <div className="flex items-center justify-between border-b border-white/5 p-4 shrink-0">
        <div className="flex items-center gap-2">
          <Brain size={16} style={{ color: accent }} />
          <span className="text-xs font-bold uppercase tracking-wider text-stone-300">Chanakya SQLite Memory</span>
        </div>
        <div className="text-[10px] bg-white/5 text-stone-400 px-2 py-0.5 rounded-full border border-white/5">
          {memories.length} rules
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 p-4 overflow-y-auto flex flex-col gap-4 min-h-0">
        {/* Memory Explainer / Notice */}
        <div className="bg-[#141416]/40 border border-white/5 rounded-2xl p-3.5 flex items-start gap-3">
          <ShieldCheck size={16} className="text-emerald-500 shrink-0 mt-0.5" />
          <div className="text-[11px] text-stone-400 leading-4">
            <span className="font-bold text-stone-300 block mb-0.5">Offline-first Memory RAG</span>
            Chanakya stores facts and custom instructions in SQLite. These are automatically searched during chat sessions to inject user-specific context.
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex gap-2 shrink-0">
          {/* Search bar */}
          <div className="flex-1 relative flex items-center">
            <Search size={12} className="absolute left-3 text-stone-500" />
            <input
              type="text"
              placeholder="Search facts..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-[#141416]/80 border border-white/5 rounded-xl pl-8 pr-3 py-1.5 text-xs text-stone-300 outline-none focus:border-white/10"
            />
          </div>
          <button
            onClick={() => setIsAdding(!isAdding)}
            className="flex items-center gap-1 rounded-xl px-3 py-1.5 text-xs font-bold text-black transition-all shadow-md shrink-0"
            style={{ backgroundColor: accent }}
          >
            <Plus size={13} />
            Teach Rule
          </button>
        </div>

        {/* Add Memory Form Panel */}
        <AnimatePresence>
          {isAdding && (
            <motion.form
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              onSubmit={handleAddMemory}
              className="bg-[#141416]/60 border border-white/5 rounded-2xl p-3 flex flex-col gap-2.5 overflow-hidden shrink-0"
            >
              <div className="flex items-center justify-between">
                <span className="text-[10px] uppercase font-bold text-stone-400">Add New Fact / Instruction</span>
                <button
                  type="button"
                  onClick={() => setIsAdding(false)}
                  className="text-stone-500 hover:text-stone-300"
                >
                  <X size={13} />
                </button>
              </div>

              <textarea
                placeholder="Example: 'I prefer building web apps in React and standard JavaScript' or 'My local document directory is E:/docs'"
                value={newMemoryText}
                onChange={(e) => setNewMemoryText(e.target.value)}
                rows={3}
                required
                className="w-full bg-black/40 border border-white/5 rounded-xl p-2 text-xs text-stone-200 resize-none outline-none focus:border-white/10"
              />

              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-1.5">
                  <select
                    value={memoryType}
                    onChange={(e) => setMemoryType(e.target.value)}
                    className="bg-zinc-800 border border-white/10 rounded-lg text-[10px] text-stone-300 px-2 py-1 outline-none cursor-pointer"
                  >
                    <option value="project">Project Scope</option>
                    <option value="general">General Scope</option>
                  </select>
                </div>

                <button
                  type="submit"
                  className="rounded-lg px-3 py-1 text-[11px] font-bold text-black shadow-md hover:scale-105 transition-all"
                  style={{ backgroundColor: accent }}
                >
                  Save Fact
                </button>
              </div>
            </motion.form>
          )}
        </AnimatePresence>

        {/* Memories List */}
        <div className="flex-grow overflow-y-auto pr-1">
          {isMemoriesLoading ? (
            <div className="text-center py-10 flex items-center justify-center">
              <LoaderCircle size={20} className="animate-spin text-stone-600" />
            </div>
          ) : filteredMemories.length === 0 ? (
            <div className="text-center text-xs text-stone-500 py-10">No local rules found. Add one above.</div>
          ) : (
            <div className="flex flex-col gap-2.5 pb-2">
              <AnimatePresence>
                {filteredMemories.map((m) => (
                  <motion.div
                    key={m.id}
                    className="group flex items-start justify-between gap-3 border border-white/5 bg-[#141416]/50 hover:bg-[#141416]/80 rounded-xl p-3 transition-colors"
                    exit={{ scale: 0.9, opacity: 0 }}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-[8px] uppercase tracking-wider font-extrabold px-1.5 py-0.5 rounded bg-zinc-800 text-stone-400">
                          {m.type || 'general'}
                        </span>
                        <span className="text-[9px] text-stone-600 font-mono">
                          {m.createdAt ? new Date(m.createdAt).toLocaleDateString() : 'core'}
                        </span>
                      </div>
                      <p className="text-[11px] text-stone-300 leading-4 select-text">
                        {m.content}
                      </p>
                    </div>

                    <button
                      onClick={() => deleteMemory(m.id)}
                      className="p-1 rounded hover:bg-red-500/10 text-stone-500 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100 shrink-0 self-center"
                      title="Forget this fact"
                    >
                      <Trash2 size={13} />
                    </button>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          )}
        </div>
      </div>

      {/* Sticky footer wipe action */}
      {memories.length > 0 && (
        <div className="border-t border-white/5 p-3 shrink-0 flex justify-end">
          <button
            onClick={() => {
              if (confirm('Wipe all SQLite memories permanently?')) {
                clearMemories();
              }
            }}
            className="flex items-center gap-1 text-[10px] text-stone-500 hover:text-red-400 transition-colors font-bold uppercase tracking-wider"
          >
            <Trash2 size={10} />
            Wipe Memory Store
          </button>
        </div>
      )}
    </div>
  );
}
