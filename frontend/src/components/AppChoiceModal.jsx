import React from 'react';
import { useAppStore } from '../stores/useAppStore.js';
import { AppWindow, X } from 'lucide-react';
import { describePendingTask } from '../../../backend/src/orchestrator/PendingAppTask.js';

// The folder a candidate lives in tells two installs of the same product apart; the file name adds nothing.
const location = (candidate) => {
  const file = candidate.executablePath;
  if (!file) return candidate.source === 'msix' ? 'Microsoft Store app' : '';
  const cut = Math.max(file.lastIndexOf('\\'), file.lastIndexOf('/'));
  return cut > 0 ? file.slice(0, cut) : file;
};

/** "Which application do you mean?" The pick resumes the paused task by candidate id; it is never sent back through chat. */
export default function AppChoiceModal() {
  const pendingAppChoices = useAppStore((state) => state.pendingAppChoices);
  const chooseApp = useAppStore((state) => state.chooseApp);
  const cancelAppChoice = useAppStore((state) => state.cancelAppChoice);

  if (!pendingAppChoices || pendingAppChoices.length === 0) return null;

  const choice = pendingAppChoices[0]; // Oldest question first
  const next = describePendingTask(choice.pendingTask);

  return (
    <div className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div
        role="dialog"
        aria-label="Choose an application"
        className="bg-[#121214] border border-blue-500/30 w-full max-w-md rounded-2xl p-6 shadow-2xl flex flex-col text-white"
      >
        <div className="flex items-center space-x-3 text-blue-400 mb-3">
          <AppWindow size={26} />
          <h2 className="text-xl font-bold tracking-wide">Which one?</h2>
        </div>
        <p className="text-sm text-stone-300 mb-1 leading-relaxed">{choice.message}</p>
        {next && <p className="text-xs text-stone-400 mb-3">{next}</p>}
        {choice.error && <p className="text-sm text-red-300 mb-3">{choice.error}</p>}

        <ul className="flex flex-col gap-2 mb-4 max-h-72 overflow-y-auto">
          {choice.candidates.map((candidate, index) => (
            <li key={candidate.id}>
              <button
                disabled={choice.resolving}
                onClick={() => chooseApp(choice.choiceId, candidate.id)}
                className="w-full text-left rounded-lg border border-stone-800 bg-black/40 hover:border-blue-500/60 hover:bg-blue-500/10 px-3 py-2 transition-colors disabled:opacity-50"
              >
                <span className="block text-sm font-semibold text-stone-100">
                  {index + 1}. {candidate.displayName}
                </span>
                <span className="block text-[11px] text-stone-400 break-all">
                  {[candidate.publisher, location(candidate)].filter(Boolean).join(' · ')}
                </span>
              </button>
            </li>
          ))}
        </ul>

        <div className="flex justify-end">
          <button
            disabled={choice.resolving}
            onClick={() => cancelAppChoice(choice.choiceId)}
            className="flex items-center px-4 py-2 rounded-lg bg-stone-800 hover:bg-stone-700 text-stone-200 font-semibold transition-colors duration-200 disabled:opacity-50"
          >
            <X size={16} className="mr-2" /> {choice.resolving ? 'Opening…' : 'Cancel'}
          </button>
        </div>
      </div>
    </div>
  );
}
