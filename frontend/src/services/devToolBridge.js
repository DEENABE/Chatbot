/**
 * Browser stand-in for the preload bridge (electron/preload.cjs).
 *
 * Active only under `npm run dev:tools` (Vite dev server + VITE_DEV_TOOL_HOST).
 * It defines window.toolEngine / window.softwareAPI / window.workspaceAPI with
 * the same method names and shapes the app already calls, forwarding to the
 * loopback dev tool host (frontend/dev-host). It deliberately does NOT define
 * window.electronAPI, so window-mode / wake-word / clipboard UI stays off.
 *
 * It never receives a path or command from this file's own logic: it only
 * relays what the app already sends over IPC in the exe.
 */
const DEV_HEADER = 'X-Chanakya-Dev-Tools';

// api.js touches `window` at import time, so it is loaded lazily (keeps this module testable in Node).
const sessionToken = async () => (await import('./api.js')).getToken();

export function createDevToolBridge(
  hostUrl,
  { fetchImpl = (...a) => fetch(...a), tokenSource = sessionToken } = {},
) {
  const base = hostUrl.replace(/\/$/, '');
  const listeners = { 'tool:progress': new Set(), 'tool:confirmation-required': new Set() };
  let stream = null;

  async function call(method, route, body) {
    const token = await tokenSource();
    if (!token)
      return {
        success: false,
        error: { code: 'AUTH_CONTEXT_REQUIRED', message: 'Sign in first.' },
      };
    let response;
    try {
      response = await fetchImpl(base + route, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          [DEV_HEADER]: '1',
          ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
        },
        body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
      });
    } catch {
      return {
        success: false,
        error: {
          code: 'TOOL_HOST_UNREACHABLE',
          message: 'The local tool host is not running. Start the app with `npm run dev:tools`.',
        },
      };
    }
    const result = await response.json().catch(() => ({
      success: false,
      error: { code: 'TOOL_HOST_ERROR', message: `Tool host returned HTTP ${response.status}.` },
    }));
    if (result && result.success === false && result.error)
      console.warn(`[dev-tools] ${route} failed: ${result.error.code} - ${result.error.message}`);
    return result;
  }

  // One long-lived NDJSON stream carries progress + confirmation pushes.
  function ensureStream() {
    if (stream) return;
    const controller = new AbortController();
    stream = controller;
    (async () => {
      let delay = 1000;
      while (!controller.signal.aborted) {
        try {
          const token = await tokenSource();
          if (token) {
            const response = await fetchImpl(`${base}/events`, {
              headers: { Authorization: `Bearer ${token}`, [DEV_HEADER]: '1' },
              signal: controller.signal,
            });
            if (response.ok && response.body) {
              delay = 1000;
              const reader = response.body.getReader();
              const decoder = new TextDecoder();
              let buffer = '';
              for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                for (const line of lines) {
                  if (!line.trim()) continue;
                  try {
                    const { channel, data } = JSON.parse(line);
                    listeners[channel]?.forEach((cb) => cb(data));
                  } catch {
                    /* ignore a malformed record */
                  }
                }
              }
            }
          }
        } catch {
          /* host restarting or signed out; retry below */
        }
        if (controller.signal.aborted) break;
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 15000);
      }
    })();
  }
  const subscribe = (channel) => (callback) => {
    listeners[channel].add(callback);
    ensureStream();
    return () => listeners[channel].delete(callback);
  };
  const unavailable = async (what) => ({
    success: false,
    cancelled: true,
    error: {
      code: 'NOT_AVAILABLE_IN_BROWSER',
      message: `${what} needs the desktop app window. Use the installed app for this.`,
    },
  });

  const toolEngine = {
    chooseOfflineInstaller: () => unavailable('Choosing an offline installer'),
    requestOfflineInstall: () => unavailable('Offline installation'),
    setAppPermission: (appId, level) => call('POST', '/tool/app-permission', { appId, level }),
    renewConfirmation: (confirmationId, renewalId) =>
      call('POST', '/tool/renew-confirmation', { confirmationId, renewalId }),
    execute: (tool, action, params, toolCallId, identity = {}) =>
      call('POST', '/tool/execute', {
        tool,
        action,
        params,
        toolCallId,
        requestId: identity.requestId,
        idempotencyKey: identity.idempotencyKey,
        routeGrant: identity.routeGrant,
      }),
    confirm: (confirmationId, identity = {}) =>
      call('POST', '/tool/approve', {
        params: { confirmationId },
        toolCallId: identity.toolCallId,
        requestId: identity.requestId,
        idempotencyKey: identity.idempotencyKey,
      }),
    chooseApp: (choiceId, candidateId, identity = {}) =>
      call('POST', '/tool/choose-app', {
        params: { choiceId, candidateId },
        toolCallId: identity.toolCallId,
        requestId: identity.requestId,
        idempotencyKey: identity.idempotencyKey,
      }),
    cancelAppChoice: (choiceId) =>
      call('POST', '/tool/execute', {
        tool: '_system',
        action: 'cancelAppChoice',
        params: { choiceId },
      }),
    cancelRequest: (requestId) => call('POST', '/tool/cancel-request', { requestId }),
    cancel: (confirmationId) =>
      call('POST', '/tool/execute', {
        tool: '_system',
        action: 'cancel',
        params: { confirmationId },
      }),
    getDesktopStatus: () => call('GET', '/tool/desktop-status'),
    getTools: () =>
      call('POST', '/tool/execute', { tool: '_system', action: 'getTools', params: {} }),
    onConfirmationRequired: subscribe('tool:confirmation-required'),
    onProgress: subscribe('tool:progress'),
  };

  const softwareAPI = {
    providers: () => call('POST', '/software/providers'),
    discover: (query, online = false) => call('POST', '/software/discover', { query, online }),
    resolve: (candidateId) => call('POST', '/software/resolve', { candidateId }),
    requestAction: (action, planId) => call('POST', '/software/action', { action, planId }),
    registerSource: (descriptor, credential) =>
      call('POST', '/software/register-source', { descriptor, credential }),
    removeSource: (registrationId) => call('POST', '/software/remove-source', { registrationId }),
    choose: (discoveryId, candidateId) =>
      call('POST', '/software/choose', { discoveryId, candidateId }),
    cancelChoice: (discoveryId) => call('POST', '/software/cancel-choice', { discoveryId }),
    pickInstaller: () => unavailable('Choosing an installer'),
    pickDirectory: () => unavailable('Choosing an installer folder'),
    reveal: () => unavailable('Revealing an installer'),
  };

  const workspaceAPI = {
    chooseDirectory: () => call('POST', '/workspace/choose-directory'),
  };

  return {
    toolEngine,
    softwareAPI,
    workspaceAPI,
    close: () => stream?.abort(),
  };
}

export function installDevToolBridge(hostUrl, target = window) {
  const bridge = createDevToolBridge(hostUrl);
  if (!target.toolEngine) target.toolEngine = bridge.toolEngine;
  if (!target.softwareAPI) target.softwareAPI = bridge.softwareAPI;
  if (!target.workspaceAPI) target.workspaceAPI = bridge.workspaceAPI;
  return bridge;
}
