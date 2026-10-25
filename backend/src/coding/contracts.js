import { createHash } from 'node:crypto';

export const fail = (code, message, status = 400) =>
  Object.assign(new Error(message), { code, status });
export const plain = (v) =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(v));
const canonical = (v) =>
  Array.isArray(v)
    ? v.map(canonical)
    : plain(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canonical(v[k])]),
        )
      : v;
export const digest = (v) =>
  createHash('sha256')
    .update(typeof v === 'string' ? v : JSON.stringify(canonical(v)))
    .digest('hex');
export function validate(schema, value, field = 'params') {
  if (schema.type === 'object') {
    if (!plain(value)) throw fail('INVALID_TOOL_INPUT', `${field} must be an object.`);
    if (
      Object.keys(value).some(
        (k) =>
          ['__proto__', 'prototype', 'constructor'].includes(k) ||
          !Object.hasOwn(schema.properties || {}, k),
      )
    )
      throw fail('INVALID_TOOL_INPUT', `${field} contains an unsupported field.`);
    for (const k of schema.required || [])
      if (!Object.hasOwn(value, k)) throw fail('INVALID_TOOL_INPUT', `${field}.${k} is required.`);
    for (const [k, v] of Object.entries(value)) validate(schema.properties[k], v, `${field}.${k}`);
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length > (schema.maxItems || 128))
      throw fail('INVALID_TOOL_INPUT', `${field} is not a bounded array.`);
    value.forEach((v, i) => validate(schema.items, v, `${field}.${i}`));
  } else if (schema.type === 'string') {
    if (
      typeof value !== 'string' ||
      value.length < (schema.minLength || 0) ||
      value.length > (schema.maxLength || 4096) ||
      value.includes('\0') ||
      (schema.pattern && !new RegExp(schema.pattern).test(value))
    )
      throw fail('INVALID_TOOL_INPUT', `${field} is invalid.`);
  } else if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') throw fail('INVALID_TOOL_INPUT', `${field} must be a boolean.`);
  } else if (schema.type === 'integer') {
    if (
      !Number.isSafeInteger(value) ||
      value < (schema.minimum ?? 0) ||
      value > (schema.maximum ?? Number.MAX_SAFE_INTEGER)
    )
      throw fail('INVALID_TOOL_INPUT', `${field} is out of range.`);
  } else throw fail('INVALID_TOOL_SCHEMA', 'Unsupported tool schema.', 500);
  if (schema.enum && !schema.enum.includes(value))
    throw fail('INVALID_TOOL_INPUT', `${field} is not an allowed value.`);
  return value;
}
const str = (maxLength = 4096) => ({ type: 'string', maxLength });
const object = (properties = {}, required = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const version = { type: 'string', pattern: '^(?:new|[a-f0-9]{64})$' };
const command = object(
  {
    executable: str(260),
    args: { type: 'array', items: str(), maxItems: 64 },
    cwd: str(),
    timeoutMs: { type: 'integer', minimum: 1000, maximum: 300000 },
  },
  ['executable', 'args'],
);
const specs = [
  [
    'workspace.open',
    'READ',
    'Inspect the task-bound authorized workspace. Cannot select another root.',
    object(),
  ],
  [
    'workspace.inspect',
    'READ',
    'Inspect project structure and locally declared validation commands.',
    object(),
  ],
  [
    'fs.list',
    'READ',
    'List bounded entries inside the authorized workspace.',
    object({ path: str() }),
  ],
  [
    'fs.read',
    'READ',
    'Read a bounded text file and its SHA-256 version. Protected credentials are denied.',
    object(
      {
        path: str(),
        startLine: { type: 'integer', minimum: 1, maximum: 1000000 },
        endLine: { type: 'integer', minimum: 1, maximum: 1000000 },
      },
      ['path'],
    ),
  ],
  [
    'fs.mkdir',
    'SAFE_WRITE',
    'Create a relative directory inside the authorized write workspace.',
    object({ path: str() }, ['path']),
  ],
  [
    'fs.write',
    'SAFE_WRITE',
    'Atomically create or update a text file using its observed version; new means create only.',
    object({ path: str(), content: str(262144), expectedVersion: version }, [
      'path',
      'content',
      'expectedVersion',
    ]),
  ],
  [
    'fs.patch',
    'SAFE_WRITE',
    'Preview or apply a unique exact text replacement, bound to the observed file version.',
    object(
      {
        path: str(),
        search: { ...str(131072), minLength: 1 },
        replace: str(262144),
        expectedVersion: version,
        preview: { type: 'boolean' },
      },
      ['path', 'search', 'replace', 'expectedVersion'],
    ),
  ],
  [
    'fs.delete',
    'DANGEROUS',
    'Delete one version-bound regular file after explicit approval; never recursively delete.',
    object({ path: str(), expectedVersion: version }, ['path', 'expectedVersion']),
  ],
  [
    'code.search',
    'READ',
    'Search text literally in bounded safe project files; no executable patterns.',
    object(
      {
        query: { ...str(1000), minLength: 1 },
        path: str(),
        maxResults: { type: 'integer', minimum: 1, maximum: 100 },
      },
      ['query'],
    ),
  ],
  [
    'code.symbols',
    'READ',
    'Inspect text-based symbol candidates; reports parser limitations.',
    object({ path: str() }, ['path']),
  ],
  [
    'code.diff',
    'READ',
    'Read actual changes relative to the task checkpoint.',
    object({ path: str() }),
  ],
  [
    'git.status',
    'READ',
    'Read Git status through a validated isolated command provider.',
    object(),
  ],
  ['git.diff', 'READ', 'Read Git diff through a validated isolated command provider.', object()],
  [
    'exec.run',
    'DANGEROUS',
    'Run an executable/argv with approval and OS workspace/network isolation. Fails closed without isolation.',
    command,
  ],
  [
    'tests.run',
    'DANGEROUS',
    'Run a locally available validation command; approval and OS isolation are required. Never installs dependencies.',
    command,
  ],
  [
    'checkpoint.create',
    'SAFE_WRITE',
    'Create a bounded project file snapshot in protected application storage.',
    object(),
  ],
  [
    'checkpoint.restore',
    'DANGEROUS',
    'Restore a reviewed checkpoint with conflict checks and explicit approval.',
    object({ checkpointId: str(100) }, ['checkpointId']),
  ],
  ['checkpoint.list', 'READ', 'List owned workspace file checkpoints.', object()],
];
export const CODING_TOOLS = Object.freeze(
  specs.map(([name, risk, description, inputSchema]) =>
    Object.freeze({
      name,
      risk,
      description,
      inputSchema,
      outputSchema: {
        type: 'object',
        required: ['success'],
        properties: {
          success: { type: 'boolean' },
          data: { type: 'object' },
          error: { type: 'object' },
        },
      },
      timeout: ['exec.run', 'tests.run'].includes(name) ? 300000 : 30000,
      allowedScopes: ['coding'],
    }),
  ),
);
export function validateCall(request) {
  if (!plain(request) || Object.keys(request).some((k) => !['tool', 'params'].includes(k)))
    throw fail('INVALID_TOOL_INPUT', 'Expected a typed coding tool and params.');
  const definition = CODING_TOOLS.find((t) => t.name === request.tool);
  if (!definition) throw fail('TOOL_DENIED', 'This tool is not registered for coding.', 403);
  validate(definition.inputSchema, request.params);
  return definition;
}
export function codingRisk(definition, params) {
  if (definition.name === 'fs.patch' && params.preview === true) return 'READ';
  if (
    ['fs.write', 'fs.patch'].includes(definition.name) &&
    /(?:^|[\\/])(?:package(?:-lock)?\.json|[^/\\]*lock[^/\\]*|[^/\\]*config[^/\\]*|\.gitignore|\.npmrc|[^/\\]*\.toml|[^/\\]*\.ya?ml)$/i.test(
      params.path || '',
    )
  )
    return 'DANGEROUS';
  return definition.risk;
}
