/** Validate before any request: a local service must never receive a remote URL or URL credentials. */
export function localServiceUrl(value, name = 'Service URL') {
  let url;
  try {
    url = new URL(value);
  } catch {
    /* handled below */
  }
  if (
    !url ||
    !['http:', 'https:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new Error(
      `${name} must be an HTTP(S) localhost origin without credentials, path, query or fragment.`,
    );
  }
  return url.origin;
}
