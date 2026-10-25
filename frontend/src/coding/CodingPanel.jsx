import React, { useCallback, useEffect, useRef, useState } from 'react';
import CodingWorkspace from './CodingWorkspace.jsx';
import * as apiService from '../services/api.js';
import { useAppStore } from '../stores/useAppStore.js';

const list = (value) => (Array.isArray(value) ? value : []);
const message = (error) => {
  const detail = error?.response?.data?.error || error?.error || error?.message || error;
  return typeof detail === 'string'
    ? detail
    : detail?.message || 'The coding action could not be completed.';
};
const body = (result) => result?.data || result || {};
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
  const selectedModelId = useAppStore((state) => state.selectedModelId);
  const [workspaces, setWorkspaces] = useState([]);
  const [workspaceId, setWorkspaceId] = useState(activeWorkspaceId || '');
  const [models, setModels] = useState([]);
  const [model, setModel] = useState(selectedModelId || '');
  const [contextWindow, setContextWindow] = useState(8192);
  const [connected, setConnected] = useState(null);
  const [writeAuthorized, setWriteAuthorized] = useState(false);
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
  const workspaceRef = useRef(workspaceId);
  const readRevision = useRef(0);
  const taskRevision = useRef(0);
  const mounted = useRef(true);
  workspaceRef.current = workspaceId;
  const active = workspaces.find((item) => item.id === workspaceId);
  const finished = terminal(snapshot);
  const running = Boolean(snapshot?.id && !finished);
  const approvals = pendingApprovals(snapshot);
  const usableModels = models.filter(
    (item) =>
      item.installed !== false &&
      list(item.capabilities).includes('completion') &&
      list(item.capabilities).includes('tools'),
  );
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
    const response = await apiService.coding.models(signal);
    if (signal?.aborted || !mounted.current) return;
    const available = list(response.data.models);
    setModels(available);
    setConnected(response.data.connected !== false);
    setModel((current) => {
      const eligible = available.filter(
        (item) =>
          item.installed !== false &&
          list(item.capabilities).includes('completion') &&
          list(item.capabilities).includes('tools'),
      );
      return eligible.some((item) => item.id === current) ? current : eligible[0]?.id || '';
    });
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
      refreshModels(controller.signal),
    ]).then((results) => {
      if (controller.signal.aborted) return;
      for (const result of results) {
        if (result.status === 'rejected') setError(message(result.reason));
      }
      setLoading(false);
    });
    return () => controller.abort();
  }, [user?.id, refreshModels]);

  const refreshTree = useCallback(async (id, signal) => {
    if (!id) return;
    const response = await apiService.coding.tree(id, signal);
    if (signal?.aborted || workspaceRef.current !== id) return;
    setEntries(list(response.data.entries));
    setTreeLimited(Boolean(response.data.truncated || response.data.limited));
    if (typeof response.data.writeAuthorized === 'boolean')
      setWriteAuthorized(response.data.writeAuthorized);
  }, []);

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
    const poll = async () => {
      try {
        const response = await apiService.coding.task(id, controller.signal);
        if (!controller.signal.aborted && taskRevision.current === revision) {
          setSnapshot(taskBody(response));
          setError('');
        }
      } catch (failure) {
        if (!controller.signal.aborted) setError(`Task status is unavailable: ${message(failure)}`);
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(poll, 1200);
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
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await operation();
    } catch (failure) {
      if (mounted.current) setError(message(failure));
    } finally {
      if (mounted.current) setBusy(false);
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

  const start = (goal = taskText.trim()) => {
    if (!goal || running) return;
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
      try {
        localStorage.setItem(storedTaskKey(user?.id, id), task.id);
      } catch {
        /* The task is also stored by the backend. */
      }
    });
  };

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
    });

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
        writeAuthorized,
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
        onConnect: connect,
        onChooseFolder: () =>
          perform(async () => {
            const chosen = await window.workspaceAPI.chooseDirectory();
            if (chosen.error) throw new Error(message(chosen.error));
            if (!chosen.cancelled && chosen.root) {
              setWorkspaceRoot(chosen.root);
              if (!workspaceName.trim())
                setWorkspaceName(chosen.root.split(/[\\/]/).filter(Boolean).at(-1) || 'Workspace');
            }
          }),
        onRefreshModels: () => perform(() => refreshModels()),
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
      }}
    />
  );
}
