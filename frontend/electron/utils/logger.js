export const logger = {
  log: (...args) => console.log('[electron]', ...args),
  error: (...args) => console.error('[electron ERROR]', ...args),
  warn: (...args) => console.warn('[electron WARNING]', ...args)
};
