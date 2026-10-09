import React from 'react';
import { useAppStore } from '../stores/useAppStore.js';
import { redactDiagnostics } from '../utils/diagnostics.js';

export default function DiagnosticLog() {
  const messages = useAppStore((state) => state.activeMessages);
  const tools = messages.filter((message) => message.role === 'tool');
  return (
    <div className="mt-4 rounded-xl border border-white/10 p-3 text-xs text-stone-400">
      <h3 className="font-semibold text-stone-200">Current conversation diagnostics</h3>
      <p className="mt-1">
        Detailed tool responses are available here for troubleshooting. Credential fields and known
        token patterns are redacted.
      </p>
      {tools.length ? (
        tools.map((message) => {
          let value;
          try {
            value = JSON.parse(message.content);
          } catch {
            value = message.content;
          }
          return (
            <details key={message.id} className="mt-2">
              <summary className="cursor-pointer text-stone-300">
                {message.tool_name || 'Tool response'}
              </summary>
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-black/30 p-2">
                {typeof value === 'string'
                  ? redactDiagnostics(value)
                  : JSON.stringify(redactDiagnostics(value), null, 2)}
              </pre>
            </details>
          );
        })
      ) : (
        <p className="mt-2 text-stone-500">No tool responses in this conversation.</p>
      )}
    </div>
  );
}
