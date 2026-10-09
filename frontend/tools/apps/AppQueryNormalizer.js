// Names only: never use this transformation on a launch path.
export function normalizeAppName(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/\.exe$/u, '')
    .replace(/[^\p{L}\p{N}+#]+/gu, ' ')
    .trim();
}
export function validAppQuery(query) {
  return (
    typeof query === 'string' &&
    !!query.trim() &&
    query.length <= 200 &&
    !/[\\/:;|<>`$\x00-\x1f]/.test(query) &&
    !query.includes('&&')
  );
}
// "wifi settings", "settings for wifi", "wifi setting" -> "wifi". Used only against Settings pages (see AppResolverService).
export function settingsTopic(normalizedQuery) {
  const m = /^(?:settings? for (.+)|(.+?) settings?)$/u.exec(normalizedQuery);
  const topic = (m?.[1] || m?.[2] || '').trim();
  return topic && topic !== 'windows' ? topic : '';
}
