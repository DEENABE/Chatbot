export const memoryError = (message = 'Invalid memory input.', status = 400) =>
  Object.assign(new Error(message), { status });
export function text(value, max = 2000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw memoryError();
  return value.trim();
}
export function identifier(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9:._-]{1,240}$/.test(value))
    throw memoryError('Invalid memory reference.');
  return value;
}
export function fields(value, allowed) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !allowed.includes(k))
  )
    throw memoryError();
  return value;
}
// Fail closed on credential-labelled text and recognizable opaque credential forms.
const secret =
  /(?:password|passwd|passphrase|authorization|bearer|jwt|api[_ -]?key|api[_ -]?secret|access[_ -]?token|refresh[_ -]?token|session[_ -]?token|approval[_ -]?(?:token|id)|confirmation[_ -]?id|private[_ -]?key|encryption[_ -]?key|credential|tokenhash|passwordhash|tool_engine_session_secret)\b|-----BEGIN [\w ]*PRIVATE KEY-----|\beyJ[\w-]+\.[\w-]+\.[\w-]+\b|\b[a-f0-9]{48,}\b|\bsk-[a-z0-9_-]{20,}\b/i;
const injection =
  /<\/?(?:system|assistant|memory_context|tool)[^>]*>|ignore.{0,40}(?:instruction|previous)|(?:bypass|disable).{0,30}(?:approval|safety|security)|(?:approved|permission).{0,40}(?:execute|restart|repair|service)|(?:execute|run)\s+(?:powershell|cmd)|Start-Service|Invoke-Expression/i;
export const containsSecret = (value) =>
  secret.test(typeof value === 'string' ? value : JSON.stringify(value));
export const unsafeInstruction = (value) => injection.test(value);
export function safeText(value, max = 2000) {
  const v = text(value, max);
  if (containsSecret(v)) throw memoryError('Credentials and secrets cannot be saved as memory.');
  return v;
}
export function publicText(value, max = 1000) {
  if (typeof value !== 'string' || containsSecret(value)) return null;
  return value.slice(0, max);
}
export const encoded = (value) =>
  JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
  );
export const bytes = (value) =>
  Buffer.byteLength(typeof value === 'string' ? value : encoded(value), 'utf8');
