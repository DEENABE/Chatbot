import { create } from 'zustand';
import { createChatExecution, executeChatCall, finishChat, executeCancellableTool } from '../services/chatExecution.js';
import * as apiService from '../services/api.js';

import {mapToolsToOllamaSchema} from '../services/toolSchemas.js';
import {setInstalledApps} from '../../../backend/src/orchestrator/ComputerTaskPolicy.js';

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
      const response = await apiService.auth.register({ username, displayName, password });
      const { user, token } = response.data;
      await apiService.setSession(token);
      set({ user, isAuthLoading: false });
      get().fetchHistory();
      get().fetchDocuments();
      get().fetchMemories();
      get().loadInstalledApps();
      return user;
    } catch (err) {
      set({ isAuthLoading: false });
      throw err;
    }
  },

  logout: async () => {
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
      documents: [],
      memories: [],
      pendingConfirmations: []
    });
  },

  clearChat: () => {
    set({
      activeMessages: [],
      activeChatId: null,
      activeSources: [],
      isGenerating: false,
      pendingConfirmations: []
    });
    get().setAbortController(null);
  },

  // Tools & Confirmations
  pendingConfirmations: [],
  addConfirmation: (conf) => set((state) => ({ pendingConfirmations: [...state.pendingConfirmations, conf] })),
  removeConfirmation: (id) => set((state) => ({ pendingConfirmations: state.pendingConfirmations.filter(c => c.confirmationId !== id) })),
  renewConfirmation: async (id) => {
    const conf = get().pendingConfirmations.find(c => c.confirmationId === id);
    if(conf?.repair) {
      if(conf.renewing)return;
      const renewalId=conf.renewalId||crypto.randomUUID();
      set(s=>({pendingConfirmations:s.pendingConfirmations.map(c=>c.confirmationId===id?{...c,renewing:true,renewalId}:c)}));
      try {
        const {data:saved}=await apiService.repair.renew(conf.repair.sessionId,{expectedRevision:conf.repair.revision,renewalId});
        const o=saved.state.plan[saved.state.currentStepIndex].observation;
        set(s=>({pendingConfirmations:s.pendingConfirmations.map(c=>c.confirmationId===id?{...c,confirmationId:o.confirmationId,message:o.confirmationMessage,repair:{...c.repair,revision:saved.revision},renewing:false,renewalId:null}:c)}));
      } catch(error) {set(s=>({pendingConfirmations:s.pendingConfirmations.map(c=>c.confirmationId===id?{...c,renewing:false,renewalError:error.response?.data?.error||error.message}:c)}));}
      return;
    }
    if (!conf?.execution || conf.renewing) return;
    const renewalId = conf.renewalId || crypto.randomUUID();
    set(state => ({ pendingConfirmations: state.pendingConfirmations.map(c => c.confirmationId === id ? { ...c, renewalId, renewing: true, renewalError: null } : c) }));
    try {
      const renewal = await window.toolEngine.renewConfirmation(id, renewalId);
      conf.execution.renewConfirmation(renewal);
      set(state => ({ pendingConfirmations: state.pendingConfirmations.map(c => c.confirmationId === id ? {
        ...c, confirmationId: renewal.confirmationId, message: renewal.message, expiresAt: renewal.expiresAt,
        renewalId: null, renewing: false, renewalError: null,
      } : c) }));
    } catch (error) {
      set(state => ({ pendingConfirmations: state.pendingConfirmations.map(c => c.confirmationId === id ? { ...c, renewing: false, renewalError: error.message } : c) }));
    }
  },
  resolveConfirmation: async (id, approved) => {
    const conf = get().pendingConfirmations.find(c => c.confirmationId === id);
    if (!conf || conf.renewing) return;
    if(conf.repair) {
      set({isGenerating:true});
      set(s=>({pendingConfirmations:s.pendingConfirmations.map(c=>c.confirmationId===id?{...c,renewing:true}:c)}));
      const abort=new AbortController();get().setAbortController(abort);
      const cancel=()=>{apiService.repair.cancel(conf.repair.sessionId,conf.repair.requestId).catch(()=>{});};
      abort.signal.addEventListener('abort',cancel,{once:true});
      try {
        const {data:r}=approved?await apiService.repair.resume(conf.repair.sessionId,{expectedRevision:conf.repair.revision,confirmationId:id},abort.signal):await apiService.repair.cancel(conf.repair.sessionId,conf.repair.requestId);
        get().removeConfirmation(id);
        set(s=>({activeMessages:s.activeMessages.map(m=>m.id===conf.messageId?{...m,content:m.content+'\n\n'+(approved?r.summary:'Repair cancelled. Any admitted effect requires inspection.')}:m)}));
      } catch(error) {set(s=>({pendingConfirmations:s.pendingConfirmations.map(c=>c.confirmationId===id?{...c,renewing:false,renewalError:error.response?.data?.error||'Continuation failed. Inspect the checkpoint before trying again.'}:c)}));}
      finally {abort.signal.removeEventListener('abort',cancel);get().setAbortController(null);set({isGenerating:false});}
      return;
    }
    get().removeConfirmation(id);
    
    if (!window.toolEngine) return;
    // Confirmations raised by a UI panel (not a chat tool loop) just approve or cancel that one request.
    if (conf.standalone) {
      try {
        if (approved) await executeCancellableTool(window.toolEngine, '_system', 'confirm', { confirmationId: id }, crypto.randomUUID(), { requestId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() });
        else await window.toolEngine.cancel(id);
      } catch (error) { console.error('Standalone confirmation failed', error); }
      finally { conf.onSettled?.(); }
      return;
    }
    
    // We update the paused tool message to show it's resuming or cancelled
    const chatMsg = get().activeMessages.find(m => m.id === conf.messageId);
    if (chatMsg) {
       set((state) => ({
         activeMessages: state.activeMessages.map(m => 
           m.id === conf.messageId ? { ...m, content: approved ? '[RESUMING TOOL EXECUTION...]' : '[TOOL EXECUTION CANCELLED BY USER]' } : m
         )
       }));
    }

    try {
      let result;
      if (approved) {
        if (!conf.execution) throw new Error('Missing execution checkpoint for confirmation.');
        const continuationAbort = new AbortController();
        get().setAbortController(continuationAbort);
        result = await conf.execution.execute(step => executeCancellableTool(window.toolEngine, '_system', 'confirm',
          { confirmationId: id }, step.toolCallId, { ...step, signal: continuationAbort.signal }),
          { confirmationId: id, signal: continuationAbort.signal });
      } else {
        conf.execution?.stop('cancelled', 'User declined confirmation.');
        result = await window.toolEngine.cancel(id);
      }

      // Resume the ReAct loop by sending the result back!
      // To do this, we just append a tool message and call sendMessage with empty content.
      if (chatMsg) {
        set((state) => ({
          activeMessages: state.activeMessages.map(m => 
            m.id === conf.messageId ? { ...m, content: JSON.stringify(result) } : m
          )
        }));
      }

      if (approved && conf.execution && !conf.execution.stopped) {
        // A model can return several calls. Preserve the queue across approval.
        const remaining = conf.remainingCalls || [];
        for (let i = 0; i < remaining.length && !conf.execution.stopped; i++) {
          const call = remaining[i];
          const observation = await executeChatCall(conf.execution, call, conf.tools || [],
            (tool, action, params, toolCallId, identity) => executeCancellableTool(window.toolEngine, tool, action, params, toolCallId, identity), get().activeAbortController?.signal);
          if (!observation) break;
          const messageId = crypto.randomUUID();
          set((state) => ({ activeMessages: [...state.activeMessages, {
            id: messageId, chatId: get().activeChatId, role: 'tool', tool_call_id: observation.toolCallId,
            tool_name: call.function?.name, content: JSON.stringify(observation), createdAt: new Date().toISOString(),
          }] }));
          if (observation.needsConfirmation) get().addConfirmation({
            confirmationId: observation.confirmationId, message: observation.confirmationMessage, approvalDetails:observation.approvalDetails,
            messageId, execution: conf.execution, tools: conf.tools, remainingCalls: remaining.slice(i + 1),
          });
        }
        if (!conf.execution.stopped) await get().sendMessage('', false, { execution: conf.execution });
      }

    } catch (e) {
      conf.execution?.stop('error', e.message);
      console.error('Confirmation resolution failed', e);
    }
  },

  deleteChat: async (id) => {
    try {
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
      pendingConfirmations: []
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
  isExpanded: false,
  toggleExpand: async () => {
    const nextMode = !get().isExpanded;
    // Swap the view BEFORE resizing the window. Awaiting the IPC first left the
    // window at chat size while React still rendered the bubble, so the resize
    // showed an empty pane for a frame or two.
    set({ isExpanded: nextMode });
    if (window.electronAPI) {
      try {
        const expanded = await window.electronAPI.toggleExpand(nextMode);
        // Reconcile only if the main process disagreed (e.g. a rejected toggle).
        if (expanded !== nextMode) set({ isExpanded: expanded });
      } catch {
        set({ isExpanded: !nextMode });
      }
    }
  },

  // Minimize / close both collapse the window back to the bubble, so the store
  // has to follow suit — otherwise the app restores as an expanded chat while
  // the renderer is still rendering the collapsed view.
  collapseToBubble: () => set({ isExpanded: false }),

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
  selectedModelId: localStorage.getItem('chanakya-model') || 'qwen3.5:9b',
  // Installed third-party apps (name + aliases) so free-form requests naming one can be recognised. Refreshed lazily.
  installedApps: [],
  installedAppsAt: 0,
  loadInstalledApps: async (force = false) => {
    if (!window.toolEngine || (!force && get().installedApps.length && Date.now() - get().installedAppsAt < 600000)) return;
    try {
      const result = await window.toolEngine.execute('app', 'listApps', { limit: 200, withAliases: true }, crypto.randomUUID(), { requestId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() });
      const apps = (result?.data?.apps || []).map(a => ({ name: a.name, aliases: a.aliases || [] }));
      if (apps.length) { setInstalledApps(apps); set({ installedApps: apps, installedAppsAt: Date.now() }); }
    } catch { /* Admission then falls back to the explicit patterns; chat keeps working. */ }
  },
  isModelsLoading: false,
  fetchModels: async () => {
    set({ isModelsLoading: true });
    try {
      const response = await apiService.models.get();
      const models = response.data.models || [];
      set({ models, isModelsLoading: false });
      
      const currentChoice = models.find(m => m.id === get().selectedModelId);
      if ((!currentChoice || !currentChoice.installed) && models.length > 0) {
        const firstInstalled = models.find(m => m.installed);
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
    if (!get().user || get().isGenerating || get().isUploadingDocs) return;
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
        isHistoryLoading: false
      });
      const activeId = get().activeChatId;
      if (activeId) {
        const chat = (response.data.conversations || []).find(c => c.id === activeId);
        if (chat) {
          set({ activeMessages: chat.messages || [] });
        }
      }
    } catch (err) {
      set({ isHistoryLoading: false });
      console.error('Failed to fetch history:', err);
    }
  },

  selectChat: (chatId) => {
    set({ activeChatId: chatId, activeSources: [] });
    if (chatId) {
      const chat = get().conversations.find(c => c.id === chatId);
      set({ activeMessages: chat?.messages || [] });
    } else {
      set({ activeMessages: [] });
    }
  },

  createChat: () => {
    set({ activeChatId: null, activeMessages: [], activeSources: [] });
  },

  deleteChat: async (chatId) => {
    try {
      await apiService.history.delete(chatId);
      if (get().activeChatId === chatId) {
        set({ activeChatId: null, activeMessages: [], activeSources: [] });
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

  _streamAutoRepair: async (goal, chatId, abortController) => {
    const assistantMsg = {
      id: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2),
      chatId,
      role: 'assistant',
      content: '🏢 **Auto-Repair started** — analyzing the problem…\n',
      createdAt: new Date().toISOString()
    };
    set((state) => ({ activeMessages: [...state.activeMessages, assistantMsg] }));

    const append = (text) =>
      set((state) => ({
        activeMessages: state.activeMessages.map((m) =>
          m.id === assistantMsg.id ? { ...m, content: m.content + text } : m
        )
      }));

    try {
      await apiService.streamRepair(
        { goal, model: get().selectedModelId, conversationId:chatId },
        {
          signal: abortController.signal,
          onEvent: (event) => {
            const p = event.payload || {};
            switch (event.type) {
              case 'intent':
                append(`\n🧭 **Category:** ${p.domain}\n`);
                break;
              case 'plan':
                append(`\n📋 **Plan:** ${p.summary}\n${(p.steps || []).map((s, i) => `${i + 1}. ${s}`).join('\n')}\n`);
                break;
              case 'agent':
                append(`\n🤖 **${p.name}** is handling this…\n`);
                break;
              case 'thought':
                append(`\n💭 _${p.text}_\n`);
                break;
              case 'command':
                append(`\n**▶ Running** \`${p.command}\`\n`);
                break;
              case 'output': {
                const body = (p.stdout || p.stderr || '(no output)').slice(0, 700);
                append(`\n\`\`\`\n${body}\n\`\`\`\n`);
                break;
              }
              case 'blocked':
                append(`\n⛔ **Needs your approval (not run automatically):** \`${p.command}\`\n_${p.reason}_\n`);
                break;
              case 'final':
                if(p.confirmationId) {
                  append(`\n**Approval required:** ${p.confirmationMessage}\n`);
                  get().addConfirmation({confirmationId:p.confirmationId,message:p.confirmationMessage,approvalDetails:p.approvalDetails,messageId:assistantMsg.id,repair:{sessionId:p.sessionId,revision:p.revision,requestId:p.requestId}});
                  break;
                }
                append(`\n\n### ${p.resolved ? '✅ Resolved' : '⚠️ Not fully resolved'}\n${p.answer}\n${p.recommendation ? `\n**👉 Recommendation:** ${p.recommendation}\n` : ''}`);
                if (p.sessionId) set({ pendingRepairFeedback: { sessionId: p.sessionId, chatId } });
                break;
              case 'error':
                append(`\n❌ **Error:** ${p.message}\n`);
                break;
              default:
                break;
            }
          }
        }
      );
    } catch (err) {
      if (err.name !== 'AbortError') {
        append(`\n❌ **Auto-Repair failed:** ${err.message}\n`);
      }
    }
  },

  sendMessage: async (content, screenCapture, continuation = null) => {
    if (!content.trim() && !screenCapture && !continuation) return;
    if (get().isGenerating) return;

    let chatId = get().activeChatId;
    if (!chatId) {
      chatId = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2, 15);
    }

    const tempUserMessage = {
      id: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2, 15),
      chatId,
      role: 'user',
      content: content.trim(),
      createdAt: new Date().toISOString()
    };

    set((state) => ({
      activeChatId: chatId,
      activeMessages: continuation ? state.activeMessages : [...state.activeMessages, tempUserMessage],
      isGenerating: true,
      activeSources: [],
      pendingRepairFeedback: null
    }));

    let chatAbortController = new AbortController();
    get().setAbortController(chatAbortController);

    // Auto-Repair mode: run the autonomous diagnose-and-fix agent instead of chat.
    if ((get().autoRepairMode || /\b(spooler|printer|printing|print service)\b/i.test(content)) && !continuation) {
      await get()._streamAutoRepair(content, chatId, chatAbortController);
      set({ isGenerating: false, avatarSpeaking: false });
      get().setAbortController(null);
      return;
    }

    // 1. Fetch available tools from Electron Tool Engine
    let ollamaTools = [];
    if (window.toolEngine) {
      try {
        const toolsMap = await window.toolEngine.getTools();
        ollamaTools = mapToolsToOllamaSchema(toolsMap);
      } catch (e) {
        console.warn('Failed to load tools from engine', e);
      }
    }

    let execution;
    try { execution = continuation?.execution || createChatExecution(content); }
    catch (error) {
      set((state) => ({ isGenerating: false, activeMessages: [...state.activeMessages, { id: crypto.randomUUID(), chatId, role: 'assistant', content: `Checkpoint unavailable: ${error.message}` }] }));
      get().setAbortController(null);
      return;
    }

    // ReAct Loop: Continue generating if a tool call was made
    while (!execution.stopped && !chatAbortController.signal.aborted) {
      const tempAssistantMessage = {
        id: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2, 15),
        chatId,
        role: 'assistant',
        content: '',
        createdAt: new Date().toISOString()
      };

      set((state) => ({
        activeMessages: [...state.activeMessages, tempAssistantMessage]
      }));

      const startTime = Date.now();
      let tokenCount = 0;
      const pendingToolCalls = [];

      try {
        // Build history to send to LLM (exclude the newly added empty assistant message)
        const chatHistory = get().activeMessages
          .slice(0, -1)
          .map((m) => {
             if (m.role === 'tool') {
               return { role: 'tool', content: m.content, tool_call_id: m.tool_call_id, tool_name: m.tool_name };
             }
             return { role: m.role, content: m.content, ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}) };
          });

        await apiService.streamChat(
          {
            installedApps: get().installedApps,
            message: execution.state.task, // Preserve the original goal on continuation.
            history: chatHistory,
            tools: ollamaTools,
            model: get().selectedModelId,
            conversationId: chatId,
            screenCapture,
            agentProfile: get().selectedAgentProfile
          },
          {
            signal: chatAbortController.signal,
            onSources: (sources) => {
              set({ activeSources: sources });
              set((state) => ({
                activeMessages: state.activeMessages.map((m) =>
                  m.id === tempAssistantMessage.id ? { ...m, sources } : m
                )
              }));
            },
            onToken: (token) => {
              tokenCount++;
              // First token = the model has actually started replying, as
              // distinct from still deciding what to say.
              if (tokenCount === 1) set({ avatarSpeaking: true });
              set((state) => ({
                activeMessages: state.activeMessages.map((m) =>
                  m.id === tempAssistantMessage.id ? { ...m, content: m.content + token } : m
                )
              }));
              const duration = (Date.now() - startTime) / 1000;
              if (duration > 0.1) {
                set((state) => ({
                  metrics: {
                    ...state.metrics,
                    tokensPerSec: Math.round(tokenCount / duration),
                    latency: Math.round(duration * 1000)
                  }
                }));
              }
            },
            onToolCall: (toolCall) => {
              pendingToolCalls.push(toolCall);
            },
            onMemory: (decision) => {
              const notice=decision==='ASK_USER'?'That preference was not saved. Say "Remember ..." or save it in Memory settings.':decision==='DO_NOT_SAVE'?'That content was not saved as long-term memory.':decision==='SAVE'||decision==='UPDATE_EXISTING'?'Saved to your long-term memory.':null;
              if(notice)set(state=>({activeMessages:state.activeMessages.map(m=>m.id===tempAssistantMessage.id?{...m,content:m.content+notice+'\n\n'}:m)}));
            },
            onDone: (dbMessage) => {
              // Finalize message object
            }
          }
        );

        // Transport/UI adapter: AgentState admits every call, including multiple calls per response.
        if (pendingToolCalls.length) {
          set((state) => ({ activeMessages: state.activeMessages.map(m =>
            m.id === tempAssistantMessage.id ? { ...m, tool_calls: pendingToolCalls } : m) }));
          for (const call of pendingToolCalls) {
            if (execution.stopped) break;
            const observation = await executeChatCall(execution, call, ollamaTools,
              (tool, action, params, toolCallId, identity) => window.toolEngine
                ? executeCancellableTool(window.toolEngine, tool, action, params, toolCallId, identity)
                : Promise.resolve({ success: false, error: { code: 'BRIDGE_UNAVAILABLE', message: 'Tool Engine unavailable.' } }),
              chatAbortController.signal);
            if (!observation) break;
            const messageId = crypto.randomUUID();
            set((state) => ({ activeMessages: [...state.activeMessages, {
              id: messageId, chatId, role: 'tool', tool_call_id: observation.toolCallId,
              tool_name: call.function?.name, content: JSON.stringify(observation), createdAt: new Date().toISOString(),
            }] }));
            if (observation.needsConfirmation) get().addConfirmation({
              confirmationId: observation.confirmationId, message: observation.confirmationMessage, approvalDetails:observation.approvalDetails,
              messageId, execution, tools: ollamaTools, remainingCalls: pendingToolCalls.slice(pendingToolCalls.indexOf(call) + 1),
            });
          }
        } else {
          finishChat(execution);
          get().fetchHistory();
        }

      } catch (err) {
        if (err.name !== 'AbortError') {
          console.error('Chat error:', err);
          set((state) => ({
            activeMessages: state.activeMessages.map((m) =>
              m.id === tempAssistantMessage.id
                ? { ...m, content: `Error: ${err.message || 'Could not generate response.'}` }
                : m
            )
          }));
        }
        execution.stop(err.name === 'AbortError' ? 'cancelled' : 'error', err.message);
      }
    }

    if (chatAbortController.signal.aborted && !execution.stopped) execution.stop('cancelled', 'aborted');
    if (execution.state.phase === 'error') {
      set((state) => ({ activeMessages: [...state.activeMessages, { id: crypto.randomUUID(), chatId, role: 'assistant',
        content: `Execution stopped: ${execution.state.verdict?.summary || 'Unknown failure'}`, createdAt: new Date().toISOString() }] }));
    }

    set({ isGenerating: false, avatarSpeaking: false });
    get().setAbortController(null);
  },

  activeAbortController: null,
  setAbortController: (ctrl) => set({ activeAbortController: ctrl }),
  stopGeneration: () => {
    const ctrl = get().activeAbortController;
    if (ctrl) {
      ctrl.abort();
      set({ isGenerating: false, avatarSpeaking: false, activeAbortController: null });
    }
  },

  // Document Uploads
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
    for (let i = 0; i < files.length; i++) {
      formData.append('documents', files[i]);
    }
    try {
      const response = await apiService.documents.upload(formData, (progressEvent) => {
        const percent = Math.round((progressEvent.loaded * 100) / progressEvent.total);
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
    cpu: 0,
    ram: 0,
    gpu: 0,
    temperature: 0,
    disk: 0,
    electronMemory: 0,
    tokensPerSec: 0,
    latency: 0
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
          electronMemory: response.data.electronMemory
        }
      }));
    } catch (err) {
      console.warn('Failed to poll stats:', err);
    }
  },

  // Settings State
  settings: {
    theme: localStorage.getItem('chanakya-theme') || 'dark',
    transparency: localStorage.getItem('chanakya-transparency') !== 'false',
    accentColor: localStorage.getItem('chanakya-accent') || '#3b82f6', // Changed gold to premium blue/purple accent
    windowOpacity: Number(localStorage.getItem('chanakya-opacity') || '0.94'),
    animationsEnabled: localStorage.getItem('chanakya-animations') !== 'false',
    startupWithWindows: localStorage.getItem('chanakya-startup') === 'true',
    alwaysOnTop: localStorage.getItem('chanakya-alwaysontop') !== 'false',
    fontSize: Number(localStorage.getItem('chanakya-fontsize') || '12'),
    animationSpeed: Number(localStorage.getItem('chanakya-animationspeed') || '1'),
    // Speak the hover greeting aloud. On by default — the avatar talking is the
    // point. Repetition is held back by a 90s cooldown rather than by silence,
    // and it can be turned off in Settings.
    voiceGreeting: localStorage.getItem('chanakya-voicegreeting') !== 'false'
  },
  updateSetting: (key, value) => {
    localStorage.setItem(`chanakya-${key.toLowerCase()}`, String(value));
    set((state) => ({
      settings: {
        ...state.settings,
        [key]: value
      }
    }));
  }
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
