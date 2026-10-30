import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ArrowUp,
  Check,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Hand,
  Laptop,
  Loader2,
  Lock,
  Mic,
  Paperclip,
  Plus,
  RefreshCw,
  Square,
  TriangleAlert,
  X,
  Zap,
} from 'lucide-react';
import { transcribe, warmUpTranscriber } from '../services/transcriber.js';

export const ACCESS_MODES = [
  {
    id: 'readonly',
    label: 'Read only',
    icon: Lock,
    detail: 'Agent cannot change files or run commands.',
  },
  {
    id: 'manual',
    label: 'Manual',
    icon: Hand,
    detail: 'Edits files, installs packages and builds. You approve risky actions.',
  },
  {
    id: 'automatic',
    label: 'Auto',
    icon: Zap,
    detail: 'Edits, commands and installs run without asking — inside this project only.',
  },
];
// Derived (not selectable): edits allowed but project commands are off.
const EDIT_ONLY = {
  id: 'editonly',
  label: 'Edit only',
  icon: TriangleAlert,
  detail: 'Commands are off, so packages cannot be installed or built. Choose Manual or Auto.',
};

// Popover anchored to its parent; closes on outside click or Escape.
function Popover({ open, onClose, children, align = 'left', label, wide }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event) => {
      if (ref.current && !ref.current.parentElement.contains(event.target)) onClose();
    };
    const onKey = (event) => event.key === 'Escape' && onClose();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      className={`cc-popover cc-popover-${align} ${wide ? 'cc-popover-wide' : ''}`}
    >
      {children}
    </div>
  );
}

function useDictation(onText) {
  const [state, setState] = useState('idle'); // idle | recording | transcribing
  const [error, setError] = useState('');
  const recorder = useRef(null);
  const chunks = useRef([]);
  useEffect(
    () => () => {
      if (recorder.current?.state === 'recording') recorder.current.stop();
    },
    [],
  );
  const start = async () => {
    setError('');
    try {
      warmUpTranscriber();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunks.current = [];
      rec.ondataavailable = (event) => event.data.size && chunks.current.push(event.data);
      rec.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        setState('transcribing');
        try {
          const blob = new Blob(chunks.current, { type: rec.mimeType || 'audio/webm' });
          const { text } = await transcribe(blob);
          if (text) onText(text);
          else setError('Did not catch that. Try again a little closer to the mic.');
        } catch (failure) {
          setError(failure?.response?.data?.error || 'Could not transcribe that recording.');
        } finally {
          setState('idle');
        }
      };
      recorder.current = rec;
      rec.start();
      setState('recording');
    } catch {
      setError('Microphone is unavailable. Allow mic access and try again.');
      setState('idle');
    }
  };
  const stop = () => recorder.current?.state === 'recording' && recorder.current.stop();
  return {
    state,
    error,
    toggle: () => (state === 'recording' ? stop() : state === 'idle' && start()),
  };
}

/** Circular context-usage ring; speed in the tooltip. */
function LimitRing({ usage }) {
  const pct = usage ? Math.min(1, usage.used / usage.limit) : 0;
  const r = 7;
  const c = 2 * Math.PI * r;
  const tone = pct > 0.9 ? '#e0715f' : pct > 0.7 ? '#e7b56b' : '#6f9fe8';
  const title = usage
    ? `Context used: ${usage.used.toLocaleString()} / ${usage.limit.toLocaleString()} tokens (${Math.round(pct * 100)}%)` +
      (usage.speed ? ` · ${usage.speed.toFixed(1)} tokens/s` : '')
    : 'Context usage appears after the first step';
  return (
    <span className="cc-ring" title={title} aria-label={title} role="img">
      <svg width="20" height="20" viewBox="0 0 20 20">
        <circle cx="10" cy="10" r={r} fill="none" stroke="#ffffff22" strokeWidth="2.4" />
        <circle
          cx="10"
          cy="10"
          r={r}
          fill="none"
          stroke={tone}
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeDasharray={`${c * pct} ${c}`}
          transform="rotate(-90 10 10)"
        />
      </svg>
    </span>
  );
}

