import React from 'react';
import { motion } from 'framer-motion';
import { BarChart3, CheckCircle2, FileSearch, Landmark, ShieldCheck } from 'lucide-react';
import { useAppStore } from '../stores/useAppStore.js';
import { presets } from '../animations/presets.js';

const prompts = [
  { icon: FileSearch, title: 'Analyze documents', text: 'Summarize the key points in my uploaded documents' },
  { icon: BarChart3, title: 'Surface insights', text: 'Explain the trends across my local data spreadsheets' },
  { icon: Landmark, title: 'Build strategies', text: 'Create an action plan grounded in my knowledge base' }
];

export default function Welcome({ onPrompt }) {
  const documents = useAppStore((state) => state.documents);
  const settings = useAppStore((state) => state.settings);
  const accent = settings.accentColor || '#3b82f6';

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center justify-center px-4 py-8 text-center h-full overflow-y-auto select-none">
      <motion.div 
        initial={{ opacity: 0, scale: 0.9 }} 
        animate={{ opacity: 1, scale: 1 }} 
        className="relative mb-5"
        transition={presets.appleBounce}
      >
        <div className="absolute -inset-4 rounded-full blur-xl" style={{ background: `${accent}15` }} />
        <div 
          className="relative h-16 w-16 overflow-hidden rounded-full border bg-[#121214] p-1 flex items-center justify-center shadow-lg"
          style={{ borderColor: `${accent}40` }}
        >
          <div className="text-2xl font-extrabold font-sans" style={{ color: accent }}>C</div>
        </div>
      </motion.div>
 
      <motion.div 
        initial={{ opacity: 0, y: 10 }} 
        animate={{ opacity: 1, y: 0 }} 
        transition={{ delay: 0.08 }}
      >
        <div className="mb-2 flex items-center justify-center gap-1.5 text-[9px] font-bold uppercase tracking-wider" style={{ color: accent }}>
          <ShieldCheck size={11} /> 
          Chanakya AI Intelligence Core
        </div>
        <h2 className="text-2xl font-bold tracking-tight text-white md:text-3xl">
          How can I assist you?
        </h2>
        <p className="mx-auto mt-2 max-w-md text-xs leading-5 text-stone-500">
          Ask questions across your private knowledge base, extract key facts, or formulate writing strategies. Everything runs 100% locally and offline.
        </p>
      </motion.div>
 
      {documents.length > 0 && (
        <motion.div 
          initial={{ opacity: 0, y: 10 }} 
          animate={{ opacity: 1, y: 0 }} 
          className="mt-6 flex w-full items-start gap-2.5 rounded-2xl border border-emerald-500/10 bg-emerald-500/[0.03] p-3.5 text-left backdrop-blur-md"
        >
          <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-emerald-400" />
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold text-stone-200">Knowledge base active</div>
            <div className="mt-0.5 text-[10px] leading-4 text-stone-500 truncate">
              {documents.map((d) => d.name).join(', ')}
            </div>
            <button 
              onClick={() => onPrompt('Summarize the key points from the uploaded documents.')} 
              className="mt-2 text-[10px] font-semibold hover:underline"
              style={{ color: accent }}
            >
              Summarize knowledge base →
            </button>
          </div>
        </motion.div>
      )}
 
      <div className="mt-6 grid w-full gap-2.5 grid-cols-1 md:grid-cols-3">
        {prompts.map((prompt, i) => (
          <motion.button 
            key={prompt.title} 
            initial={{ opacity: 0, y: 10 }} 
            animate={{ opacity: 1, y: 0 }} 
            transition={{ delay: 0.12 + i * 0.04 }} 
            onClick={() => onPrompt(prompt.text)} 
            className="glass-card rounded-2xl p-3.5 text-left active:scale-[0.98] outline-none"
          >
            <prompt.icon size={16} className="mb-3" style={{ color: accent }} />
            <div className="text-xs font-semibold text-stone-200">{prompt.title}</div>
            <div className="mt-1 text-[10px] leading-4 text-stone-500">{prompt.text}</div>
          </motion.button>
        ))}
      </div>
    </div>
  );
}
