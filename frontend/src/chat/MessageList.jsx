import React, { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Bot, Copy, Volume2, ThumbsUp, ThumbsDown } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { useAppStore } from '../stores/useAppStore.js';
import { presets } from '../animations/presets.js';

export default function MessageList() {
  const messages = useAppStore((state) => state.activeMessages);
  const isGenerating = useAppStore((state) => state.isGenerating);
  const settings = useAppStore((state) => state.settings);
  const setInputText = useAppStore((state) => state.setInputText);
  const pendingRepairFeedback = useAppStore((state) => state.pendingRepairFeedback);
  const submitRepairFeedback = useAppStore((state) => state.submitRepairFeedback);

  const endRef = useRef(null);
  const scrollRef = useRef(null);
  const stickToBottomRef = useRef(true);
  const [selectionBox, setSelectionBox] = useState(null);

  // Track whether the user is near the bottom; only auto-scroll when they are,
  // so scrolling up to read history isn't yanked back down during streaming.
  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom < 120;
  };

  // Auto-scroll on new messages or tokens (only while pinned to the bottom).
  useEffect(() => {
    if (stickToBottomRef.current) {
      endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [messages]);

  useEffect(() => {
    const handleSelectionChange = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.toString().trim()) {
        setSelectionBox(null);
        return;
      }
      
      const text = selection.toString().trim();
      if (text.length < 3) return; // ignore short selections
      
      try {
        const range = selection.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        
        // Position toolbar 40px above selection center
        setSelectionBox({
          x: rect.left + rect.width / 2,
          y: rect.top - 40,
          text
        });
      } catch (err) {
        // ignore errors getting range bounds
      }
    };

    document.addEventListener('selectionchange', handleSelectionChange);
    return () => document.removeEventListener('selectionchange', handleSelectionChange);
  }, []);

  const handleSpeak = (text) => {
    if (!window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text.replace(/\[Source \d+\]/g, ''));
    utterance.rate = 1.05;
    window.speechSynthesis.speak(utterance);
  };

  const handleCopy = (text) => {
    navigator.clipboard.writeText(text);
  };

  const accent = settings.accentColor || '#3b82f6';

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="absolute inset-0 overflow-y-auto px-4 py-6 scrollbar-thin select-text"
    >
      {/* Floating Highlight Actions Toolbar */}
      {selectionBox && (
        <div 
          className="fixed z-50 flex items-center gap-1.5 rounded-xl border border-white/5 bg-[#121214]/95 backdrop-blur-md p-1 shadow-2xl transition-all -translate-x-1/2"
          style={{ 
            top: selectionBox.y, 
            left: selectionBox.x,
          }}
        >
          <button
            onClick={() => {
              setInputText(`Explain this highlighted concept:\n\n"${selectionBox.text}"`);
              setSelectionBox(null);
              window.getSelection()?.removeAllRanges();
            }}
            className="rounded-lg px-2.5 py-1 text-[10px] font-bold text-stone-300 hover:text-white hover:bg-white/5 transition-all cursor-pointer"
          >
            Explain
          </button>
          <hr className="h-3.5 border-l border-white/5" />
          <button
            onClick={() => {
              setInputText(`Summarize this context:\n\n"${selectionBox.text}"`);
              setSelectionBox(null);
              window.getSelection()?.removeAllRanges();
            }}
            className="rounded-lg px-2.5 py-1 text-[10px] font-bold text-stone-300 hover:text-white hover:bg-white/5 transition-all cursor-pointer"
          >
            Summarize
          </button>
        </div>
      )}

      <div className="mx-auto max-w-2xl space-y-5">
        <AnimatePresence initial={false}>
          {messages.map((message, i) => {
            const isLast = i === messages.length - 1;
            const parsedSources = typeof message.sources === 'string' && message.sources
              ? JSON.parse(message.sources)
              : message.sources;

            return (
              <motion.div
                key={message.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3 }}
                className={`flex gap-3 ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                {/* Bot Avatar */}
                {message.role === 'assistant' && (
                  <div 
                    className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border text-xs"
                    style={{ 
                      borderColor: `${accent}30`, 
                      background: `linear-gradient(135deg, ${accent}20, transparent)`,
                      color: accent
                    }}
                  >
                    <Bot size={14} />
                  </div>
                )}

                {/* Message Bubble */}
                <div 
                  className={`group max-w-[85%] rounded-2xl p-3 text-xs leading-5 relative transition-all ${
                    message.role === 'user'
                      ? 'rounded-tr-none text-white'
                      : message.role === 'tool'
                        ? 'rounded-lg text-emerald-400 border border-emerald-500/10 font-mono shadow-inner shadow-black/80'
                        : 'rounded-tl-none text-stone-200 border border-white/[0.04]'
                  }`}
                  style={{
                    background: message.role === 'user' 
                      ? `linear-gradient(135deg, ${accent}30, ${accent}10)` 
                      : message.role === 'tool'
                        ? 'rgba(6, 78, 59, 0.05)'
                        : 'rgba(255, 255, 255, 0.02)',
                    borderColor: message.role === 'user' 
                      ? `${accent}25` 
                      : message.role === 'tool'
                        ? 'rgba(16, 185, 129, 0.15)'
                        : undefined
                  }}
                >
                  {message.role === 'tool' ? (
                    <div className="space-y-1.5 text-[10px]">
                      <div className="flex items-center gap-1.5 border-b border-emerald-500/10 pb-1 opacity-70">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                        <span className="font-extrabold uppercase tracking-widest text-[8px]">Native System Tool Output</span>
                      </div>
                      <div className="select-text whitespace-pre-wrap break-all leading-4">{message.content}</div>
                    </div>
                  ) : message.role === 'assistant' ? (
                    <div className="space-y-2">
                      <div className="markdown prose prose-invert select-text">
                        <ReactMarkdown>{message.content || ''}</ReactMarkdown>
                        {isGenerating && isLast && (
                          <motion.span 
                            animate={{ opacity: [0, 1, 0] }}
                            transition={{ duration: 0.8, repeat: Infinity }}
                            className="inline-block h-3.5 w-1.5 ml-1 align-middle"
                            style={{ backgroundColor: accent }}
                          />
                        )}
                      </div>
 
                      {/* Action buttons */}
                      {message.content && (!isGenerating || !isLast) && (
                        <div className="flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity mt-2">
                          <button
                            onClick={() => handleCopy(message.content)}
                            className="rounded-lg p-1 text-stone-500 hover:bg-white/5 hover:text-white transition-colors cursor-pointer"
                            title="Copy text"
                          >
                            <Copy size={12} />
                          </button>
                          <button
                            onClick={() => handleSpeak(message.content)}
                            className="rounded-lg p-1 text-stone-500 hover:bg-white/5 hover:text-white transition-colors cursor-pointer"
                            title="Speak response"
                          >
                            <Volume2 size={12} />
                          </button>
                        </div>
                      )}
 
                      {/* Display RAG sources */}
                      {parsedSources && parsedSources.length > 0 && (
                        <div className="mt-2 border-t border-white/[0.04] pt-2">
                          <div className="text-[9px] font-semibold text-stone-600 uppercase tracking-wider mb-1">
                            Retrieved Context Sources
                          </div>
                          <div className="flex flex-wrap gap-1">
                            {parsedSources.map((src, sIdx) => (
                              <span 
                                key={sIdx} 
                                className="rounded-full bg-white/[0.03] border border-white/[0.05] px-2 py-0.5 text-[9px] text-stone-400"
                                title={`Matching score: ${Math.round((1 - src.score) * 100)}%`}
                              >
                                {src.filename} · Chunk {src.chunk}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="select-text whitespace-pre-wrap">{message.content}</div>
                  )}
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>

        {/* Repair feedback — trains the model on what actually worked */}
        {pendingRepairFeedback && !isGenerating && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex items-center justify-center gap-2 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2"
          >
            <span className="text-[11px] text-stone-400">Did this fix the problem?</span>
            <button
              onClick={() => submitRepairFeedback(true)}
              className="flex items-center gap-1 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-1 text-[10px] font-semibold text-emerald-400 hover:bg-emerald-500/20 transition-colors cursor-pointer"
            >
              <ThumbsUp size={11} /> Worked
            </button>
            <button
              onClick={() => submitRepairFeedback(false)}
              className="flex items-center gap-1 rounded-lg border border-red-500/20 bg-red-500/10 px-2.5 py-1 text-[10px] font-semibold text-red-400 hover:bg-red-500/20 transition-colors cursor-pointer"
            >
              <ThumbsDown size={11} /> Didn't
            </button>
          </motion.div>
        )}

        <div ref={endRef} />
      </div>
    </div>
  );
}
