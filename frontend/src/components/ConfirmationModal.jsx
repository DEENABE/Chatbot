import React from 'react';
import { useAppStore } from '../stores/useAppStore.js';
import { ShieldAlert, Check, X } from 'lucide-react';

export default function ConfirmationModal() {
  const pendingConfirmations = useAppStore((state) => state.pendingConfirmations);
  const resolveConfirmation = useAppStore((state) => state.resolveConfirmation);
  const renewConfirmation = useAppStore((state) => state.renewConfirmation);

  if (!pendingConfirmations || pendingConfirmations.length === 0) return null;

  const currentConf = pendingConfirmations[0]; // Show the oldest one first

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Review requested action"
        className="bg-[#121214] border border-red-500/30 w-full max-w-md max-h-[90vh] overflow-y-auto rounded-2xl p-6 shadow-2xl flex flex-col shadow-red-900/20 text-white animate-in zoom-in-95 duration-200"
      >
        <div className="flex items-center space-x-3 text-red-400 mb-4">
          <ShieldAlert size={28} className="animate-pulse" />
          <h2 className="text-xl font-bold tracking-wide">Action Required</h2>
        </div>

        <p className="text-sm text-stone-300 mb-4 leading-relaxed font-medium">
          Review the requested action before allowing it once:
        </p>

        <div className="bg-black/50 border border-stone-800 rounded-lg p-4 mb-6 font-mono text-sm text-red-200 shadow-inner break-words">
          {currentConf.message || 'No description provided.'}
        </div>

        {currentConf.approvalDetails?.software && (
          <dl className="mb-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-xs">
            {Object.entries({
              Software: currentConf.approvalDetails.software.name,
              Publisher: currentConf.approvalDetails.software.publisher || 'Unresolved',
              Version: currentConf.approvalDetails.software.version || 'Unknown',
              Edition: currentConf.approvalDetails.software.edition || 'Not specified',
              Action: currentConf.approvalDetails.software.operation,
              'Install mode': currentConf.approvalDetails.software.executionMode,
              Source: currentConf.approvalDetails.software.source,
              Architecture: currentConf.approvalDetails.software.architecture || 'Not specified',
              'Download size': currentConf.approvalDetails.software.size
                ? `${(currentConf.approvalDetails.software.size / 1048576).toFixed(1)} MB`
                : 'Unknown',
              Privileges:
                currentConf.approvalDetails.software.privileges || 'Unknown; Windows may prompt',
              License:
                currentConf.approvalDetails.software.license?.paid === true
                  ? 'A paid license is required. Purchase, account login and activation remain under your control.'
                  : currentConf.approvalDetails.software.license?.userAction ||
                    currentConf.approvalDetails.software.license?.description ||
                    (currentConf.approvalDetails.software.license?.required === false
                      ? 'No stated license requirement'
                      : "Review the publisher's license; purchase and activation remain your responsibility"),
              Reboot: currentConf.approvalDetails.software.reboot || 'Unknown',
              'SHA-256':
                currentConf.approvalDetails.software.sha256 || 'Will be checked after download',
            }).map(([label, value]) => (
              <React.Fragment key={label}>
                <dt className="text-stone-500">{label}</dt>
                <dd className="min-w-0 break-words text-stone-200">{String(value || 'Unknown')}</dd>
              </React.Fragment>
            ))}
          </dl>
        )}
        {currentConf.approvalDetails && !currentConf.approvalDetails.software && (
          <p className="text-sm text-stone-300 mb-4">
            Action: {currentConf.approvalDetails.action}
            <br />
            Risk: Changes current system state
            <br />
            Reason: {currentConf.approvalDetails.reason}
          </p>
        )}

        {currentConf.renewalError && (
          <p className="text-sm text-red-300 mb-3">{currentConf.renewalError}</p>
        )}
        <button
          disabled={currentConf.renewing}
          onClick={() => renewConfirmation(currentConf.confirmationId)}
          className="text-sm text-stone-300 underline mb-4 text-left disabled:opacity-50"
        >
          {currentConf.renewing ? 'Renewing request…' : 'Renew request for a fresh approval'}
        </button>
        <div className="flex justify-end space-x-3">
          <button
            disabled={currentConf.renewing}
            onClick={() => resolveConfirmation(currentConf.confirmationId, false)}
            className="flex items-center px-4 py-2 rounded-lg bg-stone-800 hover:bg-stone-700 text-stone-200 font-semibold transition-colors duration-200"
          >
            <X size={16} className="mr-2" /> Cancel
          </button>
          <button
            disabled={currentConf.renewing}
            onClick={() => resolveConfirmation(currentConf.confirmationId, true)}
            className="flex items-center px-4 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white font-bold transition-colors duration-200 shadow-lg shadow-red-600/30 hover:shadow-red-500/50"
          >
            <Check size={16} className="mr-2" /> Allow once
          </button>
        </div>
      </div>
    </div>
  );
}
