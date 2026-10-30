/**
 * @module dev-host/guard
 * @description Request admission for the localhost tool host.
 *
 * The packaged app trusts exactly one thing: its own BrowserWindow (see
 * electron/utils/ipcTrust.js). A browser tab has no such identity, so the dev
 * host replaces it with three independent checks that must ALL pass:
 *   1. Host header is a loopback name on this server's exact port
 *      (defeats DNS rebinding).
 *   2. Origin is on an explicit allow-list (the Vite dev origin). A missing
 *      Origin is refused: browsers always send one on cross-site POSTs, and
 *      the only legitimate caller is our own page.
 *   3. A custom header is present, which forces a CORS preflight for every
 *      request and so cannot be sent by a plain <form> or <img>.
 * The session token is checked separately against the backend (see server.js).
 */
import { timingSafeEqual } from 'node:crypto';

export const DEV_HEADER = 'x-chanakya-dev-tools';

export function defaultAllowedOrigins(vitePort = 5173) {
  return [`http://localhost:${vitePort}`, `http://127.0.0.1:${vitePort}`];
}

export function isLoopbackHostHeader(host, port) {
  if (typeof host !== 'string' || host.length > 100) return false;
  try {
    const url = new URL(`http://${host}`);
    return (
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
      Number(url.port) === Number(port) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === '/'
    );
  } catch {
    return false;
  }
}

export function isAllowedOrigin(origin, allowed) {
  return typeof origin === 'string' && allowed.includes(origin);
}

export function bearerToken(header) {
  if (typeof header !== 'string') return null;
  const match = /^Bearer ([A-Za-z0-9._~+/=-]{8,4096})$/.exec(header);
  return match ? match[1] : null;
}

/** Returns null when admitted, otherwise { status, error }. */
export function admit(request, { port, allowedOrigins }) {
  const h = request.headers;
  if (!isLoopbackHostHeader(h.host, port))
    return { status: 403, error: 'Host not allowed for the local tool host.' };
  if (!isAllowedOrigin(h.origin, allowedOrigins))
    return { status: 403, error: 'This browser origin is not allowed to use local tools.' };
  if (request.method !== 'OPTIONS' && h[DEV_HEADER] !== '1')
    return { status: 403, error: 'Dev tool header required.' };
  return null;
}

export function sameSecret(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
}
