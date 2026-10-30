import axios from 'axios';
import { readNdjson } from './ndjson.js';

export const API_BASE =
  window.electronAPI?.getApiBaseUrl?.() ||
  (/^https?:$/.test(window.location.protocol) ? '/api' : 'http://127.0.0.1:3001/api');

// In-memory fallback for the non-Electron dev path (`npm run dev`, a plain
// Vite/browser tab with no preload script). Same "gone on reload" property
// as the real store, just scoped to this module instead of a separate
// process.
let devFallbackToken = null;

// The session token is held in the Electron main process (see
// electron/services/SessionStore.js), not in the renderer's localStorage:
// localStorage is readable by any script running in this page (a future
// XSS's first move), and it persists on disk across app restarts. Neither
// is true of a plain in-memory variable in a different OS process — closing
// the app clears it, and reaching it at all requires going through the
// narrow, explicit IPC bridge below rather than a blanket storage API.
export async function getToken() {
  if (window.sessionAPI) return window.sessionAPI.getToken();
  return devFallbackToken;
}

export async function setSession(token) {
  if (!token) return;
  if (window.sessionAPI) {
    await window.sessionAPI.setToken(token);
  } else {
    devFallbackToken = token;
  }
}

export async function clearSession() {
  if (window.sessionAPI) {
    await window.sessionAPI.clearToken();
  } else {
    devFallbackToken = null;
  }
}

export const api = axios.create({ baseURL: API_BASE, timeout: 120000 });
const apiClientKey = window.electronAPI?.getApiClientKey?.() || '';

// Attach the session token to every request
api.interceptors.request.use(async (config) => {
  if (apiClientKey) config.headers['X-Chanakya-Client'] = apiClientKey;
  const token = await getToken();
  if (token) {
    config.headers['Authorization'] = `Bearer ${token}`;
  }
  return config;
});

// A 401 here means the session is gone (expired, revoked by a password
// change elsewhere, or never existed) — no retry will fix that, so drop the
// stale session locally and let the app fall back to the login screen
// rather than leaving the UI stuck in a "logged in" state that 401s forever.
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (error?.response?.status === 401) {
      await clearSession();
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('chanakya:session-expired'));
      }
    }
    return Promise.reject(error);
  },
);

