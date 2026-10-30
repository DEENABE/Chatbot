import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CodingModelAdapter,
  discoverCodingModels,
  validateCodingProposal,
  validateToolParameters,
  localOllamaUrl,
  codingInferenceLimits,
  parseRawCodingReply,
  observedFileVersion,
} from './CodingModelAdapter.js';
import { modelRuntime } from '../services/modelRuntime.js';
import { InferenceGate } from '../services/inferenceGate.js';
import { getCachedHardwareProfile } from '../services/gpuProfile.js';
import { CODING_TOOLS } from './contracts.js';
import { codingGuidance } from './CodingGuidance.js';

const testHardware = getCachedHardwareProfile({
  totalMemory: 64 * 1024 ** 3,
  freeMemory: 32 * 1024 ** 3,
  adapters: [{ name: 'Test GPU', vramMiB: 8192, memoryVerified: true }],
  env: {},
  residency: [],
});
const tools = [
  {
    name: 'fs.read',
    description: 'Read a relative workspace file.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { path: { type: 'string', minLength: 1, maxLength: 300 } },
      required: ['path'],
    },
  },
];
const installed = {
  id: 'local-coder:latest',
  local: true,
  capabilities: ['completion', 'tools'],
  capabilityVerified: true,
  contextWindow: 8192,
};
const discover = async () => ({ connected: true, models: [installed] });
const answer = (proposal, extra = {}) =>
  new Response(
    JSON.stringify({
      model: installed.id,
      done: true,
      message: { content: typeof proposal === 'string' ? proposal : JSON.stringify(proposal) },
      prompt_eval_count: 50,
      eval_count: 20,
      total_duration: 1000,
      ...extra,
    }),
    { status: 200 },
  );
const adapter = (options = {}) =>
  new CodingModelAdapter({
    discover,
    freeMemory: () => 16 * 1024 ** 3,
    hardwareProfile: () => testHardware,
    gate: new InferenceGate(),
    ...options,
  });
const request = (options = {}) => ({
  model: installed.id,
  task: 'Read the project README and inspect available test commands.',
  tools,
  ...options,
});

test('strict local endpoint policy rejects remote endpoints and ambiguous URLs', () => {
  for (const url of [
    'https://example.com',
    'http://127.0.0.1.example.com',
    'http://user:pass@localhost:11434',
    'http://localhost:11434/path',
    'http://localhost:11434/?key=secret',
    'file:///tmp/model',
  ])
    assert.throws(() => localOllamaUrl(url), { code: 'LOCAL_MODEL_ENDPOINT_REQUIRED' });
  assert.equal(localOllamaUrl('http://127.0.0.1:11434'), 'http://127.0.0.1:11434');
  assert.equal(localOllamaUrl('http://[::1]:11434'), 'http://[::1]:11434');
});

test('discovery offers only live installed local completion/tools models, without downloads', async () => {
  const requests = [];
  const result = await discoverCodingModels({
    discover: async () => [
      { ...installed, id: 'arbitrary-local:1' },
      { ...installed, id: 'remote-coder:1' },
      { ...installed, id: 'text-only:1' },
      { ...installed, id: 'missing-metadata:1' },
      { ...installed, id: 'some-cloud' },
    ],
    show: async (id) => {
      requests.push(id);
      if (id === 'missing-metadata:1') throw new Error('unavailable');
      return {
        capabilities: id === 'text-only:1' ? ['completion'] : ['completion', 'tools'],
        ...(id === 'remote-coder:1' ? { remote_host: 'https://cloud.example' } : {}),
        model_info: { 'family.context_length': 16384 },
      };
    },
  });
  assert.equal(result.connected, true);
  assert.deepEqual(
    result.models.map((model) => model.id),
    ['arbitrary-local:1'],
  );
  assert.equal(result.models[0].contextWindow, 16384);
  assert.equal(requests.includes('some-cloud'), false);
  const unavailable = await discoverCodingModels({
    discover: async () => {
      throw new Error('Ollama stopped');
    },
  });
  assert.equal(unavailable.connected, false);
  assert.deepEqual(unavailable.models, []);
});

