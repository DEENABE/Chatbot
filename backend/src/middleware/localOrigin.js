import { timingSafeEqual } from 'node:crypto';
/** Browser origins must match the configured UI or this exact backend instance. */
export function isAllowedLocalOrigin(origin, { frontendOrigin, desktop = false, localPort }) {
  if (!origin) return true; // Native clients authenticate with bearer tokens.
  if (origin === 'null') return desktop;
  if (origin === frontendOrigin) return true;
  return ['http://127.0.0.1:', 'http://localhost:', 'http://[::1]:'].some(
    (base) => origin === base + localPort,
  );
}

export function isLoopbackHost(host) {
  try {
    const url = new URL(`http://${host}`);
    return (
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
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

/** Opaque file origins are shared with sandboxed web frames; Origin:null alone proves no authority. */
export function hasDesktopClientKey(supplied, expected) {
  return (
    typeof supplied === 'string' &&
    typeof expected === 'string' &&
    /^[a-f0-9]{64}$/.test(supplied) &&
    /^[a-f0-9]{64}$/.test(expected) &&
    timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
  );
}
