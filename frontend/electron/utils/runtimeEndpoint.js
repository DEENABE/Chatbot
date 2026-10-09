let apiBaseUrl = 'http://127.0.0.1:3001/api';

export function setBackendEndpoint(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Invalid local backend port.');
  apiBaseUrl = `http://127.0.0.1:${port}/api`;
  return apiBaseUrl;
}

export function getBackendApiBaseUrl() {
  return apiBaseUrl;
}
