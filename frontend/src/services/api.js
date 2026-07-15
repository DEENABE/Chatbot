import axios from 'axios';

const API_BASE = 'http://127.0.0.1:3001/api';

function getUserId() {
  try {
    const raw = localStorage.getItem('chanakya-user');
    if (!raw) return null;
    return JSON.parse(raw).id;
  } catch {
    return null;
  }
}

export const api = axios.create({ baseURL: API_BASE, timeout: 120000 });

// Attach userId header to every request
api.interceptors.request.use((config) => {
  const userId = getUserId();
  if (userId) {
    config.headers['x-user-id'] = userId;
  }
  return config;
});

export async function streamChat(payload, { onToken, onSources, onDone, onToolCall, signal }) {
  const userId = getUserId();
  const headers = { 'Content-Type': 'application/json' };
  if (userId) {
    headers['x-user-id'] = userId;
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
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
