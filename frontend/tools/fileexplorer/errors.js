/** Stable, structured errors. Codes are part of the tool contract; messages are for people. */
export const explorerError = (code, message, details) =>
  Object.assign(new Error(message || code), { code, ...(details ? { details } : {}) });

export const humanSize = (bytes) => {
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[unit]}`;
};

export const throwIfAborted = (signal) => {
  if (signal?.aborted) throw explorerError('CANCELLED', 'The operation was cancelled.');
};
