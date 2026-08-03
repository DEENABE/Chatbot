/**
 * Strip boilerplate/noise from raw text pulled out of your source DB
 * before it gets chunked and embedded. Do this ONCE at ingest time,
 * not per-query.
 */
export function cleanText(raw) {
  if (!raw) return '';
  return raw
    .replace(/<[^>]+>/g, ' ')            // strip HTML tags
    .replace(/(Page \d+ of \d+)/gi, '')  // strip pagination junk
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')          // collapse repeated spaces/tabs
    .replace(/\n{3,}/g, '\n\n')          // collapse excessive blank lines
    .trim();
}
