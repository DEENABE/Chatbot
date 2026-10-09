const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('workspaceAPI', {
  chooseDirectory: () => ipcRenderer.invoke('workspace:choose-directory'),
});

const apiArgument = process.argv.find((value) => value.startsWith('--chanakya-api-base='));
const apiCandidate = apiArgument?.slice('--chanakya-api-base='.length);
const apiBaseUrl = /^http:\/\/127\.0\.0\.1:\d{1,5}\/api$/.test(apiCandidate || '')
  ? apiCandidate
  : 'http://127.0.0.1:3001/api';

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: () => true,
  getApiBaseUrl: () => apiBaseUrl,
  captureScreen: () => ipcRenderer.invoke('capture-screen'),
  getScreenSources: () => ipcRenderer.invoke('get-screen-sources'),
  toggleExpand: (expand) => ipcRenderer.invoke('window-toggle-expand', expand),

  // Custom Dragging
  dragStart: () => ipcRenderer.send('window-drag-start'),
  dragMove: () => ipcRenderer.send('window-drag-move'),
  dragEnd: () => ipcRenderer.send('window-drag-end'),

  // Window Management
  minimize: () => ipcRenderer.send('window-minimize'),
  close: () => ipcRenderer.send('window-close'),
  resize: (w, h) => ipcRenderer.send('window-resize', w, h),

  // Notifications and continuous listeners.
  // invoke, not send: the main process registers these with ipcMain.handle,
  // which never sees a send().
  showNotification: (title, body) => ipcRenderer.invoke('show-notification', { title, body }),
  onWakewordDetected: (callback) => {
    const subscription = (_event, data) => callback(data);
    ipcRenderer.on('wakeword-detected', subscription);
    return () => ipcRenderer.removeListener('wakeword-detected', subscription);
  },
  onClipboardChanged: (callback) => {
    const subscription = (_event, text) => callback(text);
    ipcRenderer.on('clipboard-changed', subscription);
    return () => ipcRenderer.removeListener('clipboard-changed', subscription);
  },
  // Text-to-speech via the Windows engine (Web Speech has no voices in Electron)
  speak: (text, options) => ipcRenderer.invoke('tts:speak', { text, ...options }),
  stopSpeaking: () => ipcRenderer.invoke('tts:stop'),
  getVoices: () => ipcRenderer.invoke('tts:voices'),

  setOcrMode: (enable) => ipcRenderer.invoke('window-set-ocr-mode', enable),
  setToolbarMode: (enable) => ipcRenderer.invoke('window-set-toolbar-mode', enable),
  saveFile: (name, base64) => ipcRenderer.invoke('save-file', { name, base64 }),
});

// Session token — held in main-process memory only (see SessionStore.js),
// never persisted to disk, so it doesn't survive an app restart.
contextBridge.exposeInMainWorld('sessionAPI', {
  getToken: () => ipcRenderer.invoke('auth:get-token'),
  setToken: (token) => ipcRenderer.invoke('auth:set-token', { token }),
  clearToken: () => ipcRenderer.invoke('auth:clear-token'),
});
contextBridge.exposeInMainWorld('softwareAPI', {
  providers: () => ipcRenderer.invoke('software:providers'),
  discover: (query, online = false) => ipcRenderer.invoke('software:discover', query, online),
  resolve: (candidateId) => ipcRenderer.invoke('software:resolve', candidateId),
  requestAction: (action, planId) => ipcRenderer.invoke('software:action', action, planId),
  registerSource: (descriptor, credential) =>
    ipcRenderer.invoke('software:register-source', descriptor, credential),
  removeSource: (registrationId) => ipcRenderer.invoke('software:remove-source', registrationId),
  choose: (discoveryId, candidateId) =>
    ipcRenderer.invoke('software:choose', discoveryId, candidateId),
  cancelChoice: (discoveryId) => ipcRenderer.invoke('software:cancel-choice', discoveryId),
  pickInstaller: (product) => ipcRenderer.invoke('software:pick-installer', product),
  pickDirectory: () => ipcRenderer.invoke('software:pick-directory'),
  reveal: (planId) => ipcRenderer.invoke('software:reveal', planId),
});

// Tool Engine IPC Bridge
contextBridge.exposeInMainWorld('toolEngine', {
  chooseOfflineInstaller: (query) => ipcRenderer.invoke('tool:select-offline-installer', query),
  requestOfflineInstall: (downloadId) =>
    ipcRenderer.invoke('tool:request-offline-install', downloadId),
  setAppPermission: (appId, level) => ipcRenderer.invoke('tool:app-permission', { appId, level }),
  renewConfirmation: (confirmationId, renewalId) =>
    ipcRenderer.invoke('tool:renew-confirmation', {
      confirmationId,
      renewalId,
    }),
  execute: (tool, action, params, toolCallId, identity = {}) =>
    ipcRenderer.invoke('tool:execute', {
      tool,
      action,
      params,
      toolCallId,
      requestId: identity.requestId,
      idempotencyKey: identity.idempotencyKey,
      routeGrant: identity.routeGrant,
    }),
  confirm: (confirmationId, identity = {}) =>
    ipcRenderer.invoke('tool:approve', {
      params: { confirmationId },
      toolCallId: identity.toolCallId,
      requestId: identity.requestId,
      idempotencyKey: identity.idempotencyKey,
    }),
  chooseApp: (choiceId, candidateId, identity = {}) =>
    ipcRenderer.invoke('tool:choose-app', {
      params: { choiceId, candidateId },
      toolCallId: identity.toolCallId,
      requestId: identity.requestId,
      idempotencyKey: identity.idempotencyKey,
    }),
  cancelAppChoice: (choiceId) =>
    ipcRenderer.invoke('tool:execute', {
      tool: '_system',
      action: 'cancelAppChoice',
      params: { choiceId },
    }),
  cancelRequest: (requestId) => ipcRenderer.invoke('tool:cancel-request', requestId),
  cancel: (confirmationId) =>
    ipcRenderer.invoke('tool:execute', {
      tool: '_system',
      action: 'cancel',
      params: { confirmationId },
    }),
  getDesktopStatus: () => ipcRenderer.invoke('tool:desktop-status'),
  getTools: () =>
    ipcRenderer.invoke('tool:execute', {
      tool: '_system',
      action: 'getTools',
      params: {},
    }),
  onConfirmationRequired: (callback) => {
    const subscription = (_event, data) => callback(data);
    ipcRenderer.on('tool:confirmation-required', subscription);
    return () => ipcRenderer.removeListener('tool:confirmation-required', subscription);
  },
});
