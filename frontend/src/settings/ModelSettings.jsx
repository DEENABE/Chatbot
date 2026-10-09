import React, { useEffect, useState } from 'react';
import { api } from '../services/api.js';
import OfflineInstallerControls from './OfflineInstallerControls.jsx';

export default function ModelSettings() {
  const [models, setModels] = useState([]),
    [preferences, setPreferences] = useState(null),
    [status, setStatus] = useState('Loading local models…'),
    [saving, setSaving] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    api
      .get('/models/settings', { signal: controller.signal })
      .then(({ data }) => {
        setModels(data.models || []);
        setPreferences(data.preferences);
        setStatus('');
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setStatus(
            error.response?.data?.error ||
              'Local model settings are unavailable. Start Ollama and try again.',
          );
      });
    return () => controller.abort();
  }, []);
  const update = (key, value) => setPreferences((previous) => ({ ...previous, [key]: value }));
  const save = async (event) => {
    event.preventDefault();
    setSaving(true);
    setStatus('');
    try {
      const { data } = await api.put('/models/settings', preferences);
      setPreferences(data.preferences);
      setStatus('Model settings saved.');
    } catch (error) {
      setStatus(error.response?.data?.error || 'Could not save model settings.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <form onSubmit={save} className="space-y-4 text-sm">
      <p className="text-stone-400">
        Choose installed local models for conversation and document answers, and for approved
        Windows tasks.
      </p>
      {preferences && (
        <>
          {[
            ['generalModel', 'General and documents', 'completion'],
            ['windowsModel', 'Windows Agent', 'tools'],
          ].map(([key, label, capability]) => (
            <label key={key} className="block space-y-1">
              <span>{label}</span>
              <select
                className="w-full rounded-lg bg-stone-900 border border-white/10 p-2"
                value={preferences[key]}
                onChange={(event) => update(key, event.target.value)}
              >
                <option value="">Automatic from installed capabilities</option>
                {models
                  .filter(
                    (model) =>
                      model.capabilities.includes('completion') &&
                      model.capabilities.includes(capability),
                  )
                  .map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.label} · {model.parameterSize} ·{' '}
                      {model.contextWindow
                        ? `${model.contextWindow.toLocaleString()} context`
                        : 'context unknown'}
                    </option>
                  ))}
              </select>
            </label>
          ))}
          <label className="block space-y-1">
            <span>Keep model in memory after a request</span>
            <select
              className="w-full rounded-lg bg-stone-900 border border-white/10 p-2"
              value={preferences.keepAlive}
              onChange={(event) => update('keepAlive', event.target.value)}
            >
              {[
                ['0', 'Unload immediately'],
                ['30s', '30 seconds'],
                ['2m', '2 minutes'],
                ['5m', '5 minutes'],
                ['10m', '10 minutes'],
              ].map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1">
            <span>Maximum context tokens</span>
            <input
              className="w-full rounded-lg bg-stone-900 border border-white/10 p-2"
              type="number"
              min="2048"
              max="32768"
              step="1024"
              value={preferences.contextWindow}
              onChange={(event) => update('contextWindow', Number(event.target.value))}
            />
          </label>
          <p className="text-xs text-stone-500">
            General answers cannot run computer tools. Windows actions still require permission.
            Models are discovered locally; changing these settings does not download anything.
          </p>
          <button
            className="rounded-lg bg-blue-600 px-4 py-2 disabled:opacity-50"
            disabled={saving}
          >
            {saving ? 'Saving…' : 'Save model settings'}
          </button>
        </>
      )}
      {status && (
        <p role="status" className="text-stone-300">
          {status}
        </p>
      )}
      <OfflineInstallerControls />
    </form>
  );
}
