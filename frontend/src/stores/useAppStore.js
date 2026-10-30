import { create } from 'zustand';
import {
  createChatExecution,
  executeChatCall,
  finishChat,
  executeCancellableTool,
} from '../services/chatExecution.js';
import { appChoiceEntry, resumeWithChoice, matchTypedAppChoice } from '../services/appChoice.js';
import * as apiService from '../services/api.js';
import { repairTask } from '../../../backend/src/orchestrator/RepairTask.js';
import { validateAttachment, MAX_ATTACHMENTS, shouldLoadChatTools } from '../utils/attachments.js';

import { mapToolsToOllamaSchema } from '../services/toolSchemas.js';
import {
  setInstalledApps,
  computerTask,
} from '../../../backend/src/orchestrator/ComputerTaskPolicy.js';

export const useAppStore = create((set, get) => ({
  // User Management
  // Starts logged-out and unknown, not read from localStorage: the session
  // token now lives in the Electron main process (gone on app restart by
  // design), so there's nothing durable to read synchronously here. checkAuth
  // (called once on app mount) resolves this — isAuthLoading starts true so
  // the UI shows a loading state instead of flashing the login screen while
  // that check is in flight.
  user: null,
  isAuthLoading: true,

  // Quick action trigger from bubble widget
  bubbleAction: null,
  setBubbleAction: (action) => set({ bubbleAction: action }),

  // Avatar signals — real events the avatar director reacts to, not an LLM
  // call per message. Kept in the store because the mic (VoiceRecorder) and
  // the avatar (FloatingBubble) are siblings, not parent/child.
  micListening: false,
  setMicListening: (listening) => set({ micListening: listening }),
  avatarSpeaking: false,
  setAvatarSpeaking: (speaking) => set({ avatarSpeaking: speaking }),

  login: async (username, password) => {
    set({ isAuthLoading: true });
    try {
      const response = await apiService.auth.login({ username, password });
      const { user, token } = response.data;
      await apiService.setSession(token);
      set({ user, isAuthLoading: false });
      get().fetchHistory();
      get().fetchDocuments();
      get().fetchActiveWorkspace();
      get().fetchMemories();
      get().loadInstalledApps();
      return user;
    } catch (err) {
      set({ isAuthLoading: false });
      throw err;
    }
  },

  register: async (username, displayName, password) => {
    set({ isAuthLoading: true });
    try {
      const response = await apiService.auth.register({
        username,
        displayName,
        password,
      });
      const { user, token } = response.data;
      await apiService.setSession(token);
      set({ user, isAuthLoading: false });
      get().fetchHistory();
      get().fetchDocuments();
      get().fetchMemories();
      get().loadInstalledApps();
      get().fetchActiveWorkspace();
      return user;
    } catch (err) {
      set({ isAuthLoading: false });
      throw err;
    }
  },

  logout: async () => {
    get().cancelSoftwareOperation();
    get().discardSoftwareChoices();
    get().clearAttachments();
    get().stopAllGenerations();
    // Best-effort server-side revocation — the local session is cleared
    // either way (the catch), so a network hiccup or an already-401'd
    // session never blocks logging out locally. This must be awaited
    // BEFORE clearSession(): the two used to fire concurrently, and
    // clearSession() reliably won the race (it does no real async work in
    // the non-Electron dev path), wiping the in-memory token before the
    // POST's own request interceptor read it — so the request went out
    // with no Authorization header, got 401, and the server-side session
    // was silently never revoked despite the UI already showing logged out.
    if (await apiService.getToken()) {
      await apiService.auth.logout().catch(() => {});
    }
    await apiService.clearSession();
    set({
      user: null,
      conversations: [],
      folders: [],
      activeChatId: null,
      activeMessages: [],
      backgroundChats: {},
      generatingChats: {},
      documents: [],
      memories: [],
      pendingConfirmations: [],
      pendingAppChoices: [],
      pendingSoftwareChoices: [],
      activeWorkspaceId: null,
    });
  },

  clearChat: () => {
    get().discardSoftwareChoices();
    get().clearAttachments();
    // Leaving the chat never stops its answer: a running chat keeps generating in the background.
    get()._parkActiveChat();
    set({
      activeMessages: [],
      activeChatId: null,
      activeSources: [],
      isGenerating: false,
      activeAbortController: null,
      pendingConfirmations: [],
      pendingAppChoices: [],
      pendingSoftwareChoices: [],
    });
  },

  // Tools & Confirmations
  // Application choices ("which Chrome?"): an execution paused in awaiting_app_choice, answered by candidate id (see services/appChoice.js).
  pendingAppChoices: [],
  addAppChoice: (choice) =>
    set((state) => ({
      pendingAppChoices: [
        ...state.pendingAppChoices.filter((c) => c.choiceId !== choice.choiceId),
        choice,
      ],
    })),
  removeAppChoice: (choiceId) =>
    set((state) => ({
      pendingAppChoices: state.pendingAppChoices.filter((c) => c.choiceId !== choiceId),
    })),
  _runQueuedCalls: async (execution, calls, tools, messageId) => {
    for (let i = 0; i < calls.length && !execution.stopped; i++) {
      const call = calls[i];
      const observation = await executeChatCall(
        execution,
        call,
        tools,
        (tool, action, params, toolCallId, identity) =>
          executeCancellableTool(window.toolEngine, tool, action, params, toolCallId, identity),
        get().activeAbortController?.signal,
      );
      if (!observation) break;
      const queuedId = crypto.randomUUID();
      set((state) => ({
        activeMessages: [
          ...state.activeMessages,
          {
            id: queuedId,
            chatId: get().activeChatId,
            role: 'tool',
            tool_call_id: observation.toolCallId,
            tool_name: call.function?.name,
            content: JSON.stringify(observation),
            createdAt: new Date().toISOString(),
          },
        ],
      }));
      if (observation.needsConfirmation)
        get().addConfirmation({
          confirmationId: observation.confirmationId,
          message: observation.confirmationMessage,
          approvalDetails: observation.approvalDetails,
          messageId: queuedId,
          execution,
          tools,
          remainingCalls: calls.slice(i + 1),
        });
      if (observation.needsAppChoice)
        get().addAppChoice(
          appChoiceEntry(observation, {
            execution,
            tools,
            messageId: queuedId,
            remainingCalls: calls.slice(i + 1),
          }),
        );
    }
  },
  chooseApp: async (choiceId, candidateId) => {
    const choice = get().pendingAppChoices.find((c) => c.choiceId === choiceId);
    if (!choice || choice.resolving || !window.toolEngine) return;
    const patchChoice = (fields) =>
      set((state) => ({
        pendingAppChoices: state.pendingAppChoices.map((c) =>
          c.choiceId === choiceId ? { ...c, ...fields } : c,
        ),
      }));
    patchChoice({ resolving: true, error: null });
    const { execution, tools = [], messageId } = choice;
    const abort = new AbortController();
    get().setAbortController(abort);
    try {
      const observation = await resumeWithChoice(choice, candidateId, {
        engine: window.toolEngine,
        signal: abort.signal,
      });
      get().removeAppChoice(choiceId);
      if (!observation) return;
      set((state) => ({
        activeMessages: state.activeMessages.map((m) =>
          m.id === messageId ? { ...m, content: JSON.stringify(observation) } : m,
        ),
      }));
      // The pick went stale: the engine asks again with what is installed now.
      if (observation.needsAppChoice) {
        get().addAppChoice(
          appChoiceEntry(observation, {
            execution,
            tools,
            messageId,
            remainingCalls: choice.remainingCalls,
          }),
        );
        return;
      }
      // Carry on with the original request: queued calls first, then the loop decides the next step from the new evidence.
      await get()._runQueuedCalls(execution, choice.remainingCalls || [], tools, messageId);
      if (!execution.stopped) await get().sendMessage('', false, { execution });
    } catch (error) {
      execution.stop('error', error.message);
      get().removeAppChoice(choiceId);
      set((state) => ({
        activeMessages: [
          ...state.activeMessages,
          {
            id: crypto.randomUUID(),
            chatId: get().activeChatId,
            role: 'assistant',
            content: `Execution stopped: ${error.message}`,
            createdAt: new Date().toISOString(),
          },
        ],
      }));
    } finally {
      if (get().activeAbortController === abort) get().setAbortController(null);
    }
  },
  cancelAppChoice: async (choiceId, reason = 'User cancelled the application choice.') => {
    const choice = get().pendingAppChoices.find((c) => c.choiceId === choiceId);
    if (!choice) return;
    get().removeAppChoice(choiceId);
    try {
      await window.toolEngine?.cancelAppChoice(choiceId);
    } catch {
      /* the engine expires unanswered choices itself */
    }
    choice.execution?.stop('cancelled', reason);
    set((state) => ({
      activeMessages: state.activeMessages.map((m) =>
        m.id === choice.messageId ? { ...m, content: '[APPLICATION CHOICE CANCELLED]' } : m,
      ),
    }));
  },
  pendingConfirmations: [],
  pendingSoftwareChoices: [],
  softwareOperation: null,
  cancelSoftwareOperation: () => {
    const job = get().softwareOperation;
    if (job) {
      job.controller.abort();
      set({
        softwareOperation: {
          ...job,
          status: 'Cancelling; Windows may still require you to close an elevated installer',
        },
      });
    }
  },
  discardSoftwareChoices: () => {
    for (const choice of get().pendingSoftwareChoices) {
      choice.execution.stop('cancelled', 'The conversation changed.');
      Promise.resolve(window.softwareAPI?.cancelChoice(choice.discoveryId)).catch(() => {});
    }
    set({ pendingSoftwareChoices: [] });
  },
  chooseSoftware: async (discoveryId, candidateId) => {
    const choice = get().pendingSoftwareChoices.find((item) => item.discoveryId === discoveryId);
    if (!choice || choice.resolving || !window.softwareAPI) return;
    set((state) => ({
      pendingSoftwareChoices: state.pendingSoftwareChoices.map((item) =>
        item.discoveryId === discoveryId ? { ...item, resolving: true, error: null } : item,
      ),
    }));
    try {
      const receipt = await window.softwareAPI.choose(discoveryId, candidateId);
      if (
        receipt?.status !== 'SOFTWARE_SELECTED' ||
        receipt.discoveryId !== discoveryId ||
        receipt.selectedCandidateId !== candidateId
      )
        throw new Error('The software selection was not accepted. Discover the product again.');
      set((state) => ({
        pendingSoftwareChoices: state.pendingSoftwareChoices.filter(
          (item) => item.discoveryId !== discoveryId,
        ),
        activeMessages: [
          ...state.activeMessages,
          {
            id: crypto.randomUUID(),
            chatId: choice.chatId,
            role: 'tool',
            tool_name: 'software_chooseCandidate',
            content: JSON.stringify({ success: true, data: receipt }),
            createdAt: new Date().toISOString(),
          },
        ],
      }));
      await get().sendMessage('', false, { execution: choice.execution });
    } catch (error) {
      set((state) => ({
        pendingSoftwareChoices: state.pendingSoftwareChoices.map((item) =>
          item.discoveryId === discoveryId
            ? {
                ...item,
                resolving: false,
                error: error.message || 'The selection could not be resumed.',
              }
            : item,
        ),
      }));
    }
  },
  cancelSoftwareChoice: async (discoveryId) => {
    const choice = get().pendingSoftwareChoices.find((item) => item.discoveryId === discoveryId);
    if (!choice) return;
    await window.softwareAPI?.cancelChoice(discoveryId).catch(() => {});
    choice.execution.stop('cancelled', 'User cancelled the software identity selection.');
    set((state) => ({
      pendingSoftwareChoices: state.pendingSoftwareChoices.filter(
        (item) => item.discoveryId !== discoveryId,
      ),
      activeMessages: [
        ...state.activeMessages,
        {
          id: crypto.randomUUID(),
          chatId: choice.chatId,
          role: 'assistant',
          content: 'Software selection cancelled. No installation was authorized.',
          createdAt: new Date().toISOString(),
        },
      ],
    }));
  },
  addConfirmation: (conf) =>
    set((state) => ({
      pendingConfirmations: [...state.pendingConfirmations, conf],
    })),
  removeConfirmation: (id) =>
    set((state) => ({
      pendingConfirmations: state.pendingConfirmations.filter((c) => c.confirmationId !== id),
    })),
  renewConfirmation: async (id) => {
    const conf = get().pendingConfirmations.find((c) => c.confirmationId === id);
    if (conf?.repair) {
      if (conf.renewing) return;
      const renewalId = conf.renewalId || crypto.randomUUID();
      set((s) => ({
        pendingConfirmations: s.pendingConfirmations.map((c) =>
          c.confirmationId === id ? { ...c, renewing: true, renewalId } : c,
        ),
      }));
      try {
        const { data: saved } = await apiService.repair.renew(conf.repair.sessionId, {
          expectedRevision: conf.repair.revision,
          renewalId,
        });
        const o = saved.state.plan[saved.state.currentStepIndex].observation;
        set((s) => ({
          pendingConfirmations: s.pendingConfirmations.map((c) =>
            c.confirmationId === id
              ? {
                  ...c,
                  confirmationId: o.confirmationId,
                  message: o.confirmationMessage,
                  repair: { ...c.repair, revision: saved.revision },
                  renewing: false,
                  renewalId: null,
                }
              : c,
          ),
        }));
      } catch (error) {
        set((s) => ({
          pendingConfirmations: s.pendingConfirmations.map((c) =>
            c.confirmationId === id
              ? {
                  ...c,
                  renewing: false,
                  renewalError: error.response?.data?.error || error.message,
                }
              : c,
          ),
        }));
      }
      return;
    }
    if (!conf?.execution || conf.renewing) return;
    const renewalId = conf.renewalId || crypto.randomUUID();
    set((state) => ({
      pendingConfirmations: state.pendingConfirmations.map((c) =>
        c.confirmationId === id ? { ...c, renewalId, renewing: true, renewalError: null } : c,
      ),
    }));
    try {
      const renewal = await window.toolEngine.renewConfirmation(id, renewalId);
      conf.execution.renewConfirmation(renewal);
      set((state) => ({
        pendingConfirmations: state.pendingConfirmations.map((c) =>
          c.confirmationId === id
            ? {
                ...c,
                confirmationId: renewal.confirmationId,
                message: renewal.message,
                expiresAt: renewal.expiresAt,
                renewalId: null,
                renewing: false,
                renewalError: null,
              }
            : c,
        ),
      }));
    } catch (error) {
      set((state) => ({
        pendingConfirmations: state.pendingConfirmations.map((c) =>
          c.confirmationId === id ? { ...c, renewing: false, renewalError: error.message } : c,
        ),
      }));
    }
  },
  resolveConfirmation: async (id, approved) => {
    const conf = get().pendingConfirmations.find((c) => c.confirmationId === id);
    if (!conf || conf.renewing) return;
    if (conf.repair) {
      set({ isGenerating: true });
      set((s) => ({
        pendingConfirmations: s.pendingConfirmations.map((c) =>
          c.confirmationId === id ? { ...c, renewing: true } : c,
        ),
      }));
      const abort = new AbortController();
      get().setAbortController(abort);
      const cancel = () => {
        apiService.repair.cancel(conf.repair.sessionId, conf.repair.requestId).catch(() => {});
      };
      abort.signal.addEventListener('abort', cancel, { once: true });
      try {
        const { data: r } = approved
          ? await apiService.repair.resume(
              conf.repair.sessionId,
              { expectedRevision: conf.repair.revision, confirmationId: id },
              abort.signal,
            )
          : await apiService.repair.cancel(conf.repair.sessionId, conf.repair.requestId);
        get().removeConfirmation(id);
        set((s) => ({
          activeMessages: s.activeMessages.map((m) =>
            m.id === conf.messageId
              ? {
                  ...m,
                  content:
                    m.content +
                    '\n\n' +
                    (approved
                      ? r.summary
                      : 'Repair cancelled. Any admitted effect requires inspection.'),
                }
              : m,
          ),
        }));
      } catch (error) {
        set((s) => ({
          pendingConfirmations: s.pendingConfirmations.map((c) =>
            c.confirmationId === id
              ? {
                  ...c,
                  renewing: false,
                  renewalError:
                    error.response?.data?.error ||
                    'Continuation failed. Inspect the checkpoint before trying again.',
                }
              : c,
          ),
        }));
      } finally {
        abort.signal.removeEventListener('abort', cancel);
        get().setAbortController(null);
        set({ isGenerating: false });
      }
      return;
    }
    get().removeConfirmation(id);

    if (!window.toolEngine) return;
    // Confirmations raised by a UI panel (not a chat tool loop) just approve or cancel that one request.
    if (conf.standalone) {
      let result;
      const controller = new AbortController(),
        requestId = crypto.randomUUID();
      if (approved && conf.approvalDetails?.software)
        set({
          softwareOperation: {
            confirmationId: id,
            controller,
            requestId,
            status: `${conf.approvalDetails.software.operation}: ${conf.approvalDetails.software.name}`,
          },
        });
      try {
        if (approved)
          result = await executeCancellableTool(
            window.toolEngine,
            '_system',
            'confirm',
            { confirmationId: id },
            crypto.randomUUID(),
            {
              requestId,
              idempotencyKey: crypto.randomUUID(),
              signal: controller.signal,
            },
          );
        else result = await window.toolEngine.cancel(id);
      } catch (error) {
        result = {
          success: false,
          error: {
            message: 'The approved action could not be completed. Check Diagnostics and retry.',
          },
        };
        console.error('Standalone confirmation failed', error);
      } finally {
        if (get().softwareOperation?.confirmationId === id) set({ softwareOperation: null });
        conf.onSettled?.(result);
      }
      return;
    }

    // We update the paused tool message to show it's resuming or cancelled
    const chatMsg = get().activeMessages.find((m) => m.id === conf.messageId);
    if (chatMsg) {
      set((state) => ({
        activeMessages: state.activeMessages.map((m) =>
          m.id === conf.messageId
            ? {
                ...m,
                content: approved
                  ? '[RESUMING TOOL EXECUTION...]'
                  : '[TOOL EXECUTION CANCELLED BY USER]',
              }
            : m,
        ),
      }));
    }

    try {
      let result;
      if (approved) {
        if (!conf.execution) throw new Error('Missing execution checkpoint for confirmation.');
        const continuationAbort = new AbortController();
        get().setAbortController(continuationAbort);
        result = await conf.execution.execute(
          (step) =>
            executeCancellableTool(
              window.toolEngine,
              '_system',
              'confirm',
              { confirmationId: id },
              step.toolCallId,
              { ...step, signal: continuationAbort.signal },
            ),
          { confirmationId: id, signal: continuationAbort.signal },
        );
      } else {
        conf.execution?.stop('cancelled', 'User declined confirmation.');
        result = await window.toolEngine.cancel(id);
        if (
          [
            'winget_install',
            'webInstall_install',
            'software_install',
            'software_download',
            'software_discoverOnline',
          ].includes(chatMsg?.tool_name) &&
          result?.success === true
        ) {
          const message = 'Installation declined. The application was not installed.';
          result = {
            success: false,
            data: { success: false, status: 'INSTALL_CANCELLED', message },
            error: { code: 'INSTALL_CANCELLED', message },
          };
          set((state) => ({
            activeMessages: [
              ...state.activeMessages,
              {
                id: crypto.randomUUID(),
                chatId: get().activeChatId,
                role: 'assistant',
                content: message,
                createdAt: new Date().toISOString(),
              },
            ],
          }));
        }
      }

      // Resume the ReAct loop by sending the result back!
      // To do this, we just append a tool message and call sendMessage with empty content.
      if (chatMsg) {
        set((state) => ({
          activeMessages: state.activeMessages.map((m) =>
            m.id === conf.messageId ? { ...m, content: JSON.stringify(result) } : m,
          ),
        }));
      }

      if (approved && conf.execution && !conf.execution.stopped) {
        // A model can return several calls. Preserve the queue across approval.
        const remaining = conf.remainingCalls || [];
        for (let i = 0; i < remaining.length && !conf.execution.stopped; i++) {
          const call = remaining[i];
          const observation = await executeChatCall(
            conf.execution,
            call,
            conf.tools || [],
            (tool, action, params, toolCallId, identity) =>
              executeCancellableTool(window.toolEngine, tool, action, params, toolCallId, identity),
            get().activeAbortController?.signal,
          );
          if (!observation) break;
          const messageId = crypto.randomUUID();
          set((state) => ({
            activeMessages: [
              ...state.activeMessages,
              {
                id: messageId,
                chatId: get().activeChatId,
                role: 'tool',
                tool_call_id: observation.toolCallId,
                tool_name: call.function?.name,
                content: JSON.stringify(observation),
                createdAt: new Date().toISOString(),
              },
            ],
          }));
          if (observation.needsConfirmation)
            get().addConfirmation({
              confirmationId: observation.confirmationId,
              message: observation.confirmationMessage,
              approvalDetails: observation.approvalDetails,
              messageId,
              execution: conf.execution,
              tools: conf.tools,
              remainingCalls: remaining.slice(i + 1),
            });
          if (observation.needsAppChoice)
            get().addAppChoice(
              appChoiceEntry(observation, {
                execution: conf.execution,
                tools: conf.tools,
                messageId,
                remainingCalls: remaining.slice(i + 1),
              }),
            );
        }
        if (!conf.execution.stopped)
          await get().sendMessage('', false, { execution: conf.execution });
      }
    } catch (e) {
      conf.execution?.stop('error', e.message);
      console.error('Confirmation resolution failed', e);
    }
  },

  deleteChat: async (id) => {
    try {
      get()._abortChatRun(id);
      await apiService.history.delete(id);
      if (get().activeChatId === id) {
        get().clearChat();
      }
      get().fetchHistory();
    } catch (err) {
      console.error('Failed to delete chat:', err);
    }
  },

  changePassword: async (currentPassword, newPassword) => {
    // Changing the password revokes every existing session for the account
    // server-side; the response carries a freshly-issued token for this
    // device so the caller isn't logged out by its own password change.
    const response = await apiService.auth.changePassword(currentPassword, newPassword);
    await apiService.setSession(response.data.token);
  },

  deleteAccount: async (password) => {
    get().clearAttachments();
    get().stopAllGenerations();
    // Irreversible on the server the moment this resolves — the account row
    // and its vector store are already gone. Reuse logout's local cleanup
    // (clear the stored token, reset in-memory state) since there is no
    // account left to be logged in as afterward.
    await apiService.auth.deleteAccount(password);
    await apiService.clearSession();
    set({
      user: null,
      conversations: [],
      folders: [],
      activeChatId: null,
      activeMessages: [],
      documents: [],
      memories: [],
      pendingConfirmations: [],
      pendingAppChoices: [],
    });
  },

  requestPasswordReset: async (username) => {
    const response = await apiService.auth.forgotPassword(username);
    return response.data.message;
  },

  resetPasswordWithToken: async (token, newPassword) => {
    await apiService.auth.resetPassword(token, newPassword);
  },

  updateProfile: async (data) => {
    try {
      const response = await apiService.auth.updateProfile(data);
      set({ user: response.data.user });
    } catch (err) {
      console.error('Failed to update profile:', err);
      throw err;
    }
  },

  // Runs once on app mount (see App.jsx). There's no cached profile to trust
  // optimistically anymore — the token lives in the Electron main process,
  // not localStorage, so this always starts from "is there a token at all?"
  // rather than assuming a previous session is still good.
  checkAuth: async () => {
    set({ isAuthLoading: true });
    const token = await apiService.getToken();
    if (!token) {
      set({ isAuthLoading: false });
      return;
    }
    try {
      const response = await apiService.auth.me();
      set({ user: response.data.user, isAuthLoading: false });
      get().loadInstalledApps();
      get().fetchActiveWorkspace();
    } catch (err) {
      set({ isAuthLoading: false });
      // A real 401 means the session is actually gone (expired/revoked).
      // Anything else (network error, backend not up yet) just leaves the
      // user logged out for now rather than guessing — there's no cached
      // profile left to optimistically fall back to.
      if (err?.response?.status === 401) {
        get().logout();
      } else {
        console.warn('Backend unreachable — cannot verify session yet.');
      }
    }
  },

  // Window Size Toggles
  // The desktop app starts as the corner bubble and goes full-screen after
  // sign-in; the main process owns the real window layout and reports it back.
  // A plain browser tab has no bubble, so it starts full. windowMode is
  // 'full' | 'compact' | 'bubble', and isExpanded is simply "not the bubble".
  windowMode: typeof window !== 'undefined' && window.electronAPI ? 'bubble' : 'full',
  isExpanded: !(typeof window !== 'undefined' && window.electronAPI),
  // Follow a mode the main process has already applied (no IPC back).
  syncWindowMode: (mode) => {
    if (!['full', 'compact', 'bubble'].includes(mode)) return;
    set({
      windowMode: mode,
      isExpanded: mode !== 'bubble',
      ...(mode !== 'bubble' && { lastExpandedMode: mode }),
    });
  },
  setWindowMode: async (mode) => {
    const previous = get().windowMode;
    if (mode === previous) return;
    // Swap the view BEFORE resizing the window. Awaiting the IPC first left the
    // window at the old size while React already rendered the new view, so the
    // resize showed an empty pane for a frame or two.
    get().syncWindowMode(mode);
    if (window.electronAPI) {
      try {
        const applied = await window.electronAPI.setWindowMode(mode);
        // Reconcile only if the main process disagreed (e.g. a rejected change).
        if (applied !== mode) get().syncWindowMode(applied);
      } catch {
        get().syncWindowMode(previous);
      }
    }
  },
  // Bubble <-> chat; opening returns to full or compact, whichever was last used.
  // Signing in happens in the small window; full screen is for signed-in use.
  toggleExpand: () => {
    const { isExpanded, user, lastExpandedMode } = get();
    return get().setWindowMode(isExpanded ? 'bubble' : user ? lastExpandedMode : 'compact');
  },
  lastExpandedMode: 'full',

  // Full <-> windowed (compact) size.
  toggleWindowSize: () => {
    const { windowMode, setWindowMode } = get();
    if (windowMode === 'bubble') return;
    return setWindowMode(windowMode === 'full' ? 'compact' : 'full');
  },

  // Input Text prompt
  inputText: '',
  setInputText: (text) => set({ inputText: text }),

  // Clipboard Explainer
  clipboardToastText: null,
  showClipboardToast: (text) => set({ clipboardToastText: text }),

  // OCR
  ocrScreenshot: null,
  setOcrScreenshot: (screenshot) => {
    if (window.electronAPI) {
      window.electronAPI.setOcrMode(!!screenshot);
    }
    set({ ocrScreenshot: screenshot });
  },
  isOcrProcessing: false,
  setOcrProcessing: (processing) => set({ isOcrProcessing: processing }),

  // Pending Screen Capture/Attachment
  pendingScreenCapture: null,
  setPendingScreenCapture: (capture) => set({ pendingScreenCapture: capture }),

  // Agent Persona
  selectedAgentProfile: localStorage.getItem('chanakya-agent-profile') || 'default',
  selectAgentProfile: (profile) => {
    localStorage.setItem('chanakya-agent-profile', profile);
    set({ selectedAgentProfile: profile });
  },

  // Models Selection
  models: [],
  // No built-in model name: fetchModels() picks the first installed model when nothing valid is saved.
  selectedModelId: localStorage.getItem('chanakya-model') || '',
  // Installed third-party apps (name + aliases) so free-form requests naming one can be recognised. Refreshed lazily.
  installedApps: [],
  installedAppsAt: 0,
  loadInstalledApps: async (force = false) => {
    if (
      !window.toolEngine ||
      (!force && get().installedApps.length && Date.now() - get().installedAppsAt < 600000)
    )
      return;
    try {
      const result = await window.toolEngine.execute(
        'app',
        'listApps',
        { limit: 200, withAliases: true },
        crypto.randomUUID(),
        { requestId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() },
      );
      const apps = (result?.data?.apps || []).map((a) => ({
        name: a.name,
        aliases: a.aliases || [],
      }));
      if (apps.length) {
        setInstalledApps(apps);
        set({ installedApps: apps, installedAppsAt: Date.now() });
      }
    } catch {
      /* Admission then falls back to the explicit patterns; chat keeps working. */
    }
  },
  isModelsLoading: false,
  fetchModels: async () => {
    set({ isModelsLoading: true });
    try {
      const response = await apiService.models.get();
      const models = response.data.models || [];
      set({ models, isModelsLoading: false });

      const currentChoice = models.find((m) => m.id === get().selectedModelId);
      if ((!currentChoice || !currentChoice.installed) && models.length > 0) {
        const firstInstalled = models.find((m) => m.installed);
        if (firstInstalled) {
          get().selectModel(firstInstalled.id);
        }
      }
    } catch (err) {
      set({ isModelsLoading: false });
      console.error('Failed to fetch models:', err);
    }
  },
  selectModel: (modelId) => {
    localStorage.setItem('chanakya-model', modelId);
    set({ selectedModelId: modelId });
  },

  // Free the local model from memory when the assistant is idle (saves RAM/VRAM).
  // Skipped mid-generation; the model reloads automatically on the next request.
  unloadIdleModel: async () => {
    // /api/models/unload requires auth — with no user logged in, this is a
    // guaranteed 401. App.jsx fires this on a timer/visibility change
    // regardless of auth state, so skip the request entirely rather than
    // hitting the network and logging a needless error every time.
    if (
      !get().user ||
      get().isGenerating ||
      Object.keys(get().generatingChats).length ||
      get().isUploadingDocs
    )
      return;
    try {
      await apiService.models.unload();
    } catch {
      // Ollama may be down or already unloaded — nothing to do.
    }
  },

  // Chat History
  conversations: [],
  folders: [],
  activeChatId: null,
  isHistoryLoading: false,

  fetchHistory: async () => {
    if (!get().user) return;
    set({ isHistoryLoading: true });
    try {
      const response = await apiService.history.get();
      set({
        conversations: response.data.conversations || [],
        folders: response.data.folders || [],
        isHistoryLoading: false,
      });
      const activeId = get().activeChatId;
      if (activeId) {
        const chat = (response.data.conversations || []).find((c) => c.id === activeId);
        // The chat on screen is still being written by a live answer: the saved copy is older, keep the live one.
        if (chat && !get().generatingChats[activeId]) {
          set({ activeMessages: chat.messages || [] });
        }
      }
    } catch (err) {
      set({ isHistoryLoading: false });
      console.error('Failed to fetch history:', err);
    }
  },

  // Switching chats / pages never stops an answer. The chat you leave keeps generating in the background
  // (its messages are parked in backgroundChats) and is picked up again when you come back to it.
  selectChat: (chatId) => {
    if (chatId && chatId === get().activeChatId) return;
    get().discardSoftwareChoices();
    get().clearAttachments();
    get()._parkActiveChat();
    const state = get();
    const run = chatId ? state.generatingChats[chatId] : null;
    let messages = [];
    let background = state.backgroundChats;
    if (chatId && background[chatId]) {
      messages = background[chatId];
      const { [chatId]: _taken, ...rest } = background;
      background = rest;
    } else if (chatId) {
      messages = state.conversations.find((c) => c.id === chatId)?.messages || [];
    }
    set({
      backgroundChats: background,
      activeChatId: chatId,
      activeMessages: messages,
      activeSources: [],
      isGenerating: !!run,
      activeAbortController: run?.controller || null,
      avatarSpeaking: false,
    });
  },

  createChat: () => {
    get().discardSoftwareChoices();
    get().clearAttachments();
    get()._parkActiveChat();
    set({
      activeChatId: null,
      activeMessages: [],
      activeSources: [],
      isGenerating: false,
      activeAbortController: null,
      avatarSpeaking: false,
    });
  },

  deleteChat: async (chatId) => {
    try {
      get()._abortChatRun(chatId);
      await apiService.history.delete(chatId);
      if (get().activeChatId === chatId) {
        set({
          activeChatId: null,
          activeMessages: [],
          activeSources: [],
          isGenerating: false,
          activeAbortController: null,
        });
      }
      get().fetchHistory();
    } catch (err) {
      console.error('Failed to delete chat:', err);
    }
  },

  renameChat: async (chatId, title) => {
    try {
      await apiService.history.update(chatId, { title });
      get().fetchHistory();
    } catch (err) {
      console.error('Failed to rename chat:', err);
    }
  },

  pinChat: async (chatId, isPinned) => {
    try {
      await apiService.history.update(chatId, { isPinned });
      get().fetchHistory();
    } catch (err) {
      console.error('Failed to pin chat:', err);
    }
  },

  bookmarkChat: async (chatId, isBookmarked) => {
    try {
      await apiService.history.update(chatId, { isBookmarked });
      get().fetchHistory();
    } catch (err) {
      console.error('Failed to bookmark chat:', err);
    }
  },

  moveChatToFolder: async (chatId, folderId) => {
    try {
      await apiService.history.update(chatId, { folderId });
      get().fetchHistory();
    } catch (err) {
      console.error('Failed to move chat to folder:', err);
    }
  },

  // Folder CRUD
  createFolder: async (name) => {
    try {
      await apiService.history.createFolder(name);
      get().fetchHistory();
    } catch (err) {
      console.error('Failed to create folder:', err);
    }
  },

  renameFolder: async (folderId, name) => {
    try {
      await apiService.history.updateFolder(folderId, name);
      get().fetchHistory();
    } catch (err) {
      console.error('Failed to rename folder:', err);
    }
  },

  deleteFolder: async (folderId) => {
    try {
      await apiService.history.deleteFolder(folderId);
      get().fetchHistory();
    } catch (err) {
      console.error('Failed to delete folder:', err);
    }
  },

  // Auto-Repair (autonomous diagnose-and-fix agent) mode
  autoRepairMode: false,
  toggleAutoRepair: () => set((state) => ({ autoRepairMode: !state.autoRepairMode })),

  // Feedback prompt for the most recent repair ("did it work?") — trains the model
  pendingRepairFeedback: null, // { sessionId, chatId }
  submitRepairFeedback: async (worked) => {
    const fb = get().pendingRepairFeedback;
    if (!fb) return;
    set({ pendingRepairFeedback: null });
    try {
      await apiService.repair.feedback(fb.sessionId, worked);
    } catch (err) {
      console.warn('Failed to submit repair feedback:', err);
    }
  },

  // Chat Streaming
  activeMessages: [],
  isGenerating: false,
  activeSources: [],

  _streamAutoRepair: async (goal, chatId, abortController, userMessageId) => {
    const assistantMsg = {
      id: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2),
      chatId,
      role: 'assistant',
      content: '🏢 **Auto-Repair started** — analyzing the problem…\n',
      createdAt: new Date().toISOString(),
    };
    get()._updateChat(chatId, (messages) => [...messages, assistantMsg]);

    const append = (text) =>
      get()._updateChat(chatId, (messages) =>
        messages.map((m) => (m.id === assistantMsg.id ? { ...m, content: m.content + text } : m)),
      );

    try {
      await apiService.streamRepair(
        { goal, conversationId: chatId, userMessageId },
        {
          signal: abortController.signal,
          onEvent: (event) => {
            const p = event.payload || {};
            switch (event.type) {
              case 'intent':
                set({ generationStatus: 'Checking your system' });
                break;
              case 'plan':
                set({ generationStatus: 'Preparing a repair plan' });
                break;
              case 'agent':
                set({ generationStatus: 'Checking your system' });
                break;
              case 'thought':
                break;
              case 'command':
                set({ generationStatus: 'Repairing your system' });
                break;
              case 'output':
                break;
              case 'blocked':
                set({ generationStatus: 'Waiting for your approval' });
                break;
              case 'final':
                if (p.confirmationId) {
                  append(
                    '\nApproval is required to continue. Review the action in the approval dialog.\n',
                  );
                  get().addConfirmation({
                    confirmationId: p.confirmationId,
                    message: p.confirmationMessage,
                    approvalDetails: p.approvalDetails,
                    messageId: assistantMsg.id,
                    repair: {
                      sessionId: p.sessionId,
                      revision: p.revision,
                      requestId: p.requestId,
                    },
                  });
                  break;
                }
                append(
                  `\n\n### ${p.resolved ? '✅ Resolved' : p.scope === 'diagnostics_only' && p.success ? 'Diagnostics completed' : '⚠️ Not fully resolved'}\n${p.answer || p.summary || 'The result could not be verified.'}\n${p.recommendation ? `\n**👉 Recommendation:** ${p.recommendation}\n` : ''}`,
                );
                if (p.sessionId && p.scope !== 'diagnostics_only')
                  set({
                    pendingRepairFeedback: { sessionId: p.sessionId, chatId },
                  });
                break;
              case 'error':
                append(`\n❌ **Error:** ${p.message}\n`);
                break;
              default:
                break;
            }
          },
        },
      );
    } catch (err) {
      if (err.name !== 'AbortError') {
        append(`\n❌ **Auto-Repair failed:** ${err.message}\n`);
      }
    }
  },

  sendMessage: async (content, screenCapture, continuation = null, attachments = []) => {
    if (!continuation && get().pendingSoftwareChoices.length) get().discardSoftwareChoices();
    if (!content.trim() && !screenCapture && !continuation && !attachments.length) return;
    if (get().isGenerating) {
      if (continuation) return;
      // A new question in the chat that is still answering interrupts that answer (like other chat apps)
      // instead of being silently dropped. Answers running in OTHER chats are not touched.
      get().stopGeneration();
      await new Promise((resolve) => setTimeout(resolve, 60));
    }

    // An open "which application?" question is answered by a reply that exactly names one offered application; that
    // reply is the answer, not a new request. Any other new request supersedes the question.
    if (!continuation && !attachments.length && get().pendingAppChoices.length) {
      const answer = matchTypedAppChoice(content, get().pendingAppChoices);
      if (answer) {
        set((state) => ({
          activeMessages: [
            ...state.activeMessages,
            {
              id: crypto.randomUUID(),
              chatId: get().activeChatId,
              role: 'user',
              content: content.trim(),
              createdAt: new Date().toISOString(),
            },
          ],
        }));
        await get().chooseApp(answer.choice.choiceId, answer.candidate.id);
        return;
      }
      await Promise.all(
        get().pendingAppChoices.map((c) =>
          get().cancelAppChoice(c.choiceId, 'Superseded by a new request.'),
        ),
      );
    }

    let chatId = get().activeChatId;
    if (!chatId) {
      chatId = crypto.randomUUID
        ? crypto.randomUUID()
        : Math.random().toString(36).substring(2, 15);
    }

    const tempUserMessage = {
      id: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2, 15),
      chatId,
      role: 'user',
      content: content.trim(),
      attachments: attachments.map(
        ({ id, name, size, mimeType, status, scope, mediaType, kind, width, height }) => ({
          id,
          name,
          size,
          mimeType,
          status,
          scope,
          mediaType,
          kind,
          width,
          height,
        }),
      ),
      createdAt: new Date().toISOString(),
    };

    const chatAbortController = new AbortController();
    set((state) => ({
      activeChatId: chatId,
      activeMessages: continuation
        ? state.activeMessages
        : [...state.activeMessages, tempUserMessage],
      isGenerating: true,
      activeSources: [],
      pendingRepairFeedback: null,
      activeAbortController: chatAbortController,
      generatingChats: {
        ...state.generatingChats,
        [chatId]: { controller: chatAbortController, startedAt: Date.now() },
      },
    }));
    // Everything below writes to THIS chat (on screen or parked in the background) and only touches the
    // shared status/avatar state while this chat is the one being looked at.
    const onScreen = () => get().activeChatId === chatId;
    let needsHistorySync = false;

    // Auto-Repair mode: run the autonomous diagnose-and-fix agent instead of chat.
    if ((get().autoRepairMode || repairTask(content)) && !continuation && !attachments.length) {
      await get()._streamAutoRepair(content, chatId, chatAbortController, tempUserMessage.id);
      get()._endRun(chatId, chatAbortController);
      return;
    }

    // 1. Fetch available tools from Electron Tool Engine
    let ollamaTools = [];
    const needsDesktopTools = shouldLoadChatTools(content, attachments, continuation, computerTask);
    if (window.toolEngine && needsDesktopTools) {
      try {
        const toolsMap = await window.toolEngine.getTools();
        ollamaTools = mapToolsToOllamaSchema(toolsMap);
      } catch (e) {
        console.warn('Failed to load tools from engine', e);
      }
    }

    let execution;
    try {
      execution = continuation?.execution || createChatExecution(content);
      if (!continuation) {
        execution.attachmentIds = attachments.map((attachment) => attachment.id);
        execution.userMessageId = tempUserMessage.id;
      }
    } catch (error) {
      get()._updateChat(chatId, (messages) => [
        ...messages,
        {
          id: crypto.randomUUID(),
          chatId,
          role: 'assistant',
          content: `Checkpoint unavailable: ${error.message}`,
        },
      ]);
      get()._endRun(chatId, chatAbortController);
      return;
    }

    // ReAct Loop: Continue generating if a tool call was made
    while (!execution.stopped && !chatAbortController.signal.aborted) {
      const tempAssistantMessage = {
        id: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2, 15),
        chatId,
        role: 'assistant',
        content: '',
        createdAt: new Date().toISOString(),
      };

      get()._updateChat(chatId, (messages) => [...messages, tempAssistantMessage]);

      const startTime = Date.now();
      let tokenCount = 0;
      const pendingToolCalls = [];
      let softwareChoice = null;

      try {
        // Build history to send to LLM (exclude the newly added empty assistant message)
        const chatHistory = get()
          ._chatMessages(chatId)
          .slice(0, -1)
          // An interrupted/empty assistant bubble carries nothing for the model.
          .filter((m) => m.role !== 'assistant' || String(m.content || '').trim() || m.tool_calls)
          .map((m) => {
            if (m.role === 'tool') {
              return {
                role: 'tool',
                content: m.content,
                tool_call_id: m.tool_call_id,
                tool_name: m.tool_name,
              };
            }
            return {
              role: m.role,
              content: m.content,
              ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
            };
          });

        await apiService.streamChat(
          {
            installedApps: needsDesktopTools ? get().installedApps : [],
            message: execution.state.task, // Preserve the original goal on continuation.
            history: chatHistory,
            tools: ollamaTools,
            // Model routes are configured in Settings. The first tag from /models is not a user pin.
            model: null,
            conversationId: chatId,
            workspaceId: get().activeWorkspaceId,
            userMessageId: execution.userMessageId,
            attachmentIds: execution.attachmentIds || [],
            screenCapture,
            agentProfile: get().selectedAgentProfile,
          },
          {
            signal: chatAbortController.signal,
            onSources: (sources) => {
              if (onScreen()) set({ activeSources: sources });
              get()._updateChat(chatId, (messages) =>
                messages.map((m) => (m.id === tempAssistantMessage.id ? { ...m, sources } : m)),
              );
            },
            onRoute: (route) => {
              if (!onScreen()) return;
              // Say which agent and which local model the request was assigned to.
              const assigned = [route.agentLabel, route.model].filter(Boolean).join(' · ');
              set({
                generationStatus: route.queued
                  ? 'Waiting for your other chat to finish'
                  : `${
                      route.route === 'windows'
                        ? 'Checking your system'
                        : 'Reading and preparing a response'
                    }${assigned ? ` (${assigned})` : ''}`,
              });
            },
            onToken: (token) => {
              tokenCount++;
              // First token = the model has actually started replying, as
              // distinct from still deciding what to say.
              if (tokenCount === 1 && onScreen()) set({ avatarSpeaking: true });
              get()._updateChat(chatId, (messages) =>
                messages.map((m) =>
                  m.id === tempAssistantMessage.id ? { ...m, content: m.content + token } : m,
                ),
              );
              const duration = (Date.now() - startTime) / 1000;
              if (duration > 0.1 && onScreen()) {
                set((state) => ({
                  metrics: {
                    ...state.metrics,
                    tokensPerSec: Math.round(tokenCount / duration),
                    latency: Math.round(duration * 1000),
                  },
                }));
              }
            },
            onToolCall: (toolCall) => {
              pendingToolCalls.push(toolCall);
            },
            onSoftwareChoice: (choice) => {
              softwareChoice = choice;
            },
            // File agent progress ("Reading report.pdf: part 3 of 9").
            onStatus: (text) => {
              if (onScreen() && typeof text === 'string') set({ generationStatus: text.slice(0, 200) });
            },
            onMemory: (decision) => {
              const notice =
                decision === 'ASK_USER'
                  ? 'That preference was not saved. Say "Remember ..." or save it in Memory settings.'
                  : decision === 'DO_NOT_SAVE'
                    ? 'That content was not saved as long-term memory.'
                    : decision === 'SAVE' || decision === 'UPDATE_EXISTING'
                      ? 'Saved to your long-term memory.'
                      : null;
              if (notice)
                get()._updateChat(chatId, (messages) =>
                  messages.map((m) =>
                    m.id === tempAssistantMessage.id
                      ? { ...m, content: m.content + notice + '\n\n' }
                      : m,
                  ),
                );
            },
            onDone: (dbMessage) => {
              // Finalize message object
            },
          },
        );

        // Transport/UI adapter: AgentState admits every call, including multiple calls per response.
        if (softwareChoice) {
          set((state) => ({
            pendingSoftwareChoices: [
              ...state.pendingSoftwareChoices.filter(
                (item) => item.discoveryId !== softwareChoice.discoveryId,
              ),
              { ...softwareChoice, execution, tools: ollamaTools, chatId, resolving: false },
            ],
          }));
          break;
        } else if (pendingToolCalls.length) {
          get()._updateChat(chatId, (messages) =>
            messages.map((m) =>
              m.id === tempAssistantMessage.id ? { ...m, tool_calls: pendingToolCalls } : m,
            ),
          );
          for (const call of pendingToolCalls) {
            if (execution.stopped) break;
            const observation = await executeChatCall(
              execution,
              call,
              ollamaTools,
              (tool, action, params, toolCallId, identity) =>
                window.toolEngine
                  ? executeCancellableTool(
                      window.toolEngine,
                      tool,
                      action,
                      params,
                      toolCallId,
                      identity,
                    )
                  : Promise.resolve({
                      success: false,
                      error: {
                        code: 'BRIDGE_UNAVAILABLE',
                        message: 'Tool Engine unavailable.',
                      },
                    }),
              chatAbortController.signal,
            );
            if (!observation) break;
            const messageId = crypto.randomUUID();
            get()._updateChat(chatId, (messages) => [
              ...messages,
              {
                id: messageId,
                chatId,
                role: 'tool',
                tool_call_id: observation.toolCallId,
                tool_name: call.function?.name,
                content: JSON.stringify(observation),
                createdAt: new Date().toISOString(),
              },
            ]);
            if (observation.needsConfirmation)
              get().addConfirmation({
                confirmationId: observation.confirmationId,
                message: observation.confirmationMessage,
                approvalDetails: observation.approvalDetails,
                messageId,
                execution,
                tools: ollamaTools,
                remainingCalls: pendingToolCalls.slice(pendingToolCalls.indexOf(call) + 1),
              });
            if (observation.needsAppChoice)
              get().addAppChoice(
                appChoiceEntry(observation, {
                  execution,
                  tools: ollamaTools,
                  messageId,
                  remainingCalls: pendingToolCalls.slice(pendingToolCalls.indexOf(call) + 1),
                }),
              );
          }
        } else {
          finishChat(execution);
          needsHistorySync = true;
        }
      } catch (err) {
        if (err.name !== 'AbortError') {
          console.error('Chat error:', err);
          get()._updateChat(chatId, (messages) =>
            messages.map((m) =>
              m.id === tempAssistantMessage.id
                ? {
                    ...m,
                    content: `Error: ${err.message || 'Could not generate response.'}`,
                  }
                : m,
            ),
          );
        }
        execution.stop(err.name === 'AbortError' ? 'cancelled' : 'error', err.message);
      }
    }

    if (chatAbortController.signal.aborted && !execution.stopped)
      execution.stop('cancelled', 'aborted');
    if (execution.state.phase === 'error') {
      get()._updateChat(chatId, (messages) => [
        ...messages,
        {
          id: crypto.randomUUID(),
          chatId,
          role: 'assistant',
          content: `Execution stopped: ${execution.state.verdict?.summary || 'Unknown failure'}`,
          createdAt: new Date().toISOString(),
        },
      ]);
    }

    // A newer question in this chat may already own the run (this one was interrupted): don't reset its state.
    get()._endRun(chatId, chatAbortController);
    if (needsHistorySync) {
      // Pull the saved copy (real ids, titles) once the run no longer owns the screen's messages.
      await get().fetchHistory();
      get()._dropBackground(chatId);
    }
  },

  // ---- Per-chat generation -------------------------------------------------------------------
  // generatingChats: chats with an answer in flight (any chat, on screen or not) → { controller }.
  // backgroundChats: messages of chats that are running (or just finished) while another chat is on screen.
  generatingChats: {},
  backgroundChats: {},
  _chatMessages: (chatId) =>
    chatId === get().activeChatId ? get().activeMessages : get().backgroundChats[chatId] || [],
  // Apply a message-list change to a chat wherever its messages currently live.
  _updateChat: (chatId, change) =>
    set((state) => {
      if (state.activeChatId === chatId) return { activeMessages: change(state.activeMessages) };
      if (state.generatingChats[chatId] || state.backgroundChats[chatId])
        return {
          backgroundChats: {
            ...state.backgroundChats,
            [chatId]: change(state.backgroundChats[chatId] || []),
          },
        };
      return {};
    }),
  // Leaving a chat that is still answering: keep its messages so the answer keeps landing in them.
  _parkActiveChat: () => {
    const { activeChatId, generatingChats, activeMessages, backgroundChats } = get();
    if (activeChatId && generatingChats[activeChatId])
      set({ backgroundChats: { ...backgroundChats, [activeChatId]: activeMessages } });
  },
  _dropBackground: (chatId) => {
    const { backgroundChats, generatingChats, conversations } = get();
    if (!backgroundChats[chatId] || generatingChats[chatId]) return;
    if (!conversations.some((c) => c.id === chatId)) return; // not saved yet: keep what we have
    const { [chatId]: _done, ...rest } = backgroundChats;
    set({ backgroundChats: rest });
  },
  // The run for chatId is over (finished, failed or stopped). Ignored when a newer run already took over.
  _endRun: (chatId, controller) => {
    const run = get().generatingChats[chatId];
    if (run && run.controller !== controller) return;
    set((state) => {
      const { [chatId]: _ended, ...rest } = state.generatingChats;
      return {
        generatingChats: rest,
        ...(state.activeChatId === chatId
          ? { isGenerating: false, avatarSpeaking: false, activeAbortController: null }
          : {}),
      };
    });
  },
  _abortChatRun: (chatId) => {
    const run = chatId ? get().generatingChats[chatId] : null;
    if (!run) return;
    run.controller.abort();
    get()._endRun(chatId, run.controller);
    get()._dropBackground(chatId);
  },
  stopAllGenerations: () => {
    for (const run of Object.values(get().generatingChats)) run.controller.abort();
    get().activeAbortController?.abort();
    set({
      generatingChats: {},
      backgroundChats: {},
      isGenerating: false,
      avatarSpeaking: false,
      activeAbortController: null,
    });
  },

  activeAbortController: null,
  setAbortController: (ctrl) => set({ activeAbortController: ctrl }),
  // Stop = the chat you are looking at. Answers running in other chats are left alone.
  stopGeneration: () => {
    const chatId = get().activeChatId;
    const run = chatId ? get().generatingChats[chatId] : null;
    const ctrl = run?.controller || get().activeAbortController;
    if (!ctrl) return;
    ctrl.abort();
    if (chatId && run) get()._endRun(chatId, ctrl);
    set({ isGenerating: false, avatarSpeaking: false, activeAbortController: null });
  },

  activeWorkspaceId: null,
  setActiveWorkspaceId: (id) => set({ activeWorkspaceId: id }),
  fetchActiveWorkspace: async () => {
    if (!get().user) return;
    try {
      const result = await apiService.workspaces.get();
      set({
        activeWorkspaceId:
          result.data.workspaces?.find((workspace) => workspace.active)?.id || null,
      });
    } catch {
      /* Workspaces can be refreshed in Settings after backend recovery. */
    }
  },
  // Draft chat files are separate from the long-term knowledge catalog.
  pendingAttachments: [],
  isUploadingAttachments: false,
  generationStatus: 'Preparing a response',
  stageAttachments: async (files) => {
    if (get().isUploadingAttachments)
      throw new Error('Wait for the current files to finish uploading.');
    const available = MAX_ATTACHMENTS - get().pendingAttachments.length;
    if (files.length > available)
      throw new Error(`Attach at most ${MAX_ATTACHMENTS} files per message.`);
    const entries = Array.from(files).map((file) => ({
      clientId: crypto.randomUUID(),
      name: file.name,
      size: file.size,
      file,
      status: validateAttachment(file) ? 'error' : 'queued',
      error: validateAttachment(file),
      progress: 0,
    }));
    set((state) => ({
      pendingAttachments: [...state.pendingAttachments, ...entries],
      isUploadingAttachments: true,
    }));
    const patch = (clientId, fields) =>
      set((state) => ({
        pendingAttachments: state.pendingAttachments.map((entry) =>
          entry.clientId === clientId ? { ...entry, ...fields } : entry,
        ),
      }));
    try {
      for (const entry of entries) {
        if (
          entry.error ||
          !get().pendingAttachments.some((item) => item.clientId === entry.clientId)
        )
          continue;
        const controller = new AbortController();
        patch(entry.clientId, { status: 'uploading', controller });
        const data = new FormData();
        data.append('purpose', 'attachment');
        data.append('documents', entry.file);
        try {
          const response = await apiService.documents.upload(
            data,
            (event) =>
              patch(entry.clientId, {
                progress: event.total
                  ? Math.min(99, Math.round((event.loaded * 100) / event.total))
                  : 0,
              }),
            controller.signal,
          );
          const document = response.data.documents?.[0];
          if (!document)
            throw new Error(response.data.skipped?.[0]?.reason || 'The file could not be read.');
          if (!get().pendingAttachments.some((item) => item.clientId === entry.clientId)) {
            await apiService.documents.delete(document.id);
            continue;
          }
          patch(entry.clientId, {
            ...document,
            file: undefined,
            controller: undefined,
            status: 'ready',
            progress: 100,
            warning: response.data.warnings?.[0]?.message,
          });
        } catch (error) {
          if (!controller.signal.aborted)
            patch(entry.clientId, {
              status: 'error',
              controller: undefined,
              error:
                error.response?.data?.error ||
                error.message ||
                'Upload failed. Remove this file and try again.',
            });
        }
      }
    } finally {
      set({ isUploadingAttachments: false });
    }
  },
  removeAttachment: async (clientId) => {
    const entry = get().pendingAttachments.find((item) => item.clientId === clientId);
    if (!entry) return;
    entry.controller?.abort();
    set((state) => ({
      pendingAttachments: state.pendingAttachments.filter((item) => item.clientId !== clientId),
    }));
    if (entry.id) await apiService.documents.delete(entry.id).catch(() => {});
  },
  clearAttachments: () => {
    for (const entry of get().pendingAttachments) get().removeAttachment(entry.clientId);
  },
  consumeAttachments: () => {
    const files = get().pendingAttachments.filter((entry) => entry.status === 'ready');
    set({ pendingAttachments: [] });
    return files;
  },

  // Document Uploads (only the explicit advanced Knowledge action)
  documents: [],
  isUploadingDocs: false,
  uploadProgress: 0,
  fetchDocuments: async () => {
    if (!get().user) return;
    try {
      const response = await apiService.documents.get();
      set({ documents: response.data.documents || [] });
    } catch (err) {
      console.error('Failed to get documents:', err);
    }
  },
  uploadDocuments: async (files) => {
    if (!files.length) return;
    set({ isUploadingDocs: true, uploadProgress: 0 });
    const formData = new FormData();
    formData.append('purpose', 'knowledge');
    for (let i = 0; i < files.length; i++) {
      formData.append('documents', files[i]);
    }
    try {
      const response = await apiService.documents.upload(formData, (progressEvent) => {
        const percent = Math.round(
          (progressEvent.loaded * 100) / (progressEvent.total || progressEvent.loaded || 1),
        );
        set({ uploadProgress: percent });
      });
      set({ isUploadingDocs: false, uploadProgress: 100 });
      get().fetchDocuments();
      return response.data;
    } catch (err) {
      set({ isUploadingDocs: false });
      console.error('Failed to upload docs:', err);
      throw err;
    }
  },
  deleteDocument: async (id) => {
    try {
      await apiService.documents.delete(id);
      get().fetchDocuments();
    } catch (err) {
      console.error('Failed to delete document:', err);
    }
  },

  // Pinned AI Memories
  memories: [],
  isMemoriesLoading: false,
  fetchMemories: async (type) => {
    if (!get().user) return;
    set({ isMemoriesLoading: true });
    try {
      const response = await apiService.memories.get(type);
      set({ memories: response.data.memories || [], isMemoriesLoading: false });
    } catch (err) {
      set({ isMemoriesLoading: false });
      console.error('Failed to fetch memories:', err);
    }
  },
  addMemory: async (content, type) => {
    try {
      await apiService.memories.create(content, type);
      get().fetchMemories();
    } catch (err) {
      console.error('Failed to create memory:', err);
    }
  },
  deleteMemory: async (id) => {
    try {
      await apiService.memories.delete(id);
      get().fetchMemories();
    } catch (err) {
      console.error('Failed to delete memory:', err);
    }
  },
  clearMemories: async (type) => {
    try {
      await apiService.memories.clear(type);
      get().fetchMemories();
    } catch (err) {
      console.error('Failed to clear memories:', err);
    }
  },

  // Performance dashboard
  metrics: {
    cpu: null,
    ram: null,
    gpu: null,
    temperature: null,
    disk: null,
    electronMemory: null,
    backendMemoryBytes: null,
    diskRoot: '',
    hardware: null,
    acceleration: null,
    gpuUnavailableReason: 'GPU utilization is not measured.',
    tokensPerSec: 0,
    latency: 0,
  },
  fetchMetrics: async () => {
    try {
      const response = await apiService.stats.get();
      set((state) => ({
        metrics: {
          ...state.metrics,
          cpu: response.data.cpu,
          ram: response.data.ram,
          gpu: response.data.gpu,
          temperature: response.data.temperature,
          disk: response.data.disk,
          electronMemory: response.data.electronMemory,
          backendMemoryBytes: response.data.backendMemoryBytes,
          diskRoot: response.data.diskRoot || '',
          hardware: response.data.hardware || null,
          acceleration: response.data.acceleration || null,
          gpuUnavailableReason:
            response.data.gpuUnavailableReason || 'GPU utilization is not measured.',
        },
      }));
    } catch (err) {
      set((state) => ({
        metrics: {
          ...state.metrics,
          cpu: null,
          ram: null,
          gpu: null,
          temperature: null,
          disk: null,
          electronMemory: null,
          backendMemoryBytes: null,
        },
      }));
      console.warn('Failed to poll stats:', err);
    }
  },

  // Settings State
  settings: {
    theme: localStorage.getItem('chanakya-theme') || 'dark',
    transparency: localStorage.getItem('chanakya-transparency') !== 'false',
    accentColor:
      localStorage.getItem('chanakya-accent') ||
      localStorage.getItem('chanakya-accentcolor') ||
      '#3b82f6',
    windowOpacity: Number(
      localStorage.getItem('chanakya-opacity') ||
        localStorage.getItem('chanakya-windowopacity') ||
        '0.94',
    ),
    animationsEnabled:
      (localStorage.getItem('chanakya-animations') ??
        localStorage.getItem('chanakya-animationsenabled')) !== 'false',
    startupWithWindows: localStorage.getItem('chanakya-startup') === 'true',
    alwaysOnTop: localStorage.getItem('chanakya-alwaysontop') !== 'false',
    fontSize: Number(localStorage.getItem('chanakya-fontsize') || '12'),
    animationSpeed: Number(localStorage.getItem('chanakya-animationspeed') || '1'),
    // Speak the hover greeting aloud. On by default — the avatar talking is the
    // point. Repetition is held back by a 90s cooldown rather than by silence,
    // and it can be turned off in Settings.
    voiceGreeting: localStorage.getItem('chanakya-voicegreeting') !== 'false',
  },
  updateSetting: (key, value) => {
    const storageKey =
      {
        accentColor: 'accent',
        windowOpacity: 'opacity',
        animationsEnabled: 'animations',
        startupWithWindows: 'startup',
        alwaysOnTop: 'alwaysontop',
      }[key] || key.toLowerCase();
    localStorage.setItem(`chanakya-${storageKey}`, String(value));
    set((state) => ({
      settings: {
        ...state.settings,
        [key]: value,
      },
    }));
  },
}));

// api.js clears the stored token itself on any 401 (it has no access to this
// store without a circular import) and dispatches this event so the in-memory
// state — `user`, chat history, etc. — gets reset too, rather than leaving
// the UI showing a "logged in" app shell whose every request now 401s.
if (typeof window !== 'undefined') {
  window.addEventListener('chanakya:session-expired', () => {
    useAppStore.getState().logout();
  });
}
