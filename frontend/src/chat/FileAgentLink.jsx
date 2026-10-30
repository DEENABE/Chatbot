import React, { useEffect, useState } from 'react';
import { Download, FolderCheck, Undo2, Loader2 } from 'lucide-react';
import * as apiService from '../services/api.js';
import DocIntelResultPager from './DocIntelResultPager.jsx';

/**
 * Links written by the backend file agent:
 *   [report.pdf (12 KB)](#chanakya-output=<id>)   → authenticated download button
 *   [Apply this plan](#chanakya-plan-apply=<id>)  → Apply / Undo for a folder plan
 *   [Show all 240 rows](#chanakya-docintel=<id>)  → paged view of a Document Intelligence result
 * Any other link renders as a normal anchor.
 */
const OUTPUT = /^#chanakya-output=([0-9a-f-]{36})$/;
const PLAN = /^#chanakya-plan-apply=([0-9a-f-]{36})$/;
const RESULT = /^#chanakya-docintel=([0-9a-f-]{36})$/;

const textOf = (children) =>
  React.Children.toArray(children)
    .map((c) =>
      typeof c === 'string' || typeof c === 'number' ? String(c) : textOf(c?.props?.children),
    )
    .join('');

const errorText = async (error) => {
  const data = error?.response?.data;
  if (data instanceof Blob) {
    try {
      return JSON.parse(await data.text()).error || 'Download failed.';
    } catch {
      return 'Download failed.';
    }
  }
  return data?.error || error?.message || 'The request failed.';
};

const button =
  'not-prose inline-flex items-center gap-1.5 rounded-lg border border-stone-600 bg-stone-800/70 px-2.5 py-1 text-xs font-medium text-stone-100 hover:bg-stone-700 disabled:opacity-60 my-0.5 mr-2';

function DownloadButton({ id, label }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const text = textOf(label);
  const fallbackName = text.replace(/\s*\([^)]*\)\s*$/, '').trim() || 'download';
  const download = async () => {
    setBusy(true);
    setError('');
    try {
      const response = await apiService.fileAgent.download(id);
      const disposition = response.headers?.['content-disposition'] || '';
      const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i);
      const name = encoded ? decodeURIComponent(encoded[1]) : fallbackName;
      const url = URL.createObjectURL(response.data);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = name;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (failure) {
      setError(await errorText(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="inline-flex flex-col">
      <button type="button" className={button} onClick={download} disabled={busy} title="Download">
        {busy ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
        {text}
      </button>
      {error && <span className="text-xs text-red-400">{error}</span>}
    </span>
  );
}

function PlanButtons({ id }) {
  const [plan, setPlan] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    apiService.fileAgent
      .plan(id)
      .then((r) => alive && setPlan(r.data))
      .catch(async (e) => alive && setError(await errorText(e)));
    return () => {
      alive = false;
    };
  }, [id]);
  const run = (action) => async () => {
    setBusy(true);
    setError('');
    try {
      setPlan((await apiService.fileAgent[action](id)).data);
    } catch (failure) {
      setError(await errorText(failure));
    } finally {
      setBusy(false);
    }
  };
  const failed = plan?.failed?.length || 0;
  return (
    <span className="not-prose my-1 inline-flex flex-col gap-1">
      <span className="inline-flex flex-wrap items-center">
        {(!plan || plan.status === 'pending') && (
          <button type="button" className={button} onClick={run('apply')} disabled={busy || !plan}>
            {busy ? <Loader2 size={13} className="animate-spin" /> : <FolderCheck size={13} />}
            Apply this plan{plan ? ` (${plan.moves} files)` : ''}
          </button>
        )}
        {plan?.status === 'applied' && (
          <>
            <span className="mr-2 text-xs text-emerald-400">
              Moved {plan.applied} file(s){failed ? `, ${failed} could not be moved` : ''}.
            </span>
            <button type="button" className={button} onClick={run('undo')} disabled={busy}>
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Undo2 size={13} />}
              Undo
            </button>
          </>
        )}
        {plan?.status === 'undone' && (
          <span className="text-xs text-stone-300">
            Undone: {plan.undo?.restored ?? 0} file(s) restored
            {plan.undo?.failed?.length ? `, ${plan.undo.failed.length} could not be restored` : ''}.
          </span>
        )}
      </span>
      {failed > 0 && plan?.status === 'applied' && (
        <span className="text-xs text-amber-400">
          {plan.failed
            .slice(0, 3)
            .map((f) => `${f.from}: ${f.reason}`)
            .join(' · ')}
        </span>
      )}
      {error && <span className="text-xs text-red-400">{error}</span>}
    </span>
  );
}

export default function FileAgentLink({ href = '', children, node: _node, ...props }) {
  const output = href.match(OUTPUT);
  if (output) return <DownloadButton id={output[1]} label={children} />;
  const plan = href.match(PLAN);
  if (plan) return <PlanButtons id={plan[1]} />;
  const result = href.match(RESULT);
  if (result) return <DocIntelResultPager id={result[1]} label={textOf(children)} />;
  return (
    <a href={href} {...props}>
      {children}
    </a>
  );
}
