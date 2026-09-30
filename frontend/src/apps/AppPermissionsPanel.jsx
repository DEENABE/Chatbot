import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../stores/useAppStore.js';

const LEVELS = ['blocked', 'read', 'interact', 'modify'];
const LEVEL_LABELS = { blocked: 'Blocked', read: 'Read only', interact: 'Interact', modify: 'Modify (confirm each change)' };
const identity = () => ({ requestId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() });

// The list and the level change go through the same tool engine (and confirmation modal) as every other action.
// The model cannot call app.setAppPermission; only this panel can, and only after the user approves the prompt.
export default function AppPermissionsPanel() {
  const addConfirmation = useAppStore(state => state.addConfirmation);
  const loadInstalledApps = useAppStore(state => state.loadInstalledApps);
  const [apps, setApps] = useState([]);
  const [levels, setLevels] = useState({});
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setBusy(true); setError('');
    try {
      if (!window.toolEngine) throw new Error('The desktop tool engine is not available in this window.');
      const result = await window.toolEngine.execute('app', 'listApps', { limit: 100 }, crypto.randomUUID(), identity());
      const data = result?.data || result;
      if (!result?.success && !data?.apps) throw new Error(result?.error?.message || 'Could not list applications.');
      setApps(data.apps || []); setLevels(data.levels || {});
      // Keep the assistant's view of installed apps current whenever this list is refreshed.
      loadInstalledApps(true);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }, [loadInstalledApps]);
  useEffect(() => { load(); }, [load]);

  const change = async (app, level) => {
    setError('');
    try {
      const result = await window.toolEngine.execute('app', 'setAppPermission', { appId: app.id, level }, crypto.randomUUID(), identity());
      if (result?.needsConfirmation) {
        // Approving or declining in the shared modal finishes the change; refresh the list afterwards.
        addConfirmation({ confirmationId: result.confirmationId, message: result.confirmationMessage || result.message, approvalDetails: result.approvalDetails, standalone: true, onSettled: load });
      } else if (!result?.success) throw new Error(result?.error?.message || 'The permission was not changed.');
      else await load();
    } catch (e) { setError(e.message); }
  };

  const shown = useMemo(() => apps.filter(a => `${a.name} ${a.category}`.toLowerCase().includes(query.toLowerCase())), [apps, query]);
  const input = 'w-full rounded-lg bg-zinc-900 border border-white/10 p-2 text-sm';
  return <section className="h-full overflow-y-auto p-5 bg-[#0c0c0e] text-stone-200 space-y-4">
    <h2 className="text-lg font-semibold">App Permissions</h2>
    <p className="text-sm text-stone-400">Choose how far the assistant may go inside each application. Security-sensitive controls stay blocked at every level, and changing a level always asks you first.</p>
    <ul className="text-xs text-stone-400 space-y-1">{LEVELS.map(l => <li key={l}><strong className="text-stone-200">{LEVEL_LABELS[l]}:</strong> {levels[l]}</li>)}</ul>
    <label className="block">Search<input className={input} value={query} onChange={e => setQuery(e.target.value)} placeholder="Filter applications" /></label>
    {error && <p role="alert" className="text-red-400">{error}</p>}
    {busy && <p role="status">Loading applications...</p>}
    <ul className="space-y-2">{shown.map(app => <li key={app.id} className="rounded-lg border border-white/10 p-3 flex items-center justify-between gap-3">
      <div className="min-w-0"><strong className="block truncate">{app.name}</strong><span className="text-xs text-stone-400">{app.category}</span></div>
      <select aria-label={`Permission for ${app.name}`} className="rounded bg-zinc-900 border border-white/10 p-2 text-sm" value={app.permission} disabled={busy}
        onChange={e => change(app, e.target.value)}>{LEVELS.map(l => <option key={l} value={l}>{LEVEL_LABELS[l]}</option>)}</select>
    </li>)}</ul>
    {!busy && !shown.length && !error && <p>No applications found.</p>}
  </section>;
}
