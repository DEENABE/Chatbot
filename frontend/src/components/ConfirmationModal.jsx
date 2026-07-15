import React from 'react';
import { useAppStore } from '../stores/useAppStore.js';
import { ShieldAlert, Check, X } from 'lucide-react';

export default function ConfirmationModal() {
  const pendingConfirmations = useAppStore(state => state.pendingConfirmations);
  const resolveConfirmation = useAppStore(state => state.resolveConfirmation);

  if (!pendingConfirmations || pendingConfirmations.length === 0) return null;

  const currentConf = pendingConfirmations[0]; // Show the oldest one first

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-[#121214] border border-red-500/30 w-full max-w-md rounded-2xl p-6 shadow-2xl flex flex-col shadow-red-900/20 text-white animate-in zoom-in-95 duration-200">
        <div className="flex items-center space-x-3 text-red-400 mb-4">
          <ShieldAlert size={28} className="animate-pulse" />
          <h2 className="text-xl font-bold tracking-wide">Action Required</h2>
        </div>
        
        <p className="text-sm text-stone-300 mb-4 leading-relaxed font-medium">
          Chanakya AI is attempting to execute a potentially destructive system action:
        </p>
        
        <div className="bg-black/50 border border-stone-800 rounded-lg p-4 mb-6 font-mono text-sm text-red-200 shadow-inner break-words">
          {currentConf.message || 'No description provided.'}
        </div>

        <div className="flex justify-end space-x-3">
          <button
            onClick={() => resolveConfirmation(currentConf.confirmationId, false)}
            className="flex items-center px-4 py-2 rounded-lg bg-stone-800 hover:bg-stone-700 text-stone-200 font-semibold transition-colors duration-200"
          >
            <X size={16} className="mr-2" /> Cancel
          </button>
          <button
            onClick={() => resolveConfirmation(currentConf.confirmationId, true)}
            className="flex items-center px-4 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white font-bold transition-colors duration-200 shadow-lg shadow-red-600/30 hover:shadow-red-500/50"
          >
            <Check size={16} className="mr-2" /> Allow Execution
          </button>
        </div>
      </div>
    </div>
  );
}
