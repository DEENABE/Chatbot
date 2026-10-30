// Read-only status polling must respect server backoff without clearing models.
export function retryDelay(error, failures = 1, now = Date.now()) {
  const headers = error?.response?.headers;
  const value = headers?.get?.('retry-after') ?? headers?.['retry-after'];
  let delay = /^\d+(?:\.\d+)?$/.test(String(value || ''))
    ? Number(value) * 1000
    : Date.parse(value) - now;
  if (!Number.isFinite(delay) || delay <= 0)
    delay = Math.min(30000, 2000 * 2 ** Math.min(4, Math.max(0, failures - 1)));
  return Math.min(300000, Math.max(1000, delay));
}

export function isCodingModel(model) {
  return (
    model?.installed !== false &&
    model?.local !== false &&
    model?.capabilityVerified !== false &&
    Array.isArray(model?.capabilities) &&
    model?.capabilities?.includes('completion') &&
    model?.capabilities?.includes('tools')
  );
}

const CODER_TAG = /coder|codellama|starcoder|codestral|codegemma|devstral/i;

// Coding panel default: keep a still-installed choice, else the configured
// default (qwen2.5-coder:14b), else the largest installed coder model, else any.
export function preferredCodingModel(eligible, current, preferred) {
  const models = Array.isArray(eligible) ? eligible : [];
  const has = (tag) =>
    tag && models.find((item) => item.id === tag || item.id === `${tag}:latest`)?.id;
  const coders = models
    .filter((item) => CODER_TAG.test(`${item.id} ${item.family || ''}`))
    .sort((a, b) => (b.size || 0) - (a.size || 0));
  return has(current) || has(preferred) || coders[0]?.id || models[0]?.id || '';
}
