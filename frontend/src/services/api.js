import axios from 'axios';

const API_BASE = 'http://127.0.0.1:3001/api';

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

// Attach the session token to every request
api.interceptors.request.use(async (config) => {
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
  }
);

export async function streamChat(payload, { onToken, onSources, onDone, onToolCall, signal }) {
  const token = await getToken();
  const headers = { 'Content-Type': 'application/json' };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE}/chat`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal
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

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        throw new Error('The local server returned an incomplete stream. Restart the backend and try again.');
      }
      if (event.type === 'token') onToken(event.text);
      if (event.type === 'sources') onSources(event.sources);
      if (event.type === 'tool_call' && onToolCall) onToolCall(event.toolCall);
      if (event.type === 'done') onDone(event.message, event.conversationId);
      if (event.type === 'error') throw new Error(event.error);
    }
  }
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
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal
  });

  if (!response.ok) {
    const raw = await response.text();
    let detail = raw;
    try { detail = JSON.parse(raw).error; } catch { /* keep raw */ }
    throw new Error(detail || `Agent server returned HTTP ${response.status}.`);
  }
  if (!response.body) {
    throw new Error('Agent response body is empty');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      onEvent(event);
    }
  }
  if (buffer.trim()) {
    try { onEvent(JSON.parse(buffer)); } catch { /* ignore trailing */ }
  }
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
  resetPassword: (username, newPassword) =>
    api.post('/auth/reset-password', { username, newPassword })
};

// History API calls
export const history = {
  get: () => api.get('/history'),
  search: (q) => api.get(`/history/search?q=${encodeURIComponent(q)}`),
  delete: (id) => api.delete(`/history/${id}`),
  update: (id, updates) => api.patch(`/history/${id}`, updates),
  
  createFolder: (name) => api.post('/history/folders', { name }),
  updateFolder: (id, name) => api.patch(`/history/folders/${id}`, { name }),
  deleteFolder: (id) => api.delete(`/history/folders/${id}`)
};

// Documents API calls
export const documents = {
  get: () => api.get('/documents'),
  upload: (formData, onUploadProgress) =>
    api.post('/upload', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      onUploadProgress
    }),
  delete: (id) => api.delete(`/documents/${id}`)
};

// Models API
export const models = {
  get: () => api.get('/models'),
  loaded: () => api.get('/models/loaded'),
  unload: () => api.post('/models/unload')
};

// Memory API
export const memories = {
  get: (type) =>
    api.get(`/memory${type ? `?type=${type}` : ''}`),
  create: (content, type) =>
    api.post('/memory', { content, type }),
  delete: (id) => api.delete(`/memory/${id}`),
  clear: (type) =>
    api.delete(`/memory${type ? `?type=${type}` : ''}`)
};

// Transcribe API
export const transcribe = {
  audio: (formData) =>
    api.post('/transcribe', formData, {
      headers: { 'Content-Type': 'multipart/form-data' }
    })
};

// Stats API
export const stats = {
  get: () => api.get('/stats')
};

// Repair feedback / dataset API
export const repair = {
  feedback: (sessionId, worked, note = '') =>
    api.post('/repair/feedback', { sessionId, worked, note }),
  sessions: () => api.get('/repair/sessions'),
  dataset: () => api.get('/repair/dataset')
};