test('default discovery uses only redirect-blocked local tags/show requests', async () => {
  const calls = [];
  const result = await discoverCodingModels({
    fetch: async (url, options) => {
      calls.push({ url, options });
      assert.equal(options.redirect, 'error');
      if (url.endsWith('/api/tags'))
        return new Response(
          JSON.stringify({ models: [{ name: 'unfamiliar:1', size: 100, details: {} }] }),
        );
      return new Response(
        JSON.stringify({
          capabilities: ['completion', 'tools'],
          model_info: { 'unknown.context_length': 8192 },
        }),
      );
    },
  });
  assert.equal(result.models[0].id, 'unfamiliar:1');
  assert.equal(calls.length, 2);
  assert.ok(calls.every(({ url }) => url.startsWith('http://127.0.0.1:11434/api/')));
});

test('proposal validation rejects executable names, extra authority, wrong params and prototype keys', () => {
  for (const value of [
    { kind: 'tool', tool: 'process.startProcess', params: { command: 'cmd.exe' } },
    { kind: 'tool', tool: 'fs.read', params: { path: 'README.md', approval: true } },
    { kind: 'tool', tool: 'fs.read', params: { path: 2 } },
    { kind: 'tool', tool: 'fs.read', params: { path: 'README.md' }, humanApproved: true },
    JSON.parse('{"kind":"tool","tool":"fs.read","params":{"path":"README.md","__proto__":{}}}'),
    { kind: 'finish', summary: 'done', tool: 'fs.read' },
    { kind: 'finish', summary: '' },
    { kind: 'batch', params: {} },
  ])
    assert.throws(() => validateCodingProposal(value, tools), { code: 'MODEL_PROPOSAL_INVALID' });
  assert.deepEqual(
    validateCodingProposal({ kind: 'tool', tool: 'fs.read', params: { path: 'README.md' } }, tools)
      .params,
    { path: 'README.md' },
  );
});

test('nested JSON schema validation enforces bounds and rejects unsupported schema keywords', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['edits'],
    properties: {
      edits: {
        type: 'array',
        minItems: 1,
        maxItems: 2,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            count: { type: 'integer', minimum: 1, maximum: 4 },
            text: { type: 'string', maxLength: 10 },
          },
          required: ['count', 'text'],
        },
      },
    },
  };
  assert.equal(validateToolParameters({ edits: [{ count: 2, text: 'safe' }] }, schema), true);
  assert.equal(validateToolParameters({ edits: [{ count: 5, text: 'safe' }] }, schema), false);
  assert.equal(
    validateToolParameters({ edits: [{ count: 2, text: 'safe', authority: true }] }, schema),
    false,
  );
  assert.equal(validateToolParameters('x', { type: 'string', $ref: '#/unsafe' }), false);
  assert.equal(validateToolParameters({}, { type: 'object', properties: {} }), true);
  assert.equal(validateToolParameters({ unknown: 1 }, { type: 'object', properties: {} }), false);
});

test('next returns a validated proposal through shared inference admission, never dispatching a tool', async () => {
  let count = 0;
  const model = adapter({
    fetch: async (url, options) => {
      count++;
      assert.equal(url, 'http://127.0.0.1:11434/api/chat');
      assert.equal(options.redirect, 'error');
      assert.equal(modelRuntime.getStore().route, 'coding');
      const body = JSON.parse(options.body);
      assert.equal(body.model, installed.id);
      assert.equal(body.stream, false);
      assert.equal(body.format.additionalProperties, false);
      assert.ok(body.options.num_ctx <= installed.contextWindow);
      assert.ok(body.options.num_predict <= 2048);
      return answer({
        kind: 'tool',
        tool: 'fs.read',
        params: { path: 'README.md' },
        plan: ['Inspect the project', 'Patch only affected files', 'Run approved verification'],
      });
    },
  });
  const result = await model.next(request());
  assert.equal(result.proposal.tool, 'fs.read');
  assert.equal(result.metrics.eval_count, 20);
  assert.equal(count, 1);
});

test('malformed proposals get at most two repairs and total usage includes repairs', async () => {
  const replies = [
    '```json invalid```',
    { kind: 'tool', tool: 'process.startProcess', params: {} },
    { kind: 'finish', summary: 'Inspection is complete; tests were not run.' },
  ];
  const model = adapter({ fetch: async () => answer(replies.shift()) });
  const result = await model.next(request());
  assert.equal(result.proposal.kind, 'finish');
  assert.equal(result.metrics.malformedRetries, 2);
  assert.equal(result.metrics.eval_count, 60);
  let attempts = 0;
  const invalid = adapter({
    fetch: async () => {
      attempts++;
      return answer('not JSON');
    },
  });
  await assert.rejects(invalid.next(request()), { code: 'MODEL_PROPOSAL_INVALID' });
  assert.equal(attempts, 3);
});

