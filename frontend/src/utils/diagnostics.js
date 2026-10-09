export function redactDiagnostics(value) {
  if (Array.isArray(value)) return value.slice(0, 100).map(redactDiagnostics);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, detail]) => [
        key,
        /password|passwd|secret|token|authorization|cookie|api.?key|credentials?/i.test(key)
          ? '[redacted]'
          : redactDiagnostics(detail),
      ]),
    );
  if (typeof value === 'string')
    return value
      .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [redacted]')
      .replace(
        /\b(password|passwd|token|secret|api[-_]?key)\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/gi,
        '$1=[redacted]',
      )
      .slice(0, 12000);
  return value;
}
