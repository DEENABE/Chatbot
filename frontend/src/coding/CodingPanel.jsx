import React, { useCallback, useEffect, useRef, useState } from 'react';
import CodingWorkspace from './CodingWorkspace.jsx';
import * as apiService from '../services/api.js';
import { useAppStore } from '../stores/useAppStore.js';
import { isCodingModel, preferredCodingModel, retryDelay } from './codingRequests.js';

const list = (value) => (Array.isArray(value) ? value : []);
const message = (error) => {
  const detail = error?.response?.data?.error || error?.error || error?.message || error;
  return typeof detail === 'string'
    ? detail
    : detail?.message || 'The coding action could not be completed.';
};
const body = (result) => result?.data || result || {};

// Attached files travel inside the task text (backend limit 16000 chars; keep
// room for an 8k-token context too).
const ATTACH_BUDGET = 6000;
export function withAttachments(text, files) {
  if (!files?.length) return text;
  let room = Math.min(ATTACH_BUDGET, 15500 - text.length);
  const parts = [];
  for (const file of files) {
    if (room < 200) {
      parts.push(`[Attached file ${file.name}: omitted, message too long]`);
      continue;
    }
    const content = file.text.length > room ? `${file.text.slice(0, room)}\n…(truncated)` : file.text;
    room -= content.length + file.name.length + 40;
    parts.push(`[Attached file: ${file.name}]\n\`\`\`\n${content}\n\`\`\``);
  }
  return `${text}\n\n${parts.join('\n\n')}`;
}
const taskBody = (response) => response.data?.task || response.data;
const terminal = (task) => {
  if (!task) return true;
  if (list(task.approvals).some((approval) => !approval.status || approval.status === 'pending'))
    return false;
  const ended = ['done', 'completed', 'cancelled', 'error', 'failed', 'blocked'];
  return ended.includes(task.status) || ended.includes(task.phase);
};
const storedTaskKey = (userId, workspaceId) => `chanakya-coding-task:${userId}:${workspaceId}`;
const pendingApprovals = (task) =>
  list(task?.approvals).filter((approval) => !approval.status || approval.status === 'pending');

