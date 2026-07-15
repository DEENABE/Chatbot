const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: () => true,
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

  // Notifications and continuous listeners
  showNotification: (title, body) => ipcRenderer.send('show-notification', { title, body }),
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
  setOcrMode: (enable) => ipcRenderer.invoke('window-set-ocr-mode', enable),
  setToolbarMode: (enable) => ipcRenderer.invoke('window-set-toolbar-mode', enable),
  saveFile: (name, base64) => ipcRenderer.invoke('save-file', { name, base64 })
});

// Tool Engine IPC Bridge
contextBridge.exposeInMainWorld('toolEngine', {
  execute: (tool, action, params) => ipcRenderer.invoke('tool:execute', { tool, action, params }),
  confirm: (confirmationId) => ipcRenderer.invoke('tool:execute', { tool: '_system', action: 'confirm', params: { confirmationId } }),
  cancel: (confirmationId) => ipcRenderer.invoke('tool:execute', { tool: '_system', action: 'cancel', params: { confirmationId } }),
  getTools: () => ipcRenderer.invoke('tool:execute', { tool: '_system', action: 'getTools', params: {} }),
  onConfirmationRequired: (callback) => {
    const subscription = (_event, data) => callback(data);
    ipcRenderer.on('tool:confirmation-required', subscription);
    return () => ipcRenderer.removeListener('tool:confirmation-required', subscription);
  }
});
