export function redactDiagnostics(value, secrets = []) {
  let result = String(value);
  for (const secret of secrets)
    if (typeof secret === 'string' && secret.length >= 8)
      result = result.split(secret).join('[redacted]');
  return result
    .replace(/(Bearer\s+)[^\s"',;]+/gi, '$1[redacted]')
    .replace(
      /((?:password|token|secret|api[_-]?key|authorization)["']?\s*[=:]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi,
      '$1[redacted]',
    );
}