export async function streamChat(
  payload,
  { onToken, onSources, onDone, onToolCall, onMemory, onRoute, onSoftwareChoice, onStatus, signal },
) {
  const token = await getToken();
  const headers = { 'Content-Type': 'application/json' };
  if (apiClientKey) headers['X-Chanakya-Client'] = apiClientKey;
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE}/chat`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal,
  });

  if (!response.ok) {
    const raw = await response.text();
    let detail = raw;
    try {
      detail = JSON.parse(raw).error;
    } catch {
      // fallback
    }
    throw new Error(detail || `Chat server returned HTTP ${response.status}.`);
  }

  if (!response.body) {
    throw new Error('Chat response body is empty');
  }

  let finished = false;
  await readNdjson(
    response,
    (event) => {
      if (event.type === 'done') finished = true;
      if (event.type === 'token') onToken(event.text);
      if (event.type === 'sources') onSources(event.sources);
      if (event.type === 'memory') onMemory?.(event.decision);
      if (event.type === 'route') onRoute?.(event);
      if (event.type === 'software_choice') onSoftwareChoice?.(event);
      if (event.type === 'status') onStatus?.(event.text);
      if (event.type === 'tool_call' && onToolCall) onToolCall(event.toolCall);
      if (event.type === 'done') onDone(event.message, event.conversationId);
      if (event.type === 'error') throw new Error(event.error);
    },
    { signal },
  );
  // A stream that just stops (backend restarted, connection dropped) used to leave an empty bubble.
  if (!finished && !signal?.aborted)
    throw new Error('The response ended before the model finished. Please ask again.');
}

export async function streamRepair(payload, handlers) {
  return streamNdjson(`${API_BASE}/repair`, payload, handlers);
}

export async function streamAgent(payload, handlers) {
  return streamNdjson(`${API_BASE}/agent`, payload, handlers);
}

async function streamNdjson(url, payload, { onEvent, signal }) {
  const token = await getToken();
  const headers = { 'Content-Type': 'application/json' };
  if (apiClientKey) headers['X-Chanakya-Client'] = apiClientKey;
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal,
  });

  if (!response.ok) {
    const raw = await response.text();
    let detail = raw;
    try {
      detail = JSON.parse(raw).error;
    } catch {
      /* keep raw */
    }
    throw new Error(detail || `Agent server returned HTTP ${response.status}.`);
  }
  if (!response.body) {
    throw new Error('Agent response body is empty');
  }

  let finished = false;
  await readNdjson(
    response,
    (event) => {
      if (['final', 'error', 'aborted'].includes(event.type)) finished = true;
      onEvent(event);
    },
    { signal },
  );
  if (!finished)
    throw new Error(
      'The diagnostic stream ended before a final result. Check Diagnostics before retrying.',
    );
}

// Auth API calls
export const auth = {
  login: (credentials) => api.post('/auth/login', credentials),
  register: (userData) => api.post('/auth/register', userData),
  logout: () => api.post('/auth/logout'),
  me: () => api.get('/auth/me'),
  updateProfile: (profileData) => api.patch('/auth/profile', profileData),
  changePassword: (currentPassword, newPassword) =>
    api.post('/auth/change-password', { currentPassword, newPassword }),
  deleteAccount: (password) => api.delete('/auth/account', { data: { password } }),
  forgotPassword: (username) => api.post('/auth/forgot-password', { username }),
  resetPassword: (token, newPassword) => api.post('/auth/reset-password', { token, newPassword }),
};

// History API calls
export const history = {
  get: () => api.get('/history'),
  search: (q) => api.get(`/history/search?q=${encodeURIComponent(q)}`),
  delete: (id) => api.delete(`/history/${id}`),
  update: (id, updates) => api.patch(`/history/${id}`, updates),

  createFolder: (name) => api.post('/history/folders', { name }),
  updateFolder: (id, name) => api.patch(`/history/folders/${id}`, { name }),
  deleteFolder: (id) => api.delete(`/history/folders/${id}`),
};

// Documents API calls
export const documents = {
  get: (params) => api.get('/documents', { params }),
  upload: (formData, onUploadProgress, signal) =>
    // A folder can contain many documents, and each one is parsed and
    // embedded (via Ollama) synchronously before the response comes back.
    // If Ollama's model was idle-unloaded (see unloadIdleModel), the first
    // embedding call also pays a cold-load cost on top of that. The
    // instance-wide 120s timeout was getting hit even for a single small
    // docx whenever that cold-load happened, so uploads get a much longer
    // budget than every other request.
    api.post('/upload', formData, {
      onUploadProgress,
      signal,
      timeout: 600000,
    }),
  delete: (id) => api.delete(`/documents/${id}`),
};

// File agent: generated files (PDF, Word, Excel, CSV…) and folder organize plans.
export const fileAgent = {
  download: (id) =>
    api.get(`/file-agent/outputs/${encodeURIComponent(id)}`, { responseType: 'blob', timeout: 300000 }),
  plan: (id) => api.get(`/file-agent/plans/${encodeURIComponent(id)}`),
  apply: (id) => api.post(`/file-agent/plans/${encodeURIComponent(id)}/apply`, {}, { timeout: 300000 }),
  undo: (id) => api.post(`/file-agent/plans/${encodeURIComponent(id)}/undo`, {}, { timeout: 300000 }),
};

export const docintel = {
  capabilities: () => api.get('/docintel/capabilities'),
  inspect: (id) => api.get(`/docintel/documents/${encodeURIComponent(id)}`),
  result: (id, page = 1, pageSize = 100) =>
    api.get(`/docintel/results/${encodeURIComponent(id)}`, { params: { page, pageSize } }),
  job: (id) => api.get(`/docintel/jobs/${encodeURIComponent(id)}`),
  cancel: (id) => api.post(`/docintel/jobs/${encodeURIComponent(id)}/cancel`),
};

export const workspaces = {
  get: () => api.get('/workspaces'),
  create: (data) => api.post('/workspaces', data),
  update: (id, data) => api.patch(`/workspaces/${encodeURIComponent(id)}`, data),
  activate: (id) => api.post(`/workspaces/${encodeURIComponent(id)}/activate`),
  files: (id) => api.get(`/workspaces/${encodeURIComponent(id)}/files`),
  status: (id) => api.get(`/workspaces/${encodeURIComponent(id)}/status`),
  index: (id, data = {}) =>
    api.post(`/workspaces/${encodeURIComponent(id)}/index`, data, { timeout: 600000 }),
  pause: (id) => api.post(`/workspaces/${encodeURIComponent(id)}/pause`),
  removeIndex: (id) => api.delete(`/workspaces/${encodeURIComponent(id)}/index`),
  // Native Windows folder dialog opened by the local backend (browser/localhost mode).
  chooseDirectory: () => api.post('/workspaces/choose-directory', {}, { timeout: 310000 }),
};

// Coding operations stay in the authenticated local backend; renderer code
// never receives filesystem handles or a shell execution bridge.
export const coding = {
  createProject: (payload) => api.post('/coding/projects', payload),
  runtime: (workspaceId, signal) =>
    api.get(`/coding/workspaces/${encodeURIComponent(workspaceId)}/runtime`, { signal }),
  executionPolicy: (workspaceId, policy) =>
    api.post(`/coding/workspaces/${encodeURIComponent(workspaceId)}/execution-policy`, policy),
  stopProcess: (workspaceId, jobId) =>
    api.post(
      `/coding/workspaces/${encodeURIComponent(workspaceId)}/processes/${encodeURIComponent(jobId)}/stop`,
    ),
  openPreview: (workspaceId, jobId) =>
    api.post(
      `/coding/workspaces/${encodeURIComponent(workspaceId)}/processes/${encodeURIComponent(jobId)}/open`,
    ),
  models: (signal) => api.get('/coding/models', { signal }),
  tasks: (signal) => api.get('/coding/tasks', { signal }),
  tree: (workspaceId, signal) =>
    api.get(`/coding/workspaces/${encodeURIComponent(workspaceId)}/tree`, { signal }),
  file: (workspaceId, path, signal) =>
    api.get(`/coding/workspaces/${encodeURIComponent(workspaceId)}/file`, {
      params: { path },
      signal,
    }),
  authorize: (workspaceId, write = true) =>
    api.post(`/coding/workspaces/${encodeURIComponent(workspaceId)}/authorize`, { write }),
  start: (payload) => api.post('/coding/tasks', payload),
  task: (taskId, signal) => api.get(`/coding/tasks/${encodeURIComponent(taskId)}`, { signal }),
  approve: (taskId, approvalId, approved) =>
    api.post(`/coding/tasks/${encodeURIComponent(taskId)}/approval`, { approvalId, approved }),
  cancel: (taskId) => api.post(`/coding/tasks/${encodeURIComponent(taskId)}/cancel`),
  tool: (workspaceId, tool, params = {}) =>
    api.post(
      `/coding/workspaces/${encodeURIComponent(workspaceId)}/tools`,
      { tool, params },
      { timeout: 915000 },
    ),
  approveTool: (workspaceId, approvalId, approved) =>
    api.post(
      `/coding/workspaces/${encodeURIComponent(workspaceId)}/approvals/${encodeURIComponent(approvalId)}`,
      { approved },
      { timeout: 915000 },
    ),
};

// Models API
export const models = {
  get: () => api.get('/models'),
  loaded: () => api.get('/models/loaded'),
  unload: () => api.post('/models/unload'),
};

// Memory API
export const memories = {
  longTerm: () => api.get('/memory/long-term'),
  saveLongTerm: (value) => api.post('/memory/long-term', value),
  updateLongTerm: (id, value) => api.patch(`/memory/long-term/${encodeURIComponent(id)}`, value),
  deleteLongTerm: (id) => api.delete(`/memory/long-term/${encodeURIComponent(id)}`),
  get: (type) => api.get(`/memory${type ? `?type=${type}` : ''}`),
  create: (content, type) => api.post('/memory', { content, type }),
  delete: (id) => api.delete(`/memory/${id}`),
  clear: (type) => api.delete(`/memory${type ? `?type=${type}` : ''}`),
};

// Transcribe API
export const transcribe = {
  audio: (formData) =>
    api.post('/transcribe', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }),
};

// Stats API
export const stats = {
  get: () => api.get('/stats'),
};

// Translator API
export const translate = {
  // Longer than the default 120s instance timeout: a cold model load plus
  // generation for a longer text can take well over two minutes (see
  // backend config.js's translate.timeoutMs, now 180s) — this must be at
  // least that long, or the client would give up before the server does.
  text: ({ text, sourceLanguage, targetLanguage }) =>
    api.post('/translate', { text, sourceLanguage, targetLanguage }, { timeout: 200000 }),
};

// Repair feedback / dataset API
export const repair = {
  inspect: (id) => api.get(`/orchestrate/checkpoints/${encodeURIComponent(id)}`),
  resume: (id, body, signal) =>
    api.post(`/orchestrate/checkpoints/${encodeURIComponent(id)}/resume`, body, { signal }),
  renew: (id, body) =>
    api.post(`/orchestrate/checkpoints/${encodeURIComponent(id)}/confirmation/renew`, body),
  cancel: (id, requestId) =>
    api.post(`/orchestrate/checkpoints/${encodeURIComponent(id)}/cancel`, {
      requestId,
    }),
  feedback: (sessionId, worked, note = '') =>
    api.post('/repair/feedback', { sessionId, worked, note }),
  sessions: () => api.get('/repair/sessions'),
  dataset: () => api.get('/repair/dataset'),
};