test('missing/incompatible/cloud models fail before inference; no auto pulls or fallback guesses', async () => {
  let calls = 0;
  const fetch = async () => {
    calls++;
    return answer({ kind: 'finish', summary: 'unsafe' });
  };
  for (const item of [
    null,
    { ...installed, remote: true },
    { ...installed, local: false },
    { ...installed, capabilities: ['completion'] },
    { ...installed, capabilityVerified: false },
  ]) {
    const model = adapter({
      fetch,
      discover: async () => ({ connected: true, models: item ? [item] : [] }),
    });
    await assert.rejects(model.next(request()), (error) =>
      ['CODING_MODEL_UNAVAILABLE', 'CODING_MODEL_INCOMPATIBLE'].includes(error.code),
    );
  }
  await assert.rejects(
    adapter({ fetch, discover: async () => ({ connected: false, models: [] }) }).next(request()),
    { code: 'OLLAMA_UNAVAILABLE' },
  );
  assert.equal(calls, 0);
});

test('resource/context and output bounds reject oversized tasks and omit old large history', async () => {
  assert.deepEqual(codingInferenceLimits(installed, 8192, 1 * 1024 ** 3), {
    contextWindow: 2048,
    outputTokens: 512,
  });
  assert.throws(() => codingInferenceLimits(installed, 100000), { code: 'CODING_CONTEXT_INVALID' });
  let prompt;
  const model = adapter({
    fetch: async (_, options) => {
      prompt = JSON.parse(options.body);
      return answer({ kind: 'finish', summary: 'No work executed.' });
    },
  });
  const result = await model.next(
    request({
      history: [{ output: 'x'.repeat(20000) }, { tool: 'fs.read', result: 'README inspected' }],
    }),
  );
  assert.equal(result.metrics.omittedHistory, 1);
  assert.ok(prompt.messages[1].content.includes('README inspected'));
  assert.ok(!prompt.messages[1].content.includes('x'.repeat(1000)));
  await assert.rejects(model.next(request({ task: 'x'.repeat(15000) })), {
    code: 'CODING_CONTEXT_TOO_LARGE',
  });
});

test('actual complete coding catalog fits the default 8192 context when resources permit', async () => {
  const model = adapter({
    fetch: async () => answer({ kind: 'tool', tool: 'workspace.inspect', params: {} }),
  });
  const result = await model.next(
    request({
      tools: CODING_TOOLS,
      history: [{ tool: 'workspace.inspect', success: true, data: { entries: [] } }],
    }),
  );
  assert.equal(result.metrics.contextWindow, 8192);
  assert.equal(result.proposal.tool, 'workspace.inspect');
});

test('timeout/cancellation interrupts inference without repair or claimed completion', async () => {
  const pending = async (_, { signal }) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  // Keep the test process alive while AbortSignal.timeout uses its unref timer.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(adapter({ fetch: pending, timeoutMs: 15 }).next(request()), {
      name: 'TimeoutError',
    });
    const controller = new AbortController();
    const result = adapter({ fetch: pending }).next(request({ signal: controller.signal }));
    controller.abort();
    await assert.rejects(result, { name: 'AbortError' });
  } finally {
    clearTimeout(keepAlive);
  }
});

test('complete execution catalog and Python guidance retain latest evidence at 4096 context', async () => {
  let prompt;
  const model = adapter({
    freeMemory: () => 5 * 1024 ** 3,
    // A deterministic constrained machine (4 GB GPU, 5 GB free RAM).
    hardwareProfile: (options = {}) =>
      getCachedHardwareProfile({
        totalMemory: 16 * 1024 ** 3,
        adapters: [{ name: 'Small GPU', vramMiB: 4096, memoryVerified: true }],
        env: {},
        residency: [],
        ...options,
      }),
    fetch: async (_, options) => {
      prompt = JSON.parse(options.body);
      return answer({
        kind: 'tool',
        tool: 'tests.run',
        params: { executable: 'python', args: ['-m', 'unittest', 'discover', '-s', 'src'] },
      });
    },
  });
  const result = await model.next(
    request({
      tools: CODING_TOOLS,
      task: 'Create a Python calculator app with arithmetic, errors and unit tests. Run syntax and unittest checks and finish after passing.',
      guidance: codingGuidance('Python calculator app'),
      history: [
        { changedFiles: [{ path: 'src/calculator.py', version: 'a'.repeat(64) }] },
        { validation: [{ kind: 'syntax', status: 'passed', exitCode: 0 }] },
      ],
    }),
  );
  assert.equal(result.metrics.contextWindow, 4096);
  assert.equal(result.metrics.omittedHistory, 0);
  assert.ok(prompt.messages[0].content.includes('deps.install'));
  assert.ok(prompt.messages[1].content.includes('src/calculator.py'));
});