function NewProjectForm({
  newProjectName,
  onNewProjectName,
  newProjectParent,
  onNewProjectParent,
  onChooseProjectParent,
  busy,
  onCreate,
}) {
  return (
    <div className="cc-form">
      <div className="cc-sep">New project</div>
      <label>
        Name
        <input
          autoFocus
          value={newProjectName}
          maxLength={64}
          onChange={(event) => onNewProjectName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              if (newProjectName.trim()) onCreate();
            }
          }}
          placeholder="my-new-app"
        />
      </label>
      <label>
        Location
        <span className="cc-form-row">
          <input
            value={newProjectParent || ''}
            maxLength={4096}
            onChange={(event) => onNewProjectParent(event.target.value)}
            placeholder="Documents\ChanakyaProjects"
          />
          <button type="button" disabled={busy} onClick={onChooseProjectParent}>
            Browse
          </button>
        </span>
      </label>
      <button
        type="button"
        className="cc-primary"
        disabled={busy || !newProjectName.trim()}
        onClick={onCreate}
      >
        Create project
      </button>
    </div>
  );
}

export default function CodingComposer({
  taskText,
  onTaskText,
  placeholder,
  ready,
  locked,
  busy,
  running,
  onSubmit,
  onStop,
  // model + context
  usableModels,
  model,
  onModel,
  modelsLoading,
  modelError,
  connected,
  onRefreshModels,
  contextWindow,
  contextChoices = [],
  onContext,
  usage,
  // projects + files
  workspaces,
  workspaceId,
  activeName,
  runningWorkspaces = [],
  onWorkspace,
  onOpenFolder,
  onOpenPath,
  newProjectName,
  onNewProjectName,
  newProjectParent,
  onNewProjectParent,
  onChooseProjectParent,
  onCreateProject,
  attachments,
  onAttachFiles,
  onRemoveAttachment,
  // access
  accessMode,
  onAccessMode,
  hint,
}) {
  const [menu, setMenu] = useState(null); // add | folder | newproject | access | model
  const [pathText, setPathText] = useState('');
  const fileInput = useRef(null);
  const textarea = useRef(null);
  const close = () => setMenu(null);
  const toggle = (name) => setMenu((current) => (current === name ? null : name));
  const dictation = useDictation((text) => {
    onTaskText((current) => (current?.trim() ? `${current.trim()} ${text}` : text));
    textarea.current?.focus();
  });
  // Auto-grow: one line like a chat box, up to ~8 lines.
  useLayoutEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [taskText]);
  const mode =
    ACCESS_MODES.find((item) => item.id === accessMode) ||
    (accessMode === 'editonly' ? EDIT_ONLY : ACCESS_MODES[0]);
  const ModeIcon = mode.icon;
  const canSend = ready && !locked && taskText.trim();
  const ctxLabel = contextWindow ? `${Math.round(contextWindow / 1024)}K` : '';
  const openPath = () => {
    if (!pathText.trim()) return;
    onOpenPath(pathText.trim());
    setPathText('');
    close();
  };
  const caption =
    dictation.state === 'recording'
      ? 'Listening… press the stop button when you are done.'
      : dictation.error || hint;

  return (
    <form
      className="coding-composer-wrap cc2"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSend) onSubmit();
      }}
    >
      <div className="cc2-box">
        {attachments.length > 0 && (
          <div className="cc-attachments">
            {attachments.map((file) => (
              <span key={file.name} className="cc-chip-file" title={`${file.name} · ${file.size} chars`}>
                <FileText size={12} />
                <span>{file.name}</span>
                <button
                  type="button"
                  aria-label={`Remove ${file.name}`}
                  onClick={() => onRemoveAttachment(file.name)}
                >
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="cc2-row">
          <div className="cc-anchor">
            <button
              type="button"
              className="cc-icon"
              aria-label="Add files or folders"
              title="Add files or folders"
              aria-expanded={menu === 'add' || menu === 'newproject'}
              onClick={() => toggle('add')}
            >
              <Plus size={19} />
            </button>
            <Popover open={menu === 'add'} onClose={close} label="Add">
              <button
                type="button"
                className="cc-item"
                onClick={() => {
                  close();
                  fileInput.current?.click();
                }}
              >
                <Paperclip size={14} />
                <span>
                  Attach files
                  <small>Text / code files sent with this message</small>
                </span>
              </button>
              <button
                type="button"
                className="cc-item"
                onClick={() => {
                  close();
                  onOpenFolder();
                }}
              >
                <FolderOpen size={14} />
                <span>
                  Open project folder
                  <small>Any folder on this PC</small>
                </span>
              </button>
              <button type="button" className="cc-item" onClick={() => setMenu('newproject')}>
                <FolderPlus size={14} />
                <span>
                  New project
                  <small>Create an empty project folder</small>
                </span>
              </button>
            </Popover>
            <Popover open={menu === 'newproject'} onClose={close} label="New project" wide>
              <NewProjectForm
                {...{
                  newProjectName,
                  onNewProjectName,
                  newProjectParent,
                  onNewProjectParent,
                  onChooseProjectParent,
                  busy,
                }}
                onCreate={() => {
                  onCreateProject({ preventDefault() {} });
                  close();
                }}
              />
            </Popover>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(event) => {
                onAttachFiles([...event.target.files]);
                event.target.value = '';
              }}
            />
          </div>
          <textarea
            ref={textarea}
            rows={1}
            aria-label="Message the coding agent"
            value={taskText}
            onChange={(event) => onTaskText(event.target.value)}
            maxLength={12000}
            disabled={running}
            placeholder={
              running ? 'Working… you can switch to another project meanwhile' : placeholder
            }
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                if (canSend) event.currentTarget.form.requestSubmit();
              }
            }}
          />
          <button
            type="button"
            className={`cc-icon ${dictation.state === 'recording' ? 'cc-recording' : ''}`}
            aria-label={dictation.state === 'recording' ? 'Stop dictation' : 'Dictate'}
            title={dictation.state === 'recording' ? 'Stop and transcribe' : 'Speak your request'}
            disabled={running || dictation.state === 'transcribing'}
            onClick={dictation.toggle}
          >
            {dictation.state === 'transcribing' ? (
              <Loader2 size={17} className="animate-spin" />
            ) : dictation.state === 'recording' ? (
              <Square size={13} fill="currentColor" />
            ) : (
              <Mic size={18} />
            )}
          </button>
          {running ? (
            <button
              type="button"
              className="coding-send coding-stop"
              aria-label="Stop task"
              title="Stop task"
              disabled={busy}
              onClick={onStop}
            >
              <Square size={12} fill="currentColor" />
            </button>
          ) : (
            taskText.trim() && (
              <button
                type="submit"
                className="coding-send"
                aria-label="Send coding message"
                title={ready ? 'Send (Enter)' : hint}
                disabled={!canSend}
              >
                {busy ? <Loader2 size={15} className="animate-spin" /> : <ArrowUp size={17} />}
              </button>
            )
          )}
        </div>
      </div>

      <div className="cc2-meta">
        <div className="cc2-meta-left">
          <span className="cc2-static" title="Runs on this computer with local models">
            <Laptop size={15} /> <span className="cc2-hide-sm">This computer</span>
          </span>

          <div className="cc-anchor">
            <button
              type="button"
              className="cc-chip"
              aria-label="Project folder"
              aria-expanded={menu === 'folder'}
              title="Switch or open a project"
              onClick={() => toggle('folder')}
            >
              <Folder size={15} />
              <span className="cc-chip-text">{activeName || 'Open folder'}</span>
              {runningWorkspaces.includes(workspaceId) && <span className="cc-live" />}
            </button>
            <Popover open={menu === 'folder'} onClose={close} label="Projects" wide>
              {workspaces.length > 0 && <div className="cc-sep">Projects</div>}
              {workspaces.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="cc-item cc-item-compact"
                  title={item.root}
                  disabled={busy}
                  onClick={() => {
                    close();
                    onWorkspace(item.id);
                  }}
                >
                  {item.id === workspaceId ? <Check size={13} /> : <span className="cc-dot" />}
                  <span className="cc-proj">
                    <span className="truncate">{item.name}</span>
                    <small className="truncate">{item.root}</small>
                  </span>
                  {runningWorkspaces.includes(item.id) && (
                    <span className="cc-running">
                      <Loader2 size={11} className="animate-spin" /> running
                    </span>
                  )}
                </button>
              ))}
              <div className="cc-divider" />
              <button
                type="button"
                className="cc-item cc-item-compact"
                onClick={() => {
                  close();
                  onOpenFolder();
                }}
              >
                <FolderOpen size={14} />
                <span>Open folder…</span>
              </button>
              <button
                type="button"
                className="cc-item cc-item-compact"
                onClick={() => setMenu('newproject')}
              >
                <FolderPlus size={14} />
                <span>New project…</span>
              </button>
              <div className="cc-path">
                <input
                  value={pathText}
                  onChange={(event) => setPathText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      openPath();
                    }
                  }}
                  placeholder="or paste a path, e.g. D:\projects\my-app"
                  aria-label="Folder path"
                />
                <button type="button" disabled={!pathText.trim()} onClick={openPath}>
                  Open
                </button>
              </div>
            </Popover>
          </div>

          <div className="cc-anchor">
            <button
              type="button"
              className={`cc-chip cc-mode-${mode.id}`}
              aria-label={`Access: ${mode.label}`}
              aria-expanded={menu === 'access'}
              disabled={busy || running || !workspaceId}
              title={workspaceId ? mode.detail : 'Open a project folder first'}
              onClick={() => toggle('access')}
            >
              <ModeIcon size={14} />
              <span className="cc-chip-text">{mode.label}</span>
            </button>
            <Popover open={menu === 'access'} onClose={close} label="Access" wide>
              {ACCESS_MODES.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`cc-item ${item.id === mode.id ? 'cc-item-active' : ''}`}
                    onClick={() => {
                      close();
                      onAccessMode(item.id);
                    }}
                  >
                    <Icon size={14} />
                    <span>
                      {item.id === 'automatic' ? 'Automatic' : item.label}
                      <small>{item.detail}</small>
                    </span>
                    {item.id === mode.id && <Check size={13} className="ml-auto" />}
                  </button>
                );
              })}
            </Popover>
          </div>
        </div>

        <div className="cc2-meta-right">
          <div className="cc-anchor">
            <button
              type="button"
              className={`cc-chip ${connected === false || modelError ? 'cc-warn' : ''}`}
              aria-label="Coding model"
              aria-expanded={menu === 'model'}
              disabled={busy || running}
              onClick={() => toggle('model')}
            >
              <span className="cc-chip-text">
                {modelsLoading
                  ? 'Loading…'
                  : connected === false
                    ? 'Ollama offline'
                    : model || 'Choose model'}
              </span>
              {ctxLabel && <span className="cc-dim">{ctxLabel}</span>}
            </button>
            <Popover open={menu === 'model'} onClose={close} align="right" label="Model" wide>
              <div className="cc-sep">Local models (Ollama)</div>
              {usableModels.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="cc-item cc-item-compact"
                  onClick={() => onModel(item.id)}
                >
                  {item.id === model ? <Check size={13} /> : <span className="cc-dot" />}
                  <span className="truncate">{item.id}</span>
                  {item.size > 0 && (
                    <small className="cc-size">{(item.size / 1024 ** 3).toFixed(1)} GB</small>
                  )}
                </button>
              ))}
              {!usableModels.length && (
                <p className="cc-empty">
                  {modelError || 'No tool-capable local model found. Install one in Ollama.'}
                </p>
              )}
              {contextChoices.length > 0 && (
                <>
                  <div className="cc-sep">Context window</div>
                  <div className="cc-segment">
                    {contextChoices.map((size) => (
                      <button
                        key={size}
                        type="button"
                        className={size === contextWindow ? 'active' : ''}
                        onClick={() => onContext(size)}
                      >
                        {Math.round(size / 1024)}K
                      </button>
                    ))}
                  </div>
                  <p className="cc-empty">Bigger remembers more, but is slower and uses more memory.</p>
                </>
              )}
              <button
                type="button"
                className="cc-item cc-item-compact cc-item-muted"
                disabled={modelsLoading}
                onClick={onRefreshModels}
              >
                <RefreshCw size={13} className={modelsLoading ? 'animate-spin' : ''} />
                <span>Refresh models</span>
              </button>
            </Popover>
          </div>
          <LimitRing usage={usage} />
        </div>
      </div>
      {caption && <p className="coding-composer-caption">{caption}</p>}
    </form>
  );
}
