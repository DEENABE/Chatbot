import { create } from 'zustand';
import * as apiService from '../services/api.js';

function mapToolsToOllamaSchema(toolsMap) {
  const ollamaTools = [];
  for (const [serviceName, actions] of Object.entries(toolsMap)) {
    for (const action of actions) {
      const properties = {};
      const required = [];
      for (const [paramName, paramSchema] of Object.entries(action.schema || {})) {
        properties[paramName] = {
          type: paramSchema.type === 'path' ? 'string' : paramSchema.type || 'string',
          description: paramSchema.description || `Parameter ${paramName}`
        };
        if (paramSchema.required) required.push(paramName);
      }
      ollamaTools.push({
        type: 'function',
        function: {
          name: `${serviceName}_${action.action}`,
          description: action.description || `Call action ${action.action} on ${serviceName}`,
          parameters: {
            type: 'object',
            properties,
            required
          }
        }
      });
    }
  }
  return ollamaTools;
}

export const useAppStore = create((set, get) => ({
  // User Management
  user: (() => {
    try {
      const raw = localStorage.getItem('chanakya-user');
      return raw && raw !== 'undefined' ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  })(),
  isAuthLoading: false,

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
      apiService.setSession(token);
      localStorage.setItem('chanakya-user', JSON.stringify(user));
      set({ user, isAuthLoading: false });
      get().fetchHistory();
      get().fetchDocuments();
      get().fetchMemories();
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
      apiService.setSession(token);
      localStorage.setItem('chanakya-user', JSON.stringify(user));
      set({ user, isAuthLoading: false });
      get().fetchHistory();
      get().fetchDocuments();
      get().fetchMemories();
      return user;
    } catch (err) {
      set({ isAuthLoading: false });
      throw err;
    }
  },

  logout: () => {
    // Best-effort server-side revocation — fire and forget, the local
    // session is cleared either way. Skipped if there's no token left to
    // send (e.g. this was already triggered by a 401 elsewhere).
    if (apiService.getToken()) {
      apiService.auth.logout().catch(() => {});
    }
    apiService.clearSession();
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
  resolveConfirmation: async (id, approved) => {
    const conf = get().pendingConfirmations.find(c => c.confirmationId === id);
    if (!conf) return;
    get().removeConfirmation(id);
    
    if (!window.toolEngine) return;
    
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
        result = await window.toolEngine.confirm(id);
      } else {
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

      // Automatically trigger LLM to continue
      get().sendMessage('', false);

    } catch (e) {
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
    apiService.setSession(response.data.token);
  },

  resetPassword: async (username, newPassword) => {
    await apiService.auth.resetPassword(username, newPassword);
  },

  updateProfile: async (data) => {
    try {
      const response = await apiService.auth.updateProfile(data);
      const user = response.data.user;
      localStorage.setItem('chanakya-user', JSON.stringify(user));
      set({ user });
    } catch (err) {
      console.error('Failed to update profile:', err);
      throw err;
    }
  },

  checkAuth: async () => {
    if (!get().user) return;
    // No token at all (e.g. leftover profile cache from before real sessions
    // existed) can't possibly authenticate — no point round-tripping to /me.
    if (!apiService.getToken()) {
      get().logout();
      return;
    }
    try {
      const response = await apiService.auth.me();
      const user = response.data.user;
      localStorage.setItem('chanakya-user', JSON.stringify(user));
      set({ user });
    } catch (err) {
      set({ isAuthLoading: false });
      // A real 401 means the session is actually gone (expired/revoked) —
      // that's not something staying "logged in" can paper over. Anything
      // else (network error, backend not up yet) keeps the previous,
      // deliberate behavior of staying logged in while offline.
      if (err?.response?.status === 401) {
        get().logout();
      } else {
        console.warn('Backend unreachable. Staying logged in since we are offline.');
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
  selectedModelId: localStorage.getItem('chanakya-model') || 'qwen3',
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
    if (get().isGenerating) return;
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
        { goal, model: get().selectedModelId },
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

  sendMessage: async (content, screenCapture) => {
    if (!content.trim() && !screenCapture) return;
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
      activeMessages: [...state.activeMessages, tempUserMessage],
      isGenerating: true,
      activeSources: [],
      pendingRepairFeedback: null
    }));

    let chatAbortController = new AbortController();
    get().setAbortController(chatAbortController);

    // Auto-Repair mode: run the autonomous diagnose-and-fix agent instead of chat.
    if (get().autoRepairMode) {
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

    let isDone = false;

    // ReAct Loop: Continue generating if a tool call was made
    while (!isDone && !chatAbortController.signal.aborted) {
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
      let pendingToolCall = null;

      try {
        // Build history to send to LLM (exclude the newly added empty assistant message)
        const chatHistory = get().activeMessages
          .slice(0, -1)
          .map((m) => {
             if (m.role === 'tool') {
               return { role: 'tool', content: m.content };
             }
             return { role: m.role, content: m.content };
          });

        await apiService.streamChat(
          {
            message: content, // The initial user query
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
              pendingToolCall = toolCall;
            },
            onDone: (dbMessage) => {
              // Finalize message object
            }
          }
        );

        // 2. Handle Tool Call
        if (pendingToolCall && window.toolEngine) {
          const fnName = pendingToolCall.function.name; // e.g. "file_readFile"
          const [serviceName, action] = fnName.split('_');
          let args = {};
          
          try {
            args = pendingToolCall.function.arguments || {};
            // Sometimes arguments come back as a JSON string, sometimes as an object
            if (typeof args === 'string') {
               args = JSON.parse(args);
            }
          } catch(e) {
            console.warn('Failed to parse tool arguments', e);
          }

          // Show tool execution message
          const tempToolMsg = {
             id: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2, 15),
             chatId,
             role: 'tool',
             content: `[EXECUTING TOOL] ${serviceName}.${action}(${JSON.stringify(args)})`,
             createdAt: new Date().toISOString()
          };
          
          set((state) => ({
             activeMessages: [...state.activeMessages, tempToolMsg]
          }));

          let toolOutput = "";
          try {
            const toolResult = await window.toolEngine.execute(serviceName, action, args);
            
            if (toolResult && toolResult.needsConfirmation) {
               // Add to pending confirmations so the modal shows up
               get().addConfirmation({
                 confirmationId: toolResult.confirmationId,
                 message: toolResult.message,
                 messageId: tempToolMsg.id
               });
               toolOutput = "ACTION PAUSED: Requires user confirmation. Check UI.";
               isDone = true; // Stop loop, wait for user
            } else {
               toolOutput = JSON.stringify(toolResult);
            }
          } catch(e) {
            toolOutput = JSON.stringify({ error: e.message });
          }

          set((state) => ({
             activeMessages: state.activeMessages.map((m) => 
               m.id === tempToolMsg.id ? { ...m, content: toolOutput } : m
             )
          }));
          
          // Loop will continue and send the new tool message back to LLM unless isDone is true
        } else {
          isDone = true; // No more tool calls, we are done
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
        isDone = true;
      }
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
      await apiService.documents.upload(formData, (progressEvent) => {
        const percent = Math.round((progressEvent.loaded * 100) / progressEvent.total);
        set({ uploadProgress: percent });
      });
      set({ isUploadingDocs: false, uploadProgress: 100 });
      get().fetchDocuments();
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
