import { InputValidator } from '../InputValidator.js';
import { createHash } from 'node:crypto';
import { sanitizeSoftwareQuery } from '../software/contracts.js';
export const plain = (v) =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(v));
export const canonical = (v) =>
  Array.isArray(v)
    ? v.map(canonical)
    : plain(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canonical(v[k])]),
        )
      : v;
export const parameterHash = (params) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(params)))
    .digest('hex');
export function validateRequest(request) {
  return (
    plain(request) &&
    Object.keys(request).every((k) =>
      [
        'tool',
        'action',
        'params',
        'toolCallId',
        'requestId',
        'idempotencyKey',
        'admission',
      ].includes(k),
    ) &&
    typeof request.tool === 'string' &&
    /^[A-Za-z_][A-Za-z0-9_]{0,79}$/.test(request.tool) &&
    typeof request.action === 'string' &&
    /^[A-Za-z][A-Za-z0-9]{0,79}$/.test(request.action)
  );
}
export function validateParameters(definition, params) {
  if (!plain(params) || !InputValidator.validate(definition.parameterSchema, params).valid)
    return false;
  // Existing schemas are retained; global bounds cover older permissive entries.
  for (const [key, value] of Object.entries(params)) {
    if (
      ['software.discover', 'software.discoverOnline'].includes(definition.name) &&
      key === 'query'
    ) {
      try {
        sanitizeSoftwareQuery(value);
      } catch {
        return false;
      }
      continue;
    }
    if (definition.name === 'app.openWithTarget' && key === 'target') {
      if (
        !plain(value) ||
        Object.values(value).some(
          (v) => typeof v !== 'string' || v.length > 4096 || v.includes('\0'),
        )
      )
        return false;
      continue;
    }
    if (value == null || (typeof value === 'object' && !Array.isArray(value))) return false;
    if (
      typeof value === 'string' &&
      (value.length > (key === 'content' ? 65536 : 4096) || value.includes('\0'))
    )
      return false;
    if (typeof value === 'number' && !Number.isFinite(value)) return false;
    if (
      Array.isArray(value) &&
      (value.length > 128 ||
        value.some(
          (x) =>
            (typeof x !== 'string' && !Number.isInteger(x)) ||
            (typeof x === 'string' && (x.length > 4096 || x.includes('\0'))),
        ))
    )
      return false;
  }
  const name = definition.name;
  if (
    name.startsWith('services.') &&
    params.name !== undefined &&
    !/^[A-Za-z0-9_.-]{1,128}$/.test(params.name)
  )
    return false;
  if (name.startsWith('network.')) {
    for (const key of ['host', 'hostname'])
      if (params[key] !== undefined && !/^[A-Za-z0-9.:%\[\]_-]{1,253}$/.test(params[key]))
        return false;
    for (const key of ['port', 'maxHops'])
      if (
        params[key] !== undefined &&
        (!Number.isInteger(params[key]) ||
          params[key] < 1 ||
          params[key] > (key === 'port' ? 65535 : 30))
      )
        return false;
    if (params.ports && params.ports.some((p) => !Number.isInteger(p) || p < 1 || p > 65535))
      return false;
  }
  if (
    name.startsWith('process.') &&
    params.name !== undefined &&
    !/^[A-Za-z0-9_.-]{1,128}$/.test(params.name)
  )
    return false;
  if (params.pid !== undefined && (!Number.isSafeInteger(params.pid) || params.pid < 1))
    return false;
  if (
    name.startsWith('registry.') &&
    Object.values(params).some((v) => typeof v !== 'string' || /[;&|`$\r\n]/.test(v))
  )
    return false;
  if (name.startsWith('file.')) {
    if (
      params.encoding !== undefined &&
      !['utf8', 'utf-8', 'ascii', 'base64', 'hex', 'utf16le'].includes(params.encoding)
    )
      return false;
    if (
      params.maxResults !== undefined &&
      (!Number.isInteger(params.maxResults) || params.maxResults < 1 || params.maxResults > 1000)
    )
      return false;
    if (params.pattern !== undefined && !/^[A-Za-z0-9 _.*?-]{1,128}$/.test(params.pattern))
      return false;
  }
  return true;
}