export default function CodingPanel() {
  const user = useAppStore((state) => state.user);
  const activeWorkspaceId = useAppStore((state) => state.activeWorkspaceId);
  const setActiveWorkspaceId = useAppStore((state) => state.setActiveWorkspaceId);
  const [workspaces, setWorkspaces] = useState([]);
  const [workspaceId, setWorkspaceId] = useState(activeWorkspaceId || '');
  const [models, setModels] = useState([]);
  // The coding model is chosen separately from the chat model and remembered per viewer.
  const [model, setModelState] = useState(() => {
    try {
      return localStorage.getItem('chanakya-coding-model') || '';
    } catch {
      return '';
    }
  });
  const setModel = useCallback((value) => {
    setModelState((current) => {
      const next = typeof value === 'function' ? value(current) : value;
      try {
        if (next) localStorage.setItem('chanakya-coding-model', next);
      } catch {}
      return next;
    });
  }, []);
  const [contextWindow, setContextWindow] = useState(8192);
  const [connected, setConnected] = useState(null);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelError, setModelError] = useState('');
  const [writeAuthorized, setWriteAuthorized] = useState(false);
  // Composer: attached text files and Manual/Automatic preference (Read only = no write grant).
  const [attachments, setAttachments] = useState([]);
  const [autoMode, setAutoMode] = useState(() => {
    try {
      return localStorage.getItem('chanakya-coding-access') === 'automatic';
    } catch {
      return false;
    }
  });
  const autoApproved = useRef(new Set());
  const [runtimeInfo, setRuntimeInfo] = useState(null);
  const [runtimeError, setRuntimeError] = useState('');
  const [entries, setEntries] = useState([]);
  const [treeLimited, setTreeLimited] = useState(false);
  const [selectedFile, setSelectedFile] = useState(null);
  const [taskText, setTaskText] = useState('');
  const [snapshot, setSnapshot] = useState(null);
  const [turns, setTurns] = useState([]);
  const [checkpoints, setCheckpoints] = useState([]);
  const [toolApproval, setToolApproval] = useState(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [workspaceName, setWorkspaceName] = useState('');
  const [workspaceRoot, setWorkspaceRoot] = useState('');
  const [showConnect, setShowConnect] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  // Where new projects are created; empty = backend default (Documents\ChanakyaProjects).
  const [newProjectParent, setNewProjectParent] = useState(() => {
    try {
      return localStorage.getItem('chanakya-projects-parent') || '';
    } catch {
      return '';
    }
  });
  const workspaceRef = useRef(workspaceId);
  const readRevision = useRef(0);
  const taskRevision = useRef(0);
  const mounted = useRef(true);
  const busyOperations = useRef(0);
  const modelRetryDelay = useRef(5000);
  workspaceRef.current = workspaceId;
  const active = workspaces.find((item) => item.id === workspaceId);
  const finished = terminal(snapshot);
  const running = Boolean(snapshot?.id && !finished);
  const approvals = pendingApprovals(snapshot);
  const usableModels = models.filter(isCodingModel);
  const modelContextLimit = Math.min(
    32768,
    usableModels.find((item) => item.id === model)?.contextWindow || 32768,
  );
  const contextChoices = [2048, 4096, 8192, 16384, 32768].filter(
    (size) => size <= modelContextLimit,
  );

  useEffect(() => {
    if (contextWindow > modelContextLimit && contextChoices.length)
      setContextWindow(contextChoices.at(-1));
  }, [modelContextLimit, contextWindow]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      readRevision.current++;
      taskRevision.current++;
    };
  }, []);

  const refreshModels = useCallback(async (signal) => {
    setModelsLoading(true);
    try {
      const response = await apiService.coding.models(signal);
      if (signal?.aborted || !mounted.current) return;
      if (response.data.connected === false) {
        setConnected(false);
        throw new Error('Ollama is unavailable. Start Ollama, then refresh models.');
      }
      const available = list(response.data.models);
      setModels(available);
      setConnected(true);
      setModelError('');
      setModel((current) => {
        const eligible = available.filter(isCodingModel);
        return preferredCodingModel(eligible, current, response.data.defaultModel);
      });
      return true;
    } catch (failure) {
      modelRetryDelay.current = retryDelay(failure);
      if (!signal?.aborted && mounted.current)
        setModelError(
          failure.response?.status === 429
            ? 'Model refresh is temporarily busy. Retrying shortly.'
            : message(failure),
        );
      throw failure;
    } finally {
      if (!signal?.aborted && mounted.current) setModelsLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    Promise.allSettled([
      apiService.workspaces.get().then((response) => {
        if (controller.signal.aborted) return;
        const available = list(response.data.workspaces);
        setWorkspaces(available);
        setWorkspaceId((current) =>
          available.some((item) => item.id === current)
            ? current
            : available.find((item) => item.active)?.id || available[0]?.id || '',
        );
      }),
      refreshModels(controller.signal).catch(() => {}),
    ]).then((results) => {
      if (controller.signal.aborted) return;
      for (const result of results) {
        if (result.status === 'rejected') setError(message(result.reason));
      }
      setLoading(false);
    });
    return () => controller.abort();
  }, [user?.id, refreshModels]);

  useEffect(() => {
    if (!modelError) return;
    const controller = new AbortController();
    let timer;
    let failures = 0;
    const retry = async () => {
      try {
        await refreshModels(controller.signal);
      } catch (failure) {
        if (!controller.signal.aborted) timer = setTimeout(retry, retryDelay(failure, ++failures));
      }
    };
    timer = setTimeout(retry, modelRetryDelay.current);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [modelError, refreshModels]);

  const refreshTree = useCallback(async (id, signal) => {
    if (!id) return;
    const response = await apiService.coding.tree(id, signal);
    if (signal?.aborted || workspaceRef.current !== id) return;
    setEntries(list(response.data.entries));
    setTreeLimited(Boolean(response.data.truncated || response.data.limited));
    if (typeof response.data.writeAuthorized === 'boolean')
      setWriteAuthorized(response.data.writeAuthorized);
  }, []);
  const refreshRuntime = useCallback(async (id, signal) => {
    if (!id) return;
    const response = await apiService.coding.runtime(id, signal);
    if (signal?.aborted || workspaceRef.current !== id || !mounted.current) return;
    setRuntimeInfo(response.data);
    setRuntimeError('');
    return response.data;
  }, []);
  useEffect(() => {
    setRuntimeInfo(null);
    setRuntimeError('');
    if (!workspaceId) return;
    const controller = new AbortController();
    let timer;
    let failures = 0;
    const poll = async () => {
      let delay = running ? 2500 : 15000;
      try {
        const runtime = await refreshRuntime(workspaceId, controller.signal);
        if (runtime?.jobs?.some((job) => ['running', 'starting'].includes(job.status)))
          delay = 2500;
        failures = 0;
      } catch (failure) {
        if (!controller.signal.aborted) setRuntimeError(message(failure));
        delay = retryDelay(failure, ++failures);
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, delay);
    };
    poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [workspaceId, user?.id, running, refreshRuntime]);

  const refreshCheckpoints = useCallback(async (id) => {
    if (!id) return;
    const response = await apiService.coding.tool(id, 'checkpoint.list');
    if (!mounted.current || workspaceRef.current !== id) return;
    if (response.data.success === false) throw new Error(message(response.data));
    setCheckpoints(list(body(response.data).checkpoints));
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const revision = ++taskRevision.current;
    readRevision.current++;
    setWriteAuthorized(false);
    setEntries([]);
    setSelectedFile(null);
    setSnapshot(null);
    setTurns([]);
    setTaskText('');
    setCheckpoints([]);
    setToolApproval(null);
    setError('');
    setNotice('');
    if (!workspaceId) return () => controller.abort();
    setActiveWorkspaceId(workspaceId);
    refreshTree(workspaceId, controller.signal).catch((failure) => {
      if (!controller.signal.aborted) setError(message(failure));
    });
    refreshCheckpoints(workspaceId).catch((failure) => {
      if (!controller.signal.aborted) setError(message(failure));
    });
    let savedTask;
    try {
      savedTask = localStorage.getItem(storedTaskKey(user?.id, workspaceId));
    } catch {
      /* Backend persistence remains authoritative when browser storage is unavailable. */
    }
    apiService.coding
      .tasks(controller.signal)
      .then(async (response) => {
        if (controller.signal.aborted || taskRevision.current !== revision) return;
        const history = list(response.data.tasks)
          .filter((task) => task.workspaceId === workspaceId)
          .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
        setTurns(history);
        if (history.length) setSnapshot(history.at(-1));
        else if (savedTask) {
          const recovered = taskBody(await apiService.coding.task(savedTask, controller.signal));
          if (
            !controller.signal.aborted &&
            taskRevision.current === revision &&
            recovered?.workspaceId === workspaceId
          )
            setSnapshot(recovered);
        }
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setNotice(message(failure));
      });
    return () => controller.abort();
  }, [workspaceId, user?.id, refreshTree, refreshCheckpoints, setActiveWorkspaceId]);

  useEffect(() => {
    if (!snapshot?.id || finished) return;
    const controller = new AbortController();
    const id = snapshot.id;
    const revision = taskRevision.current;
    let timer;
    let failures = 0;
    const poll = async () => {
      let delay = 1200;
      try {
        const response = await apiService.coding.task(id, controller.signal);
        if (!controller.signal.aborted && taskRevision.current === revision) {
          setSnapshot(taskBody(response));
          setError('');
          failures = 0;
        }
      } catch (failure) {
        if (!controller.signal.aborted) setError(`Task status is unavailable: ${message(failure)}`);
        delay = retryDelay(failure, ++failures);
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(poll, delay);
      }
    };
    timer = setTimeout(poll, 700);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [snapshot?.id, finished]);

  useEffect(() => {
    if (!snapshot?.id || !finished || !workspaceId) return;
    refreshTree(workspaceId).catch(() => {});
    refreshCheckpoints(workspaceId).catch(() => {});
  }, [snapshot?.id, finished, workspaceId, refreshTree, refreshCheckpoints]);

  useEffect(() => {
    if (!workspaceId || !snapshot?.changes?.length) return;
    refreshTree(workspaceId).catch(() => {});
    if (selectedFile?.path && snapshot.changes.some((change) => change.path === selectedFile.path))
      selectFile(selectedFile.path);
  }, [snapshot?.changes?.length]);

  const perform = async (operation) => {
    busyOperations.current++;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await operation();
    } catch (failure) {
      if (mounted.current) setError(message(failure));
    } finally {
      busyOperations.current--;
      if (mounted.current) setBusy(busyOperations.current > 0);
    }
  };

  const selectFile = async (path) => {
    const id = workspaceId;
    const revision = ++readRevision.current;
    setSelectedFile({ path, loading: true });
    try {
      const response = await apiService.coding.file(id, path);
      if (workspaceRef.current === id && readRevision.current === revision)
        setSelectedFile(response.data);
    } catch (failure) {
      if (workspaceRef.current === id && readRevision.current === revision)
        setSelectedFile({ path, error: message(failure) });
    }
  };

  const start = (typed = taskText.trim()) => {
    if (!typed || running) return;
    const goal = typed === taskText.trim() ? withAttachments(typed, attachments) : typed;
    if (!usableModels.some((item) => item.id === model) || connected !== true) {
      setError('Choose an available local coding model before starting.');
      return;
    }
    perform(async () => {
      const revision = ++taskRevision.current;
      const id = workspaceId;
      const response = await apiService.coding.start({
        workspaceId: id,
        model,
        task: goal,
        contextWindow,
        ...(snapshot?.id ? { previousTaskId: snapshot.id } : {}),
      });
      if (!mounted.current || workspaceRef.current !== id || taskRevision.current !== revision)
        return;
      const task = taskBody(response);
      if (!task || typeof task.id !== 'string' || task.workspaceId !== id)
        throw new Error(
          'The server did not issue a task for this workspace. Refresh and try again.',
        );
      setTurns((current) =>
        snapshot ? [...current.filter((item) => item.id !== snapshot.id), snapshot] : current,
      );
      setSnapshot(task);
      setTaskText('');
      setAttachments([]);
      try {
        localStorage.setItem(storedTaskKey(user?.id, id), task.id);
      } catch {
        /* The task is also stored by the backend. */
      }
    });
  };

  // Projects with a task still running (other projects keep working in the background).
  const [runningWorkspaces, setRunningWorkspaces] = useState([]);
  useEffect(() => {
    if (!user?.id) return undefined;
    const controller = new AbortController();
    let timer;
    const poll = async () => {
      try {
        const response = await apiService.coding.tasks(controller.signal);
        if (!controller.signal.aborted)
          setRunningWorkspaces([
            ...new Set(
              list(response.data.tasks)
                .filter((task) => !terminal(task))
                .map((task) => task.workspaceId),
            ),
          ]);
      } catch {
        /* indicator only */
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 4000);
    };
    poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [user?.id]);

  const newTask = () => {
    if (running) return;
    setTurns([]);
    setSnapshot(null);
    setTaskText('');
    setAttachments([]);
    setError('');
    setNotice('New task: the agent starts fresh (earlier messages are not sent).');
    try {
      localStorage.removeItem(storedTaskKey(user?.id, workspaceId));
    } catch {}
  };

  // Edit-only = write grant without project commands (older projects): installs/builds cannot run.
  const accessMode = !writeAuthorized
    ? 'readonly'
    : runtimeInfo?.policy && !runtimeInfo.policy.commands
      ? 'editonly'
      : autoMode
        ? 'automatic'
        : 'manual';
  const lastMetrics = list(snapshot?.metrics).at(-1);
  const usage =
    lastMetrics?.contextWindow && Number.isFinite(lastMetrics.prompt_eval_count)
      ? {
          used: lastMetrics.prompt_eval_count + (lastMetrics.eval_count || 0),
          limit: lastMetrics.contextWindow,
          speed:
            lastMetrics.eval_count && lastMetrics.eval_duration
              ? lastMetrics.eval_count / (lastMetrics.eval_duration / 1e9)
              : 0,
        }
      : null;
  const applyAccessMode = (mode, id = workspaceId) =>
    perform(async () => {
      if (!id) throw new Error('Open a project folder first.');
      const automatic = mode === 'automatic';
      if (mode !== 'readonly') {
        setAutoMode(automatic);
        try {
          localStorage.setItem('chanakya-coding-access', mode);
        } catch {}
      }
      const response = await apiService.coding.authorize(id, mode !== 'readonly');
      const granted = response.data.writeAuthorized === true;
      if (workspaceRef.current === id) setWriteAuthorized(granted);
      // Both editing modes may run project commands and package installs; Manual
      // still reviews each risky action, Automatic approves them (see effect below).
      if (granted) await apiService.coding.executionPolicy(id, { commands: true, downloads: true });
      await refreshRuntime(id).catch(() => {});
      setNotice(
        mode === 'readonly'
          ? 'Read only: the agent cannot change files or run commands.'
          : automatic
            ? 'Automatic: edits, commands and package installs run without asking, inside this project only.'
            : 'Manual: you will review risky actions before they run.',
      );
    });

  const openFolder = (typedRoot) =>
    perform(async () => {
      const root = typeof typedRoot === 'string' ? typedRoot : await pickFolder();
      if (!root) return;
      const known = workspaces.find(
        (item) => String(item.root).toLowerCase() === root.toLowerCase(),
      );
      let id = known?.id;
      if (!id) {
        const response = await apiService.workspaces.create({
          name: root.split(/[\\/]/).filter(Boolean).at(-1) || 'Project',
          root,
        });
        id = response.data.workspace.id;
        const all = await apiService.workspaces.get();
        setWorkspaces(list(all.data.workspaces));
      }
      setWorkspaceId(id);
      setShowConnect(false);
      workspaceRef.current = id;
      await applyAccessMode(autoMode ? 'automatic' : 'manual', id);
    });

  const attachFiles = async (files) => {
    const next = [...attachments];
    const skipped = [];
    for (const file of files.slice(0, 10)) {
      if (file.size > 200 * 1024) {
        skipped.push(`${file.name} (too large)`);
        continue;
      }
      const text = await file.text().catch(() => null);
      if (text === null || text.includes('\u0000')) {
        skipped.push(`${file.name} (not a text file)`);
        continue;
      }
      const item = { name: file.name, size: text.length, text };
      const index = next.findIndex((entry) => entry.name === file.name);
      if (index >= 0) next[index] = item;
      else next.push(item);
    }
    setAttachments(next);
    setError(skipped.length ? `Skipped: ${skipped.join(', ')}` : '');
  };

  // Automatic mode: approve pending reviews, except system-level runtime installs.
  useEffect(() => {
    if (!autoMode || !writeAuthorized || busy) return;
    const pending = [
      ...approvals.map((approval) => ({ approval, task: true })),
      ...(toolApproval ? [{ approval: toolApproval, task: false }] : []),
    ].find(
      ({ approval }) =>
        (approval.tool || approval.action) !== 'runtime.install' &&
        !autoApproved.current.has(approval.approvalId || approval.id),
    );
    if (!pending) return;
    autoApproved.current.add(pending.approval.approvalId || pending.approval.id);
    if (pending.task) decide(pending.approval, true);
    else decideTool(true);
  }, [autoMode, writeAuthorized, busy, approvals, toolApproval]);

  const decide = (approval, approved) =>
    perform(async () => {
      const response = await apiService.coding.approve(
        snapshot.id,
        approval.approvalId || approval.id,
        approved,
      );
      setSnapshot(taskBody(response));
    });

  const operatorTool = (tool, params = {}) =>
    perform(async () => {
      const response = await apiService.coding.tool(workspaceId, tool, params);
      if (response.data.needsConfirmation) {
        setToolApproval(response.data);
        return;
      }
      if (response.data.success === false) throw new Error(message(response.data));
      setNotice(body(response.data).message || 'The workspace action completed.');
      await refreshCheckpoints(workspaceId);
      await refreshTree(workspaceId);
      await refreshRuntime(workspaceId);
    });

  const decideTool = (approved) =>
    perform(async () => {
      let response;
      try {
        response = await apiService.coding.approveTool(
          workspaceId,
          toolApproval.approvalId,
          approved,
        );
      } catch (failure) {
        if (
          ['APPROVAL_INVALID', 'APPROVAL_EXPIRED', 'WORKSPACE_CHANGED'].includes(
            failure.response?.data?.code,
          )
        )
          setToolApproval(null);
        throw failure;
      }
      // The backend consumes this exact receipt for both approval and denial.
      setToolApproval(null);
      if (response.data.success === false) {
        if (!approved && response.data.error?.code === 'APPROVAL_DENIED') {
          setNotice(response.data.error.message);
          return;
        }
        throw new Error(message(response.data));
      }
      setNotice(
        approved
          ? body(response.data).message || 'The approved workspace action completed.'
          : 'The workspace action was rejected.',
      );
      await refreshTree(workspaceId);
      await refreshCheckpoints(workspaceId);
      if (selectedFile?.path) await selectFile(selectedFile.path);
      await refreshRuntime(workspaceId);
    });

  const createProject = (event) => {
    event.preventDefault();
    perform(async () => {
      const parent = newProjectParent.trim();
      const response = await apiService.coding.createProject({
        name: newProjectName.trim(),
        ...(parent ? { parent } : {}),
      });
      const saved = response.data.workspace;
      try {
        if (parent) localStorage.setItem('chanakya-projects-parent', parent);
        else localStorage.removeItem('chanakya-projects-parent');
      } catch {}
      const all = await apiService.workspaces.get();
      setWorkspaces(list(all.data.workspaces));
      setWorkspaceId(saved.id);
      workspaceRef.current = saved.id;
      setNewProjectName('');
      setShowConnect(false);
      await applyAccessMode(autoMode ? 'automatic' : 'manual', saved.id);
      setNotice(`New project created at ${saved.root}.`);
    });
  };

  // Desktop app: Electron dialog. Browser (localhost), or when the desktop
  // dialog is refused: the backend's native Windows dialog.
  const pickFolder = async () => {
    let chosen = null;
    if (window.workspaceAPI?.chooseDirectory) {
      try {
        chosen = await window.workspaceAPI.chooseDirectory();
      } catch {
        chosen = null;
      }
    }
    if (!chosen || chosen.error) chosen = body(await apiService.workspaces.chooseDirectory());
    if (chosen.error) throw new Error(message(chosen.error));
    return !chosen.cancelled && chosen.root ? chosen.root : null;
  };

  const connect = (event) => {
    event.preventDefault();
    perform(async () => {
      const response = await apiService.workspaces.create({
        name: workspaceName.trim(),
        root: workspaceRoot.trim(),
      });
      const saved = response.data.workspace;
      const all = await apiService.workspaces.get();
      setWorkspaces(list(all.data.workspaces));
      setWorkspaceId(saved.id);
      setShowConnect(false);
    });
  };

  return (
    <CodingWorkspace
      {...{
        workspaces,
        workspaceId,
        active,
        usableModels,
        model,
        contextWindow,
        contextChoices,
        loading,
        connected,
        modelsLoading,
        modelError,
        writeAuthorized,
        runtimeInfo,
        runtimeError,
        busy,
        running,
        error,
        notice,
        entries,
        treeLimited,
        selectedFile,
        taskText,
        snapshot,
        turns,
        checkpoints,
        approvals,
        toolApproval,
        showConnect,
        workspaceName,
        workspaceRoot,
        onWorkspace: setWorkspaceId,
        onModel: setModel,
        onContext: setContextWindow,
        onTaskText: setTaskText,
        onWorkspaceName: setWorkspaceName,
        onWorkspaceRoot: setWorkspaceRoot,
        onShowConnect: setShowConnect,
        newProjectName,
        onNewProjectName: setNewProjectName,
        onCreateProject: createProject,
        attachments,
        onAttachFiles: attachFiles,
        onRemoveAttachment: (name) =>
          setAttachments((current) => current.filter((item) => item.name !== name)),
        accessMode,
        onAccessMode: (mode) => applyAccessMode(mode),
        onOpenFolder: () => openFolder(),
        onOpenPath: (root) => openFolder(root),
        onNewTask: newTask,
        runningWorkspaces,
        usage,
        newProjectParent,
        onNewProjectParent: setNewProjectParent,
        onChooseProjectParent: () =>
          perform(async () => {
            const root = await pickFolder();
            if (root) setNewProjectParent(root);
          }),
        onConnect: connect,
        onChooseFolder: () =>
          perform(async () => {
            const root = await pickFolder();
            if (root) {
              setWorkspaceRoot(root);
              if (!workspaceName.trim())
                setWorkspaceName(root.split(/[\\/]/).filter(Boolean).at(-1) || 'Workspace');
            }
          }),
        onRefreshModels: () => refreshModels().catch(() => {}),
        onAuthorize: () =>
          perform(async () => {
            const response = await apiService.coding.authorize(workspaceId, !writeAuthorized);
            setWriteAuthorized(response.data.writeAuthorized === true);
            setNotice(
              response.data.writeAuthorized
                ? 'Project changes enabled.'
                : 'Project changes disabled.',
            );
          }),
        onStart: start,
        onStop: () =>
          perform(async () => setSnapshot(taskBody(await apiService.coding.cancel(snapshot.id)))),
        onSelectFile: selectFile,
        onRefreshTree: () => perform(() => refreshTree(workspaceId)),
        onDecision: decide,
        onToolDecision: decideTool,
        onCheckpoint: () => operatorTool('checkpoint.create'),
        onRestore: (checkpointId) => operatorTool('checkpoint.restore', { checkpointId }),
        onRuntimeAction: operatorTool,
        onExecutionPolicy: (policy) =>
          perform(async () => {
            await apiService.coding.executionPolicy(workspaceId, policy);
            await refreshRuntime(workspaceId);
            setNotice(
              policy.commands
                ? 'Project commands enabled. Each command is reviewed before it runs.'
                : 'Project commands disabled.',
            );
          }),
        onStopProcess: (jobId) =>
          perform(async () => {
            await apiService.coding.stopProcess(workspaceId, jobId);
            await refreshRuntime(workspaceId);
          }),
        onOpenPreview: (jobId) =>
          perform(async () => {
            await apiService.coding.openPreview(workspaceId, jobId);
          }),
      }}
    />
  );
}
