/**
 * Errors raised by the Document Intelligence Agent. `message` is always safe to
 * show to the user (no internal paths); `code` is stable for tests and the UI.
 */
export class DocIntelError extends Error {
  /**
   * @param {string} code e.g. UNSUPPORTED_FORMAT, CORRUPT_FILE, COLUMN_NOT_FOUND
   * @param {string} message user-facing text
   * @param {{status?: number, details?: object}} [options]
   */
  constructor(code, message, { status = 400, details } = {}) {
    super(message);
    this.name = 'DocIntelError';
    this.code = code;
    this.status = status;
    if (details) this.details = details;
  }
}

export const isDocIntelError = (error) => error instanceof DocIntelError;

/** Error → JSON body for the REST API. Unknown errors never leak their message. */
export function errorBody(error) {
  if (isDocIntelError(error))
    return {
      error: error.message,
      code: error.code,
      ...(error.details ? { details: error.details } : {}),
    };
  return { error: 'The document operation failed unexpectedly.', code: 'INTERNAL' };
}
