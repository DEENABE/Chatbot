import React, { useCallback, useState } from 'react';
import { ChevronLeft, ChevronRight, Loader2, TableProperties } from 'lucide-react';
import DataTable from './DataTable.jsx';
import * as apiService from '../services/api.js';

const PAGE_SIZE = 100;
const button =
  'not-prose inline-flex items-center gap-1.5 rounded-lg border border-stone-600 bg-stone-800/70 px-2.5 py-1 text-xs font-medium text-stone-100 hover:bg-stone-700 disabled:opacity-50 my-0.5 mr-2';

/**
 * "Show all N rows" for a Document Intelligence result. The backend keeps the
 * full exact result (owner-scoped, 2 hours) so pages come from the real rows,
 * never from a truncated chat message. The total count is always shown.
 */
export default function DocIntelResultPager({ id, label }) {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(
    async (page) => {
      setBusy(true);
      setError('');
      try {
        const { data } = await apiService.docintel.result(id, page, PAGE_SIZE);
        setState(data);
      } catch (failure) {
        setError(failure?.response?.data?.error || failure?.message || 'Could not load the rows.');
      } finally {
        setBusy(false);
      }
    },
    [id],
  );

  if (!state)
    return (
      <span className="inline-flex flex-col">
        <button type="button" className={button} onClick={() => load(1)} disabled={busy}>
          {busy ? <Loader2 size={13} className="animate-spin" /> : <TableProperties size={13} />}
          {label}
        </button>
        {error && <span className="text-xs text-red-400">{error}</span>}
      </span>
    );

  return (
    <span className="not-prose my-2 block">
      <span className="mb-1 flex flex-wrap items-center gap-2 text-xs text-stone-300">
        <span>
          {state.title ? <strong className="mr-1">{state.title}</strong> : null}
          Rows {state.from.toLocaleString('en-IN')}–{state.to.toLocaleString('en-IN')} of{' '}
          {state.total.toLocaleString('en-IN')}
        </span>
        <button
          type="button"
          className={button}
          disabled={busy || state.page <= 1}
          onClick={() => load(state.page - 1)}
        >
          <ChevronLeft size={13} /> Previous
        </button>
        <button
          type="button"
          className={button}
          disabled={busy || state.page >= state.pages}
          onClick={() => load(state.page + 1)}
        >
          Next <ChevronRight size={13} />
        </button>
        {busy && <Loader2 size={13} className="animate-spin" />}
      </span>
      <DataTable
        header={state.columns.map(String)}
        rows={state.rows.map((r) => r.map((v) => (v === null || v === undefined ? '' : String(v))))}
      />
      {state.source && (
        <span className="block text-[11px] italic text-stone-400">Source: {state.source}</span>
      )}
      {error && <span className="text-xs text-red-400">{error}</span>}
    </span>
  );
}
