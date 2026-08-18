const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Every id this app hands out (user id, session-derived userId, documentId,
 * chatId, ...) is a `crypto.randomUUID()` value — never client-chosen. Any
 * identity-shaped value that's about to be interpolated into a filesystem
 * path or a query string it wasn't parameterized for should be checked
 * against this shape first, rather than trusted as-is (RAG-04 in the
 * security audit: an unvalidated userId reached `path.join` directly).
 */
export function isValidUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}
