// The session token lives here, in main-process memory, for exactly as long
// as this process is alive — never written to disk (no electron-store, no
// file, nothing). Closing the app clears it, so reopening the app always
// requires a fresh login. This also keeps the raw token out of the
// renderer's localStorage, where any future XSS could read it directly and
// where it would otherwise survive as a permanent, on-disk artifact.
let currentToken = null;

export function getToken() {
  return currentToken;
}

export function setToken(token) {
  currentToken = token || null;
}

export function clearToken() {
  currentToken = null;
}
