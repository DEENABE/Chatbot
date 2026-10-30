import { createHmac, timingSafeEqual } from 'node:crypto';
import { parameterHash } from './ToolRequestValidator.js';

export function verifyWindowsProposal(grant, request, scope, { secret, now = Date.now() } = {}) {
  if (typeof grant !== 'string' || grant.length > 131072 || !secret) return null;
  const [data, supplied, extra] = grant.split('.');
  if (!data || !supplied || extra) return null;
  const signature = Buffer.from(supplied, 'base64url'),
    expected = createHmac('sha256', secret).update(data).digest();
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (
    payload.version !== 1 ||
    payload.route !== 'windows' ||
    !Number.isFinite(payload.issuedAt) ||
    !Number.isFinite(payload.expiresAt) ||
    payload.issuedAt > now ||
    payload.expiresAt <= now ||
    payload.expiresAt - payload.issuedAt > 600000
  )
    return null;
  const actor =
    /^renderer:(.+)-\d+$/.exec(scope || '')?.[1] || /^backend:(.+)$/.exec(scope || '')?.[1];
  if (
    payload.userId !== actor ||
    payload.toolCallId !== request.toolCallId ||
    payload.tool !== request.tool ||
    payload.action !== request.action ||
    parameterHash(payload.params) !== parameterHash(request.params || {})
  )
    return null;
  return {
    route: 'windows',
    userId: payload.userId,
    toolCallId: payload.toolCallId,
    expiresAt: payload.expiresAt,
  };
}
