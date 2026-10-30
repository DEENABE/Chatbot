import React, { useEffect, useRef } from 'react';
import { useAppStore } from '../stores/useAppStore.js';
export default function SoftwareChoiceModal() {
  const choices = useAppStore((state) => state.pendingSoftwareChoices);
  const choose = useAppStore((state) => state.chooseSoftware);
  const cancel = useAppStore((state) => state.cancelSoftwareChoice);
  const choice = choices?.[0],
    ref = useRef(null);
  useEffect(() => {
    if (choice) ref.current?.focus();
  }, [choice?.discoveryId]);
  if (!choice) return null;
  return (
    <div
      className="fixed inset-0 z-[9998] grid place-items-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Choose software identity"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !choice.resolving) cancel(choice.discoveryId);
      }}
    >
      <div className="w-full max-w-xl max-h-[90vh] overflow-y-auto rounded-2xl border border-white/10 bg-[#121214] p-5 text-stone-200">
        <h2 className="font-semibold">Choose the exact software</h2>
        <p className="mt-2 text-sm text-stone-400">
          {choice.message ||
            'Several products or publishers match. Choosing an identity does not approve installation.'}
        </p>
        <div className="mt-4 space-y-2">
          {choice.candidates.map((candidate, index) => (
            <button
              ref={index === 0 ? ref : undefined}
              type="button"
              key={candidate.candidateId}
              disabled={choice.resolving}
              onClick={() => choose(choice.discoveryId, candidate.candidateId)}
              className="w-full rounded-xl border border-white/10 p-3 text-left hover:bg-white/5 disabled:opacity-50"
            >
              <span className="block font-medium">{candidate.name}</span>
              <span className="mt-1 block text-xs text-stone-400">
                {candidate.publisher || 'Publisher unresolved'} ·{' '}
                {candidate.version || 'Version unresolved'} ·{' '}
                {candidate.edition || 'Edition unspecified'} · {candidate.architecture}
              </span>
              <span className="mt-1 block break-words text-xs text-stone-500">
                {candidate.source}
              </span>
              {candidate.handoff && (
                <span className="block text-xs text-amber-300">
                  User-assisted source; identity still needs review.
                </span>
              )}
            </button>
          ))}
        </div>
        {choice.error && (
          <p role="alert" className="mt-3 text-xs text-red-300">
            {choice.error}
          </p>
        )}
        <button
          type="button"
          onClick={() => cancel(choice.discoveryId)}
          disabled={choice.resolving}
          className="mt-4 rounded-lg border border-white/10 px-4 py-2 text-sm"
        >
          Cancel this request
        </button>
      </div>
    </div>
  );
}
