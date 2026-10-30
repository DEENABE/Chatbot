import { createHmac } from 'node:crypto';
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;

/** Per-launch authority binds a single server-routed proposal. The renderer never receives the signing key. */
export function signWindowsProposal(
  toolCall,
  userId,
  { secret = process.env.TOOL_ENGINE_SESSION_SECRET, now = Date.now() } = {},
) {
  if (!secret || secret.length < 32)
    throw new Error(
      'The authenticated desktop tool bridge is unavailable. No action was performed.',
    );
  const name = toolCall.function?.name || '',
    separator = name.indexOf('_');
  let params = toolCall.function?.arguments || {};
  if (typeof params === 'string') params = JSON.parse(params);
  const payload = {
    version: 1,
    route: 'windows',
    userId,
    toolCallId: toolCall.id,
    tool: name.slice(0, separator),
    action: name.slice(separator + 1),
    params,
    issuedAt: now,
    expiresAt: now + 10 * 60_000,
  };
  const data = Buffer.from(JSON.stringify(canonical(payload))).toString('base64url');
  const signature = createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${signature}`;
}