test('response size and mismatched model identity fail closed', async () => {
  await assert.rejects(
    adapter({ fetch: async () => new Response('x'.repeat(1024 * 1024 + 1)) }).next(request()),
    { code: 'MODEL_RESPONSE_TOO_LARGE' },
  );
  await assert.rejects(
    adapter({
      fetch: async () => answer({ kind: 'finish', summary: 'no' }, { model: 'another-model' }),
    }).next(request()),
    { code: 'MODEL_RESPONSE_INVALID' },
  );
});

// ───────────── raw <write_file> blocks (no JSON escaping of file content) ─────────────
const sha = (c) => c.repeat(64);
const writeTools = CODING_TOOLS.filter((t) => ['fs.read', 'fs.write', 'fs.patch'].includes(t.name));

test('raw file block becomes a validated fs.write with exact content and no JSON grammar', async () => {
  let body;
  const source = 'def add(a, b):\n    return a + b  # "quotes" \\ backslash\n\nprint({"x": 1})\n';
  const model = adapter({
    fetch: async (_, options) => {
      body = JSON.parse(options.body);
      return answer(`Creating the module.\n<write_file path="./src\\calc.py">\n${source}</write_file>`);
    },
  });
  const result = await model.next(request({ tools: writeTools, task: 'Create a calculator module.' }));
  assert.equal(body.format, undefined);
  assert.ok(body.messages[0].content.includes('<write_file path='));
  assert.deepEqual(result.proposal, {
    kind: 'tool',
    tool: 'fs.write',
    params: { path: 'src/calc.py', content: source, expectedVersion: 'new' },
  });
});

test('raw mode raises the output budget above 2048 when the context has room', async () => {
  let body;
  const model = adapter({
    fetch: async (_, options) => {
      body = JSON.parse(options.body);
      return answer({ kind: 'tool', tool: 'fs.read', params: { path: 'a.py' } });
    },
  });
  const result = await model.next(request({ tools: writeTools }));
  assert.equal(result.metrics.contextWindow, 8192);
  assert.ok(result.metrics.outputTokens > 2048, `got ${result.metrics.outputTokens}`);
  assert.ok(result.metrics.outputTokens <= 4096);
  assert.equal(body.options.num_predict, result.metrics.outputTokens);
});

test('expectedVersion is filled only from server-observed versions', () => {
  const history = [
    { tool: 'fs.read', success: true, data: { path: 'src/a.py', version: sha('1') } },
    { tool: 'fs.read', success: true, data: { path: 'src/b.py', version: sha('2') } },
    { changedFiles: [{ path: 'src/a.py', version: sha('3') }, { path: 'old.py', deleted: true }] },
  ];
  assert.equal(observedFileVersion(history, 'src\\A.py'), sha('3'));
  assert.equal(observedFileVersion(history, './src/b.py'), sha('2'));
  assert.equal(observedFileVersion(history, 'old.py'), 'new');
  assert.equal(observedFileVersion(history, 'never-seen.py'), 'new');
  // a model-supplied valid version is kept, a malformed one is replaced
  const keep = parseRawCodingReply(
    JSON.stringify({ kind: 'tool', tool: 'fs.patch', params: { path: 'src/b.py', search: 'a', replace: 'b', expectedVersion: sha('9') } }),
    history,
  );
  assert.equal(keep.params.expectedVersion, sha('9'));
  const fixed = parseRawCodingReply(
    '{"tool":"fs.patch","params":{"path":"src/b.py","search":"a","replace":"b","expectedVersion":"abc"}}',
    history,
  );
  assert.equal(fixed.kind, 'tool');
  assert.equal(fixed.params.expectedVersion, sha('2'));
});

