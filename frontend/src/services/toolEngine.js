/**
 * Tool Engine SDK — Renderer-side API for system tool operations.
 * Communicates with the main process via the preload bridge.
 */

const TOOL_NAMES = ['file', 'powershell', 'cmd', 'services', 'registry', 'hardware', 'process', 'network'];

class ToolEngineSDK {
  constructor() {
    this._confirmationCallbacks = [];
    this._initConfirmationListener();
  }

  _getBridge() {
    if (!window.toolEngine) {
      throw new Error('Tool Engine is not available. Are you running inside Electron?');
    }
    return window.toolEngine;
  }

  _initConfirmationListener() {
    try {
      const bridge = this._getBridge();
      bridge.onConfirmationRequired((data) => {
        this._confirmationCallbacks.forEach(cb => cb(data));
      });
    } catch {
      // Not in Electron — skip
    }
  }

  onConfirmationRequired(callback) {
    this._confirmationCallbacks.push(callback);
    return () => {
      this._confirmationCallbacks = this._confirmationCallbacks.filter(cb => cb !== callback);
    };
  }

  async execute(tool, action, params = {}) {
    return this._getBridge().execute(tool, action, params);
  }

  async confirm(confirmationId) {
    return this._getBridge().confirm(confirmationId);
  }

  async cancel(confirmationId) {
    return this._getBridge().cancel(confirmationId);
  }

  async getTools() {
    return this._getBridge().getTools();
  }

  // Convenience methods for each service
  async file(action, params = {}) { return this.execute('file', action, params); }
  async powershell(action, params = {}) { return this.execute('powershell', action, params); }
  async cmd(action, params = {}) { return this.execute('cmd', action, params); }
  async services(action, params = {}) { return this.execute('services', action, params); }
  async registry(action, params = {}) { return this.execute('registry', action, params); }
  async hardware(action, params = {}) { return this.execute('hardware', action, params); }
  async process(action, params = {}) { return this.execute('process', action, params); }
  async network(action, params = {}) { return this.execute('network', action, params); }
}

export const toolEngine = new ToolEngineSDK();
export default toolEngine;
