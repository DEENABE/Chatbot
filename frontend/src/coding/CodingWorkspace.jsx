import React, { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import {
  ArrowUp,
  Check,
  ChevronRight,
  Code2,
  Copy,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  GitCompareArrows,
  History,
  Loader2,
  MessageSquare,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  RotateCcw,
  Settings2,
  ShieldCheck,
  Square,
  Terminal,
  X,
} from 'lucide-react';
import { conversationTurns, taskActivity, taskDiagnostic } from './codingPresentation.js';
import './coding.css';

const list = (value) => (Array.isArray(value) ? value : []);
const asText = (value) => (typeof value === 'string' ? value : JSON.stringify(value, null, 2));
const statusLabel = (task) =>
  ({
    done: 'Changes ready',
    completed: 'Changes ready',
    blocked: 'Needs attention',
    error: 'Task stopped',
    failed: 'Task stopped',
    cancelled: 'Stopped',
    waiting_approval: 'Waiting for approval',
  })[task?.status] || 'Working on your project';

function Approval({ approval, busy, onDecision }) {
  return (
    <section className="coding-approval">
      <div className="flex items-center gap-2 font-medium">
        <ShieldCheck size={15} /> Review project action
      </div>
      <p className="mt-2 text-stone-400">
        {approval.message || 'Review this action before continuing.'}
      </p>
      <details className="mt-3">
        <summary className="cursor-pointer text-stone-300">
          {approval.tool || approval.action} — view details
        </summary>
        <pre className="coding-output mt-2">
          {asText({ params: approval.params, preview: approval.preview })}
        </pre>
      </details>
      <div className="mt-3 flex gap-2">
        <button className="coding-button" disabled={busy} onClick={() => onDecision(false)}>
          Reject
        </button>
        <button
          className="coding-button coding-button-primary"
          disabled={busy}
          onClick={() => onDecision(true)}
        >
          Allow once
        </button>
      </div>
    </section>
  );
}

function TaskTurn({ task, current, busy, running, onRetry, onSelectFile }) {
  const diagnostic = taskDiagnostic(task);
  const activity = taskActivity(task);
  return (
    <article className="coding-turn">
      <div className="coding-user-message">{task.goal}</div>
      <div className="coding-assistant-message">
        <div className="mb-4 flex items-center gap-2.5 text-xs">
          <span className="coding-avatar">
            <Code2 size={15} />
          </span>
          <span className="font-semibold text-stone-200">Chanakya</span>
          <span
            className={`ml-auto flex items-center gap-1.5 ${diagnostic ? 'text-amber-300' : 'text-stone-500'}`}
          >
            {current && running ? (
              <Loader2 size={12} className="animate-spin" />
            ) : task.status === 'done' ? (
              <Check size={12} />
            ) : null}
            {statusLabel(task)}
          </span>
        </div>
        {list(task.plan).length > 0 && (
          <details className="coding-plan" open={(current && running) || undefined}>
            <summary>
              Plan <span className="text-stone-600">· {task.plan.length} steps</span>
            </summary>
            <ol>
              {task.plan.map((step, i) => (
                <li key={i}>
                  <span>{i + 1}</span>
                  {step}
                </li>
              ))}
            </ol>
          </details>
        )}
        {activity.length > 0 && (
          <details className="coding-activity-summary" open={(current && running) || undefined}>
            <summary>
              {activity.length} project action{activity.length === 1 ? '' : 's'}{' '}
              <span className="text-stone-600">
                · {activity.filter((a) => a.status === 'done').length} completed
              </span>
            </summary>
            <div className="mt-2 space-y-2">
              {activity.map((action) => (
                <div key={action.id} className="flex items-start gap-2 text-xs text-stone-400">
                  {action.status === 'running' ? (
                    <Loader2 size={13} className="mt-0.5 shrink-0 animate-spin" />
                  ) : action.status === 'done' ? (
                    <Check size={13} className="mt-0.5 shrink-0 text-emerald-500" />
                  ) : (
                    <span className="text-amber-400">!</span>
                  )}
                  <div className="min-w-0">
                    <span>{action.tool}</span>
                    {action.path && (
                      <button
                        onClick={() => onSelectFile(action.path)}
                        className="ml-2 break-all text-stone-200 underline decoration-white/20 underline-offset-4"
                      >
                        {action.path}
                      </button>
                    )}
                    {action.error && <p className="mt-1 text-amber-300">{action.error}</p>}
                  </div>
                </div>
              ))}
            </div>
          </details>
        )}
        {task.summary && (
          <div className="coding-markdown">
            <ReactMarkdown>{task.summary}</ReactMarkdown>
          </div>
        )}
        {current && running && !task.summary && (
          <p className="text-sm leading-6 text-stone-400">
            {task.phase === 'plan'
              ? 'Reading the project and planning the next change…'
              : task.status === 'waiting_approval'
                ? 'Review the action below to continue.'
                : 'Making changes in your project…'}
          </p>
        )}
        {list(task.changes).length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2">
            {task.changes.map((change) => (
              <button
                key={change.path}
                onClick={() => onSelectFile(change.path, true)}
                className="coding-file-chip"
              >
                <FileCode2 size={13} />
                {change.path}
                <ChevronRight size={12} />
              </button>
            ))}
          </div>
        )}
        {diagnostic && (
          <div className="coding-diagnostic" role="alert">
            <p>{diagnostic.hint}</p>
            <details className="mt-2 text-xs text-stone-500">
              <summary>Error details</summary>
              <p className="mt-2 break-words font-mono">{diagnostic.code}</p>
              <p className="mt-1">{diagnostic.message}</p>
            </details>
            {current && (
              <button
                className="coding-button mt-3"
                disabled={busy || running}
                onClick={() => onRetry(task.goal)}
              >
                <RotateCcw size={13} /> Retry task
              </button>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

function SourceView({ content, diff = false }) {
  if (content === undefined || content === null)
    return (
      <div className="coding-empty-panel">
        <FileCode2 size={25} />
        <p>Select a file to view its code.</p>
      </div>
    );
  return (
    <div className="coding-source" aria-label={diff ? 'File diff' : 'File source'}>
      <pre>
        {String(content)
          .split('\n')
          .map((line, i) => (
            <div
              key={i}
              className={
                diff && line.startsWith('+') && !line.startsWith('+++')
                  ? 'coding-line-added'
                  : diff && line.startsWith('-') && !line.startsWith('---')
                    ? 'coding-line-removed'
                    : ''
              }
            >
              <span className="coding-line-number" aria-hidden="true">
                {i + 1}
              </span>
              <code>{line || ' '}</code>
            </div>
          ))}
      </pre>
    </div>
  );
}

export default function CodingWorkspace(props) {
  const {
    workspaces,
    workspaceId,
    onWorkspace,
    active,
    usableModels,
    model,
    onModel,
    contextWindow,
    onContext,
    contextChoices,
    loading,
    connected,
    writeAuthorized,
    busy,
    running,
    error,
    notice,
    entries,
    treeLimited,
    selectedFile,
    taskText,
    onTaskText,
    snapshot,
    turns,
    checkpoints,
    approvals,
    toolApproval,
    showConnect,
    onShowConnect,
    workspaceName,
    onWorkspaceName,
    workspaceRoot,
    onWorkspaceRoot,
    onConnect,
    onChooseFolder,
    onRefreshModels,
    onAuthorize,
    onStart,
    onStop,
    onSelectFile,
    onRefreshTree,
    onDecision,
    onToolDecision,
    onCheckpoint,
    onRestore,
  } = props;
  const [showSettings, setShowSettings] = useState(false);
  const [panel, setPanel] = useState('code');
  const [mobilePane, setMobilePane] = useState('chat');
  const [showFiles, setShowFiles] = useState(true);
  const [showArtifact, setShowArtifact] = useState(true);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');
  const bottom = useRef(null);
  const scroll = useRef(null);
  const pinned = useRef(true);
  const allTurns = conversationTurns(turns, snapshot);
  const changes = [
    ...new Map(
      allTurns.flatMap((turn) => list(turn.changes).map((change) => [change.path, change])),
    ).values(),
  ];
  const selectedChange = changes.find((change) => change.path === selectedFile?.path);
  const validations = list(snapshot?.validation);
  const ready = !loading && workspaceId && model && writeAuthorized && connected !== false;
  const locked = busy || running || Boolean(toolApproval);
  const selectFile = (path, diff = false) => {
    onSelectFile(path);
    setPanel(diff ? 'diff' : 'code');
    setShowArtifact(true);
    setMobilePane('code');
  };
  useEffect(() => {
    if (pinned.current) bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [snapshot?.id, snapshot?.events?.length, snapshot?.status, turns.length]);
  useEffect(() => {
    setCopied(false);
    setCopyError('');
  }, [selectedFile?.path, panel]);

  return (
    <div className="coding-workbench">
      <header className="coding-workbench-header">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="coding-avatar">
            <Code2 size={17} />
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-stone-100">Code</h2>
            <p className="truncate text-[11px] text-stone-500">
              {active?.name || 'Your local coding workspace'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="hidden items-center gap-1.5 text-[11px] text-stone-500 sm:flex">
            <span
              className={`h-1.5 w-1.5 rounded-full ${connected === false ? 'bg-amber-400' : 'bg-emerald-500'}`}
            />
            {connected === false ? 'Ollama offline' : 'Local workspace'}
          </span>
          <button
            className="coding-icon-button"
            title="Project settings"
            aria-label="Project settings"
            aria-expanded={showSettings}
            onClick={() => setShowSettings(!showSettings)}
          >
            <Settings2 size={16} />
          </button>
          <button
            className="coding-icon-button coding-artifact-toggle"
            title={showArtifact ? 'Hide code panel' : 'Show code panel'}
            aria-label={showArtifact ? 'Hide code panel' : 'Show code panel'}
            onClick={() => setShowArtifact(!showArtifact)}
          >
            {showArtifact ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
          </button>
        </div>
      </header>

      {(showSettings ||
        !workspaceId ||
        !model ||
        !writeAuthorized ||
        showConnect ||
        connected === false) && (
        <section className="coding-project-settings" aria-label="Project setup">
          <div className="grid gap-3 sm:grid-cols-2">
            <label>
              Project workspace
              <select
                value={workspaceId}
                disabled={locked}
                onChange={(e) => onWorkspace(e.target.value)}
              >
                <option value="">Select a project</option>
                {workspaces.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Installed coding model
              <select
                value={model}
                disabled={busy || running}
                onChange={(e) => onModel(e.target.value)}
              >
                <option value="">Select a model with tool support</option>
                {usableModels.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label || item.id}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {active && <p className="mt-2 break-all text-[11px] text-stone-500">{active.root}</p>}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              className="coding-button"
              disabled={locked}
              onClick={() => onShowConnect(!showConnect)}
            >
              <FolderOpen size={13} /> Connect project folder
            </button>
            <button
              className="coding-icon-button"
              aria-label="Refresh installed models"
              title="Refresh installed models"
              disabled={busy}
              onClick={onRefreshModels}
            >
              <RefreshCw size={14} />
            </button>
            {workspaceId && (
              <button
                className={`coding-button ${!writeAuthorized ? 'coding-button-primary' : ''}`}
                disabled={busy}
                onClick={onAuthorize}
              >
                <ShieldCheck size={13} />
                {writeAuthorized ? 'Revoke workspace changes' : 'Authorize workspace changes'}
              </button>
            )}
            <label className="coding-context-label">
              Context
              <select
                aria-label="Maximum coding context tokens"
                value={contextWindow}
                disabled={busy || running}
                onChange={(e) => onContext(Number(e.target.value))}
              >
                {contextChoices.map((size) => (
                  <option key={size} value={size}>
                    {size.toLocaleString()}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {loading && (
            <p className="mt-3 text-xs text-stone-500">Loading local projects and models…</p>
          )}
          {connected === false && (
            <p className="mt-3 text-xs text-amber-300">
              Start Ollama, then refresh the installed models.
            </p>
          )}
          {connected !== false && !loading && !usableModels.length && (
            <p className="mt-3 text-xs text-amber-300">
              No installed model reports tool support. Install a compatible model in Ollama, then
              refresh.
            </p>
          )}
          {showConnect && (
            <form className="coding-connect-form" onSubmit={onConnect}>
              <label>
                Workspace name
                <input
                  value={workspaceName}
                  required
                  maxLength={120}
                  onChange={(e) => onWorkspaceName(e.target.value)}
                  placeholder="My project"
                />
              </label>
              <label>
                Existing local project folder
                <input
                  value={workspaceRoot}
                  required
                  maxLength={4096}
                  onChange={(e) => onWorkspaceRoot(e.target.value)}
                  placeholder="D:\\projects\\my-app"
                />
              </label>
              <div className="flex gap-2">
                {window.workspaceAPI && (
                  <button
                    type="button"
                    className="coding-button"
                    disabled={busy}
                    onClick={onChooseFolder}
                  >
                    Choose folder
                  </button>
                )}
                <button className="coding-button coding-button-primary" disabled={busy}>
                  Connect workspace
                </button>
              </div>
            </form>
          )}
        </section>
      )}
      {error && (
        <div className="coding-global-error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="coding-notice" role="status">
          {notice}
        </div>
      )}

      <nav className="coding-mobile-tabs" aria-label="Coding views">
        <button
          aria-current={mobilePane === 'chat' ? 'page' : undefined}
          onClick={() => setMobilePane('chat')}
        >
          <MessageSquare size={14} /> Chat
        </button>
        <button
          aria-current={mobilePane === 'code' ? 'page' : undefined}
          onClick={() => {
            setShowArtifact(true);
            setMobilePane('code');
          }}
        >
          <Code2 size={14} /> Code {changes.length > 0 && <span>{changes.length}</span>}
        </button>
      </nav>

      <div className={`coding-workbench-body ${showArtifact ? '' : 'coding-artifact-hidden'}`}>
        <section
          className={`coding-conversation ${mobilePane === 'chat' ? 'coding-mobile-active' : ''}`}
          aria-label="Coding conversation"
        >
          <div
            ref={scroll}
            className="coding-conversation-scroll"
            onScroll={() => {
              const el = scroll.current;
              pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
            }}
          >
            {allTurns.length === 0 ? (
              <div className="coding-welcome">
                <span className="coding-welcome-icon">
                  <Code2 size={28} strokeWidth={1.4} />
                </span>
                <h3>What would you like to build?</h3>
                <p>
                  Describe your idea, fix a bug, or improve your project.
                  <br />
                  Follow the conversation here. Review the code alongside it.
                </p>
                <div className="coding-suggestions">
                  {[
                    'Explain this project',
                    'Create a React + Vite website',
                    'Find and fix a bug',
                  ].map((suggestion) => (
                    <button
                      key={suggestion}
                      onClick={() => {
                        onTaskText(suggestion);
                        pinned.current = true;
                      }}
                    >
                      {suggestion}
                      <ChevronRight size={13} />
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              allTurns.map((task) => (
                <TaskTurn
                  key={task.id}
                  task={task}
                  current={task.id === snapshot?.id}
                  busy={busy}
                  running={running && task.id === snapshot?.id}
                  onRetry={onStart}
                  onSelectFile={selectFile}
                />
              ))
            )}
            {approvals.map((approval) => (
              <Approval
                key={approval.approvalId || approval.id}
                approval={approval}
                busy={busy}
                onDecision={(approved) => onDecision(approval, approved)}
              />
            ))}
            {toolApproval && (
              <Approval approval={toolApproval} busy={busy} onDecision={onToolDecision} />
            )}
            <div ref={bottom} />
          </div>
          <form
            className="coding-composer-wrap"
            onSubmit={(e) => {
              e.preventDefault();
              pinned.current = true;
              onStart();
            }}
          >
            <div className="coding-composer">
              <textarea
                aria-label="Message the coding agent"
                value={taskText}
                onChange={(e) => onTaskText(e.target.value)}
                maxLength={12000}
                disabled={running}
                placeholder={
                  allTurns.length
                    ? 'Ask for a change or continue building…'
                    : 'Describe what you want to build…'
                }
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    if (ready && !locked && taskText.trim()) e.currentTarget.form.requestSubmit();
                  }
                }}
              />
              <div className="coding-composer-toolbar">
                <span className="min-w-0 truncate text-[11px] text-stone-500">
                  {model || 'Choose a coding model'}
                  {ready && ' · Project access enabled'}
                </span>
                {running ? (
                  <button
                    type="button"
                    className="coding-send coding-stop"
                    aria-label="Stop task"
                    disabled={busy}
                    onClick={onStop}
                  >
                    <Square size={14} fill="currentColor" />
                  </button>
                ) : (
                  <button
                    type="submit"
                    className="coding-send"
                    aria-label="Send coding message"
                    title={
                      !ready
                        ? 'Connect a project, choose a model and authorize changes first'
                        : 'Send message (Enter)'
                    }
                    disabled={locked || !ready || !taskText.trim()}
                  >
                    {busy ? <Loader2 size={17} className="animate-spin" /> : <ArrowUp size={19} />}
                  </button>
                )}
              </div>
            </div>
            <p className="coding-composer-caption">
              {!ready
                ? 'Connect a project and enable workspace changes to begin.'
                : 'Changes stay on this computer. Review approvals before continuing.'}
            </p>
          </form>
        </section>

        {showArtifact && (
          <section
            className={`coding-artifact ${mobilePane === 'code' ? 'coding-mobile-active' : ''}`}
            aria-label="Project code panel"
          >
            <header className="coding-artifact-header">
              <button
                className="coding-icon-button"
                title={showFiles ? 'Hide project files' : 'Show project files'}
                aria-label={showFiles ? 'Hide project files' : 'Show project files'}
                onClick={() => setShowFiles(!showFiles)}
              >
                <FolderOpen size={15} />
              </button>
              <span className="min-w-0 flex-1 truncate text-xs text-stone-300">
                {selectedFile?.path || 'Project files'}
              </span>
              <button
                className="coding-icon-button"
                aria-label="Refresh project files"
                disabled={!workspaceId || busy}
                onClick={onRefreshTree}
              >
                <RefreshCw size={13} />
              </button>
              <button
                className="coding-icon-button"
                aria-label="Close code panel"
                onClick={() => {
                  setShowArtifact(false);
                  setMobilePane('chat');
                }}
              >
                <X size={15} />
              </button>
            </header>
            <div className="coding-artifact-content">
              {showFiles && (
                <aside className="coding-file-tree" aria-label="Project files">
                  <div className="coding-tree-heading">
                    EXPLORER <span>{entries.length}</span>
                  </div>
                  {entries.slice(0, 1500).map((entry) => {
                    const path = entry.path || entry.relativePath;
                    const directory = entry.type === 'directory';
                    const Icon = directory ? Folder : FileText;
                    return (
                      <button
                        key={path}
                        disabled={directory}
                        className={selectedFile?.path === path ? 'coding-file-selected' : ''}
                        style={{
                          paddingLeft: `${10 + Math.min(path?.split(/[\\/]/).length - 1 || 0, 6) * 10}px`,
                        }}
                        onClick={() => selectFile(path)}
                        title={path}
                      >
                        <Icon size={12} />
                        <span>{path?.split(/[\\/]/).at(-1)}</span>
                        {changes.some((c) => c.path === path) && (
                          <span className="coding-file-modified">M</span>
                        )}
                      </button>
                    );
                  })}
                  {!entries.length && (
                    <p className="p-3 text-xs leading-5 text-stone-600">
                      {workspaceId
                        ? 'Files will appear here as your project grows.'
                        : 'Connect a project folder to browse its files.'}
                    </p>
                  )}
                  {treeLimited && (
                    <p className="p-3 text-[11px] text-stone-500">Showing a limited file list.</p>
                  )}
                </aside>
              )}
              <div className="coding-editor">
                <nav className="coding-editor-tabs" aria-label="Code panel views">
                  {[
                    ['code', 'Code', FileCode2],
                    ['diff', 'Diff', GitCompareArrows],
                    ['activity', 'Activity', Terminal],
                    ['checks', 'Checks', ShieldCheck],
                  ].map(([id, label, Icon]) => (
                    <button
                      key={id}
                      aria-current={panel === id ? 'page' : undefined}
                      onClick={() => setPanel(id)}
                    >
                      <Icon size={13} />
                      {label}
                      {id === 'diff' && changes.length > 0 && <span>{changes.length}</span>}
                    </button>
                  ))}
                </nav>
                {(panel === 'code' || panel === 'diff') && (
                  <div className="coding-editor-toolbar">
                    <span className="truncate">
                      {panel === 'diff'
                        ? 'Recorded changes'
                        : selectedFile?.path?.split('.').at(-1)?.toUpperCase() || 'SOURCE'}
                    </span>
                    {selectedFile && !selectedFile.loading && !selectedFile.error && (
                      <button
                        aria-label="Copy code"
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(
                              panel === 'diff'
                                ? selectedChange?.diff || ''
                                : selectedFile.content || '',
                            );
                            setCopied(true);
                          } catch {
                            setCopyError('Copy is unavailable. Select and copy the code directly.');
                          }
                        }}
                      >
                        {copied ? <Check size={12} /> : <Copy size={12} />}
                        {copied ? 'Copied' : 'Copy'}
                      </button>
                    )}
                  </div>
                )}
                {copyError && (
                  <p role="status" className="p-2 text-xs text-amber-300">
                    {copyError}
                  </p>
                )}
                {panel === 'code' &&
                  (selectedFile?.loading ? (
                    <div className="coding-empty-panel">
                      <Loader2 className="animate-spin" size={22} />
                      <p>Reading file…</p>
                    </div>
                  ) : selectedFile?.error ? (
                    <div className="coding-empty-panel text-amber-300" role="alert">
                      {selectedFile.error}
                    </div>
                  ) : (
                    <SourceView content={selectedFile?.content} />
                  ))}
                {panel === 'diff' && (
                  <>
                    {changes.length > 0 && (
                      <div className="coding-change-picker">
                        {changes.map((change) => (
                          <button
                            key={change.path}
                            className={selectedFile?.path === change.path ? 'active' : ''}
                            onClick={() => selectFile(change.path, true)}
                          >
                            {change.path}
                          </button>
                        ))}
                      </div>
                    )}
                    {selectedChange?.diff ? (
                      <SourceView content={selectedChange.diff} diff />
                    ) : (
                      <div className="coding-empty-panel">
                        <GitCompareArrows size={25} />
                        <p>
                          {changes.length
                            ? 'Select a changed file to inspect its diff.'
                            : 'Code changes will appear here.'}
                        </p>
                      </div>
                    )}
                  </>
                )}
                {panel === 'activity' && (
                  <div className="coding-inspector-scroll">
                    {taskActivity(snapshot).map((action) => (
                      <details key={action.id} className="coding-inspector-card">
                        <summary className="flex items-center gap-2">
                          <Terminal size={13} />
                          <span>{action.tool}</span>
                          <span className="ml-auto text-stone-500">{action.status}</span>
                        </summary>
                        {action.path && (
                          <p className="mt-2 break-all text-stone-400">{action.path}</p>
                        )}
                        {action.error && <p className="mt-2 text-amber-300">{action.error}</p>}
                        <pre className="coding-output mt-2">
                          {asText(action.data || 'No result yet.')}
                        </pre>
                      </details>
                    ))}
                    {!taskActivity(snapshot).length && (
                      <p className="text-xs text-stone-500">
                        Executed project actions and their results appear here.
                      </p>
                    )}
                    {snapshot?.id && (
                      <p className="mt-4 break-all text-[10px] text-stone-600">
                        Task {snapshot.id}
                      </p>
                    )}
                  </div>
                )}
                {panel === 'checks' && (
                  <div className="coding-inspector-scroll">
                    <h3 className="mb-3 text-xs font-medium text-stone-200">Validation & tests</h3>
                    {validations.length ? (
                      validations.map((item, i) => (
                        <div key={i} className="coding-inspector-card">
                          <p
                            className={
                              item.status === 'passed' ? 'text-emerald-400' : 'text-amber-300'
                            }
                          >
                            {item.kind} · {item.status}
                          </p>
                          <pre className="coding-output mt-2">{asText(item)}</pre>
                        </div>
                      ))
                    ) : (
                      <p className="text-xs leading-5 text-stone-500">
                        No build or test command has run. Run project commands in your terminal;
                        this runtime supports guarded file changes.
                      </p>
                    )}
                    <div className="mt-7 flex items-center justify-between gap-2">
                      <h3 className="flex items-center gap-2 text-xs font-medium text-stone-200">
                        <History size={13} /> Checkpoints
                      </h3>
                      <button
                        className="coding-button"
                        disabled={locked || !writeAuthorized || !workspaceId}
                        onClick={onCheckpoint}
                      >
                        Create checkpoint
                      </button>
                    </div>
                    <p className="mt-2 text-xs leading-5 text-stone-500">
                      Restore changes made by the agent from a saved checkpoint.
                    </p>
                    {checkpoints.map((checkpoint) => (
                      <div
                        key={checkpoint.checkpointId || checkpoint.id}
                        className="coding-inspector-card mt-3"
                      >
                        <p className="text-xs text-stone-300">
                          {checkpoint.label || checkpoint.name || 'Project checkpoint'}
                        </p>
                        <p className="mt-1 text-[11px] text-stone-600">
                          {checkpoint.createdAt
                            ? new Date(checkpoint.createdAt).toLocaleString()
                            : ''}
                        </p>
                        <button
                          className="coding-button mt-3"
                          disabled={locked || !writeAuthorized}
                          onClick={() => onRestore(checkpoint.checkpointId || checkpoint.id)}
                        >
                          Review restore
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