test('raw replies tolerate fences, commentary keys and raw newlines in JSON strings', () => {
  assert.deepEqual(
    parseRawCodingReply('```json\n{"kind":"tool","tool":"fs.read","params":{"path":"a.py"},"thought":"x"}\n```'),
    { kind: 'tool', tool: 'fs.read', params: { path: 'a.py' } },
  );
  const finish = parseRawCodingReply('Done.\n{"summary":"line one\nline two"}');
  assert.deepEqual(finish, { kind: 'finish', summary: 'line one\nline two' });
  const fenced = parseRawCodingReply('<write_file path="a.js">\n```js\nconsole.log(1)\n```\n</write_file>');
  assert.equal(fenced.params.content, 'console.log(1)\n');
  assert.throws(() => parseRawCodingReply('no action here'), { code: 'MODEL_PROPOSAL_INVALID' });
});

test('a cut-off file block is reported and retried with specific feedback, never written', async () => {
  const sent = [];
  let call = 0;
  const model = adapter({
    fetch: async (_, options) => {
      sent.push(JSON.parse(options.body).messages.at(-1).content);
      return answer(
        call++ === 0
          ? '<write_file path="big.py">\nprint(1)\nprint(2'
          : '<write_file path="small.py">\nprint(1)\n</write_file>',
      );
    },
  });
  const result = await model.next(request({ tools: writeTools }));
  assert.match(sent[1], /cut off before <\/write_file>/);
  assert.equal(result.proposal.params.path, 'small.py');
  assert.equal(result.metrics.malformedRetries, 1);
});

test('raw file blocks still pass full schema validation (fs.write must be in the catalog)', async () => {
  // fs.write not granted -> legacy JSON grammar, and a file block cannot smuggle a write in
  const readOnly = writeTools.filter((t) => t.name === 'fs.read');
  let body;
  const model = adapter({
    maxMalformedRetries: 0,
    fetch: async (_, options) => {
      body = JSON.parse(options.body);
      return answer('<write_file path="x.py">\nprint(1)\n</write_file>');
    },
  });
  await assert.rejects(model.next(request({ tools: readOnly })), { code: 'MODEL_PROPOSAL_INVALID' });
  assert.ok(body.format);
});

test('CODING_RAW_FILE_BLOCKS=0 restores the legacy JSON-only protocol', async () => {
  let body;
  const model = adapter({
    rawFileBlocks: false,
    fetch: async (_, options) => {
      body = JSON.parse(options.body);
      return answer({ kind: 'tool', tool: 'fs.read', params: { path: 'a.py' } });
    },
  });
  const result = await model.next(request({ tools: writeTools }));
  assert.ok(body.format);
  assert.ok(result.metrics.outputTokens <= 2048);
});

// --- Qwen2.5-Coder native tool-call shapes -------------------------------
import { normalizeCodingProposal as _norm, explainProposalProblem as _explain } from './CodingModelAdapter.js';
import { CODING_TOOLS as _TOOLS } from './contracts.js';

test('normalizes Qwen native {name, arguments} and <tool_call> replies', () => {
  const a = parseRawCodingReply('<tool_call>\n{"name": "deps.install", "arguments": {"manager": "npm"}}\n</tool_call>');
  assert.deepEqual(validateCodingProposal(_norm(a, _TOOLS), _TOOLS), {
    kind: 'tool', tool: 'deps.install', params: { manager: 'npm' },
  });
  const b = _norm({ function: { name: 'fs_list', arguments: '{"path":""}' } }, _TOOLS);
  assert.equal(validateCodingProposal(b, _TOOLS).tool, 'fs.list');
});

test('redirects exec.run npm install to deps.install and coerces params', () => {
  const p = _norm({ kind: 'tool', tool: 'exec.run', params: { command: 'npm install react react-dom --save' } }, _TOOLS);
  assert.deepEqual(p, { kind: 'tool', tool: 'deps.install', params: { manager: 'npm', packages: ['react', 'react-dom'] } });
  const q = _norm({ kind: 'tool', tool: 'deps.install', params: { manager: 'NPM', packages: 'vite tailwindcss', dev: true } }, _TOOLS);
  assert.deepEqual(q.params, { manager: 'npm', packages: ['vite', 'tailwindcss'] });
});

test('explains invalid proposals with schema-derived reasons only', () => {
  assert.match(_explain({ kind: 'tool', tool: 'npm.go', params: {} }, _TOOLS), /not available.*deps\.install/);
  assert.match(_explain({ kind: 'tool', tool: 'fs.read', params: {} }, _TOOLS), /missing: path/);
});
