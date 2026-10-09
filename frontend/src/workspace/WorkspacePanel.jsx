import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Folder, FileText, RefreshCw, UploadCloud } from 'lucide-react';
import * as apiService from '../services/api.js';
import { useAppStore } from '../stores/useAppStore.js';
import { formatBytes, DOCUMENT_ACCEPT } from '../utils/attachments.js';

export default function WorkspacePanel() {
  const user = useAppStore((state) => state.user);
  const setActiveWorkspaceId = useAppStore((state) => state.setActiveWorkspaceId);
  const [workspaces, setWorkspaces] = useState([]);
  const [active, setActive] = useState(null);
  const [scan, setScan] = useState(null);
  const [documents, setDocuments] = useState([]);
  const [name, setName] = useState('');
  const [root, setRoot] = useState('');
  const [busy, setBusy] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [indexing, setIndexing] = useState(false);
  const [progress, setProgress] = useState(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [showUnsupported, setShowUnsupported] = useState(false);
  const uploadController = useRef(null);
  const mounted = useRef(true);
  const refreshEpoch = useRef(0);
  const refresh = useCallback(async (preferredId) => {
    const epoch = ++refreshEpoch.current;
    const result = await apiService.workspaces.get();
    if (!mounted.current || epoch !== refreshEpoch.current) return;
    const list = result.data.workspaces || [];
    setWorkspaces(list);
    const workspace =
      list.find((entry) => entry.id === preferredId) || list.find((entry) => entry.active) || null;
    setActive(workspace);
    setName(workspace?.name || '');
    setRoot(workspace?.root || '');
    setActiveWorkspaceId(workspace?.id || null);
    if (workspace?.indexState === 'indexing') setIndexing(true);
    if (!workspace) {
      setScan(null);
      setDocuments([]);
      return;
    }
    const results = await Promise.allSettled([
      apiService.workspaces.files(workspace.id),
      apiService.documents.get({
        purpose: 'workspace',
        workspaceId: workspace.id,
      }),
    ]);
    if (!mounted.current || epoch !== refreshEpoch.current) return;
    if (results[0].status === 'fulfilled') setScan(results[0].value.data);
    else {
      setScan(null);
      setError(
        'The workspace directory could not be read. Reconnect the drive or choose a new directory.',
      );
    }
    if (results[1].status === 'fulfilled') setDocuments(results[1].value.data.documents || []);
  }, []);
  useEffect(() => {
    mounted.current = true;
    setInitialLoading(true);
    let cancelled = false;
    refresh()
      .catch(() => {
        if (!cancelled) setError('Workspaces could not be loaded. Try Refresh.');
      })
      .finally(() => {
        if (!cancelled && mounted.current) setInitialLoading(false);
      });
    return () => {
      cancelled = true;
      mounted.current = false;
      refreshEpoch.current++;
      uploadController.current?.abort();
    };
  }, [user?.id, refresh]);
  useEffect(() => {
    if (!indexing || !active) return;
    const timer = setInterval(
      () =>
        apiService.workspaces
          .status(active.id)
          .then((result) => {
            if (!mounted.current) return;
            setProgress(result.data.progress);
            if (result.data.workspace?.indexState !== 'indexing') {
              setIndexing(false);
              refresh(active.id).catch(() => {});
            }
          })
          .catch(() => {}),
      1500,
    );
    return () => clearInterval(timer);
  }, [indexing, active?.id]);
  const perform = async (operation, message) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const preferredId = await operation();
      if (mounted.current) {
        if (message) setNotice(message);
        await refresh(typeof preferredId === 'string' ? preferredId : undefined);
      }
    } catch (failure) {
      if (mounted.current)
        setError(
          failure.response?.data?.error ||
            failure.message ||
            'The workspace action could not be completed.',
        );
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const chooseDirectory = async () => {
    if (!window.workspaceAPI) {
      setNotice('Enter a local directory path, then save the workspace.');
      return;
    }
    const chosen = await window.workspaceAPI.chooseDirectory();
    if (chosen?.error) setError(chosen.error);
    if (!chosen?.cancelled && chosen?.root) {
      setRoot(chosen.root);
      if (!name) setName(chosen.root.split(/[\\/]/).filter(Boolean).pop() || 'Workspace');
    }
  };
  const save = (event) => {
    event.preventDefault();
    perform(async () => {
      const result = active
        ? await apiService.workspaces.update(active.id, { name, root })
        : await apiService.workspaces.create({ name, root });
      return result.data.workspace.id;
    }, 'Workspace saved. Original files stay in their directory.');
  };
  const index = async (reindex) => {
    setIndexing(true);
    setProgress({ status: 'scanning' });
    await perform(async () => {
      const result = await apiService.workspaces.index(active.id, { reindex });
      const data = result.data;
      setNotice(
        `${data.documents?.length || 0} documents indexed${data.skipped?.length ? `; ${data.skipped.length} files skipped` : ''}.${data.limited ? ' First 500 files processed. Select a smaller directory for the rest.' : ''}`,
      );
    }, '');
    if (mounted.current) {
      setIndexing(false);
      setProgress(null);
    }
  };
  const importFiles = async (event) => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (!files.length || !active) return;
    if (files.length > 500) {
      setError('Import at most 500 files at once.');
      return;
    }
    const data = new FormData();
    data.append('purpose', 'workspace');
    data.append('workspaceId', active.id);
    for (const file of files) data.append('documents', file, file.name);
    data.append(
      'relativePaths',
      JSON.stringify(files.map((file) => file.webkitRelativePath || file.name)),
    );
    const controller = new AbortController();
    uploadController.current = controller;
    await perform(async () => {
      const result = await apiService.documents.upload(
        data,
        (event) =>
          setProgress({
            status: 'uploading',
            completed: event.total ? Math.round((event.loaded * 100) / event.total) : 0,
            total: 100,
          }),
        controller.signal,
      );
      setNotice(
        `${result.data.documents?.length || 0} workspace documents imported.${result.data.skipped?.length ? ` ${result.data.skipped.length} skipped.` : ''}`,
      );
    }, '');
    uploadController.current = null;
    setProgress(null);
  };
  const inputClass =
    'mt-1 w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-xs text-white outline-none focus:border-blue-400';
  const buttonClass =
    'rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-stone-300 hover:bg-white/10 disabled:opacity-40';
  const indexedPaths = new Set(documents.map((document) => document.relativePath));
  return (
    <div className="h-full overflow-y-auto p-4 text-stone-300">
      <div className="mx-auto max-w-3xl space-y-4">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold text-white">Workspace</h2>
            <p className="mt-1 text-xs text-stone-500">
              Browse local files and choose which documents the assistant can search.
            </p>
          </div>
          <button
            className={buttonClass}
            disabled={busy}
            onClick={() => perform(() => refresh(active?.id), 'Workspace refreshed.')}
            aria-label="Refresh workspace"
          >
            <RefreshCw size={14} />
          </button>
        </div>
        {workspaces.length > 0 && (
          <label className="block text-xs">
            Active workspace
            <select
              className={inputClass}
              value={active?.id || ''}
              disabled={busy}
              onChange={(event) =>
                perform(async () => {
                  await apiService.workspaces.activate(event.target.value);
                  await refresh(event.target.value);
                }, 'Workspace selected.')
              }
            >
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                  {workspace.available ? '' : ' (unavailable)'}
                </option>
              ))}
            </select>
          </label>
        )}
        {initialLoading && (
          <p role="status" className="text-xs text-stone-400">
            Loading workspaces…
          </p>
        )}
        <form
          onSubmit={save}
          className="rounded-xl border border-white/10 bg-white/[0.02] p-3 space-y-3"
        >
          <label className="block text-xs">
            Workspace name
            <input
              className={inputClass}
              required
              maxLength={100}
              disabled={initialLoading || busy}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="block text-xs">
            Local root directory
            <input
              className={inputClass}
              required
              value={root}
              disabled={initialLoading || busy}
              onChange={(event) => setRoot(event.target.value)}
              placeholder="Choose a document directory"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={buttonClass}
              disabled={busy || initialLoading}
              onClick={chooseDirectory}
            >
              Choose directory
            </button>
            <button className={buttonClass} disabled={busy || indexing || initialLoading}>
              {busy ? 'Working…' : active ? 'Save workspace' : 'Create workspace'}
            </button>
            {active && (
              <button
                type="button"
                className={buttonClass}
                disabled={busy}
                onClick={() => {
                  setActive(null);
                  setRoot('');
                  setName('');
                  setScan(null);
                  setDocuments([]);
                }}
              >
                New workspace
              </button>
            )}
          </div>
        </form>
        {error && (
          <p role="alert" className="text-xs text-red-300">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="text-xs text-emerald-300">
            {notice}
          </p>
        )}
        {active && (
          <>
            <div className="flex flex-wrap gap-3 text-xs text-stone-400">
              <span>{scan?.files || 0} local files</span>
              <span>{scan?.directories || 0} directories</span>
              <span>{scan?.supportedFiles || 0} supported</span>
              <span>{formatBytes(scan?.totalBytes || 0)}</span>
              <span>
                {documents.length} indexed documents · {indexing ? 'indexing' : active.indexState}
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              <button className={buttonClass} disabled={busy || !scan} onClick={() => index(false)}>
                Index new files
              </button>
              <button className={buttonClass} disabled={busy || !scan} onClick={() => index(true)}>
                Reindex
              </button>
              {indexing && (
                <button
                  className={buttonClass}
                  onClick={() =>
                    apiService.workspaces
                      .pause(active.id)
                      .catch(() => setError('Could not pause indexing.'))
                  }
                >
                  Pause indexing
                </button>
              )}
              <button
                className={buttonClass}
                disabled={busy}
                onClick={() =>
                  perform(
                    () => apiService.workspaces.removeIndex(active.id),
                    'Index removed. Your original files were preserved.',
                  )
                }
              >
                Remove index
              </button>
            </div>
            <p className="text-[11px] text-stone-500">
              Removing an index removes search data only. It never deletes files from your selected
              directory.
            </p>
            <div className="flex flex-wrap gap-2">
              <label className={`${buttonClass} cursor-pointer`}>
                <input
                  type="file"
                  multiple
                  accept={DOCUMENT_ACCEPT}
                  disabled={busy}
                  onChange={importFiles}
                  className="hidden"
                />
                <UploadCloud size={13} className="mr-1 inline" />
                Import files to workspace
              </label>
              <label className={`${buttonClass} cursor-pointer`}>
                <input
                  type="file"
                  multiple
                  webkitdirectory=""
                  directory=""
                  disabled={busy}
                  onChange={importFiles}
                  className="hidden"
                />
                Import folder to workspace
              </label>
              {uploadController.current && (
                <button className={buttonClass} onClick={() => uploadController.current.abort()}>
                  Cancel import
                </button>
              )}
            </div>
            <p className="text-[11px] text-stone-500">
              Imports are stored in this app's local workspace index. To browse a folder and its
              empty subdirectories, choose it as the root directory.
            </p>
            {progress && (
              <p role="status" className="text-xs text-blue-300">
                {progress.status === 'scanning'
                  ? `Scanning folders${progress.scanned ? ` · ${progress.scanned} entries` : ''}…`
                  : progress.status === 'uploading'
                    ? `Uploading ${progress.completed}%…`
                    : `Indexing ${progress.completed || 0}/${progress.total || 0}${progress.name ? ` · ${progress.name}` : ''}`}
              </p>
            )}
            <div className="rounded-xl border border-white/10 p-3">
              <div className="flex items-center justify-between gap-2 mb-2">
                <h3 className="text-xs font-semibold">Local directory files</h3>
                <label className="text-[10px] text-stone-500">
                  <input
                    type="checkbox"
                    checked={showUnsupported}
                    onChange={(event) => setShowUnsupported(event.target.checked)}
                  />{' '}
                  Show unsupported
                </label>
              </div>
              <div className="max-h-64 overflow-y-auto space-y-1">
                {scan?.entries
                  ?.filter(
                    (entry) => entry.type === 'directory' || entry.supported || showUnsupported,
                  )
                  .map((entry) => (
                    <div
                      key={entry.relativePath}
                      className="flex min-w-0 items-center gap-2 py-1 text-xs"
                      style={{
                        paddingLeft: `${Math.min(entry.depth, 8) * 12}px`,
                      }}
                    >
                      {entry.type === 'directory' ? (
                        <Folder size={13} className="shrink-0 text-blue-400" />
                      ) : (
                        <FileText size={13} className="shrink-0 text-stone-500" />
                      )}
                      <span className="min-w-0 flex-1 truncate" title={entry.relativePath}>
                        {entry.name}
                      </span>
                      <span className="shrink-0 text-[10px] text-stone-500">
                        {entry.type === 'file'
                          ? `${formatBytes(entry.size)} · ${indexedPaths.has(entry.relativePath) ? 'indexed' : entry.supported ? 'not indexed' : 'unsupported'}`
                          : 'directory'}
                      </span>
                    </div>
                  ))}
                {scan && !scan.entries.length && (
                  <p className="text-xs text-stone-500">This directory is empty.</p>
                )}
              </div>
              {scan?.truncated && (
                <p className="mt-2 text-xs text-amber-300">
                  Showing the first 10,000 entries. Choose a smaller directory to see all files.
                </p>
              )}
              {scan?.errors?.length > 0 && (
                <details className="mt-2 text-xs text-amber-300">
                  <summary>
                    {scan.errors.length} entries could not be read or were safely skipped
                  </summary>
                  {scan.errors.slice(0, 30).map((entry, i) => (
                    <p key={i} className="mt-1 break-words">
                      {entry.relativePath}: {entry.message}
                    </p>
                  ))}
                </details>
              )}
            </div>
            <div className="rounded-xl border border-white/10 p-3">
              <h3 className="mb-2 text-xs font-semibold">Indexed workspace documents</h3>
              {documents.length ? (
                documents.map((document) => (
                  <div
                    key={document.id}
                    className="flex items-center justify-between gap-2 py-1 text-xs"
                  >
                    <span className="truncate" title={document.relativePath || document.name}>
                      {document.name}
                    </span>
                    <span className="shrink-0 text-stone-500">
                      {document.status || 'ready'} · {document.chunks || 0} chunks
                    </span>
                  </div>
                ))
              ) : (
                <p className="text-xs text-stone-500">No documents indexed yet.</p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
