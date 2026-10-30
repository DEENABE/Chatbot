import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getCachedHardwareProfile } from '../services/gpuProfile.js';
import { CodingModelAdapter, discoverCodingModels } from './CodingModelAdapter.js';
import { CodingToolEngine } from './CodingToolEngine.js';
import { WorkspaceFiles } from './WorkspaceFiles.js';
import { CODING_TOOLS, digest } from './contracts.js';

export const BENCHMARK_VERSION = 1;
const proposal = (tool, params) => ({ kind: 'tool', tool, params });
const fixtureHardware = getCachedHardwareProfile({
  totalMemory: 64 * 1024 ** 3,
  freeMemory: 32 * 1024 ** 3,
  adapters: [{ name: 'Benchmark GPU', vramMiB: 8192, memoryVerified: true }],
  env: {},
  residency: [],
});
const observedFile = (history, file) =>
  [...history].reverse().find((item) => item.tool === 'fs.read' && item.data?.path === file)?.data;
const fixtureCases = [
  {
    id: 'nested-multiple-files',
    difficulty: 'easy',
    goal: 'Create a nested source folder and connected addition module and test file. Inspect written files. Tests must be reported not run.',
    actions: [
      () => proposal('fs.mkdir', { path: 'src/math' }),
      () =>
        proposal('fs.write', {
          path: 'src/math/add.js',
          content: 'export const add = (a, b) => a + b;\n',
          expectedVersion: 'new',
        }),
      () =>
        proposal('fs.write', {
          path: 'src/math/add.test.js',
          content:
            "import assert from 'node:assert/strict';\nimport { add } from './add.js';\nassert.equal(add(2, 3), 5);\n",
          expectedVersion: 'new',
        }),
      () => proposal('fs.read', { path: 'src/math/add.js' }),
    ],
    verify: async (files) =>
      (await files.read({ path: 'src/math/add.js' })).content.includes('a + b') &&
      (await files.read({ path: 'src/math/add.test.js' })).content.includes("from './add.js'"),
  },
  {
    id: 'targeted-python-edit',
    difficulty: 'moderate',
    goal: 'Read the counter function, replace its decrement with increment using the observed version, and inspect the actual resulting text. Do not execute commands.',
    seed: { 'src/counter.py': 'def increment(value):\n    return value - 1\n' },
    actions: [
      () => proposal('fs.read', { path: 'src/counter.py' }),
      (history) =>
        proposal('fs.patch', {
          path: 'src/counter.py',
          search: 'return value - 1',
          replace: 'return value + 1',
          expectedVersion: observedFile(history, 'src/counter.py').version,
        }),
      () => proposal('fs.read', { path: 'src/counter.py' }),
    ],
    verify: async (files) =>
      (await files.read({ path: 'src/counter.py' })).content ===
      'def increment(value):\n    return value + 1\n',
  },
  {
    id: 'retrieve-edit-inspect',
    difficulty: 'complex',
    goal: 'Find the FIXME in the project without reading unrelated files, patch its exact constant, and inspect the resulting diff. Validation commands must remain not run.',
    seed: {
      'lib/example.txt': 'A source fixture with no target.\n',
      'lib/nested/limit.rs': 'pub const LIMIT: usize = 3; // FIXME benchmark\n',
    },
    actions: [
      () => proposal('code.search', { query: 'FIXME benchmark' }),
      () => proposal('fs.read', { path: 'lib/nested/limit.rs' }),
      (history) =>
        proposal('fs.patch', {
          path: 'lib/nested/limit.rs',
          search: 'LIMIT: usize = 3',
          replace: 'LIMIT: usize = 4',
          expectedVersion: observedFile(history, 'lib/nested/limit.rs').version,
        }),
      () => proposal('code.diff', { path: 'lib/nested/limit.rs' }),
    ],
    verify: async (files) =>
      (await files.read({ path: 'lib/nested/limit.rs' })).content.includes('LIMIT: usize = 4') &&
      files.diff({}).files.length === 1,
  },
];

function fixtureRepository() {
  const audits = [],
    approvals = new Map();
  return {
    audits,
    writeAllowed: () => true,
    audit: (_user, _workspace, _task, event) => audits.push(event),
    approval: (_user, _workspace, data) => {
      const id = randomUUID();
      approvals.set(id, data);
      return id;
    },
    takeApproval: (_user, _workspace, id) => {
      const data = approvals.get(id);
      if (!data) throw new Error('Fixture approval unavailable');
      approvals.delete(id);
      return data;
    },
  };
}

function fixtureModel(actions) {
  let index = 0;
  return new CodingModelAdapter({
    discover: async () => ({
      connected: true,
      models: [
        {
          id: 'fixture-local:1',
          local: true,
          capabilityVerified: true,
          capabilities: ['completion', 'tools'],
          contextWindow: 8192,
        },
      ],
    }),
    fetch: async (_, options) => {
      const request = JSON.parse(options.body);
      const history = JSON.parse(request.messages[1].content).observations;
      const next =
        index < actions.length
          ? actions[index++](history)
          : {
              kind: 'finish',
              summary: 'Fixture file operations completed. Build and tests were not run.',
            };
      return new Response(
        JSON.stringify({
          model: 'fixture-local:1',
          done: true,
          message: { content: JSON.stringify(next) },
        }),
      );
    },
    freeMemory: () => 16 * 1024 ** 3,
    hardwareProfile: () => fixtureHardware,
    maxOutputTokens: 256,
  });
}

async function disposableWorkspace() {
  const parent = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'chanakya-coding-benchmark-'));
  return {
    root,
    cleanup: async () => {
      const actual = await fs.realpath(root);
      const relative = path.relative(parent, actual);
      const stat = await fs.lstat(root);
      if (
        stat.isSymbolicLink() ||
        !stat.isDirectory() ||
        path.dirname(actual) !== parent ||
        path.isAbsolute(relative) ||
        !/^chanakya-coding-benchmark-[A-Za-z0-9]+$/.test(relative)
      )
        throw new Error('Unsafe benchmark cleanup target.');
      await fs.rm(actual, { recursive: true, force: true });
    },
  };
}

/** Deterministic model fixtures, actual guarded file/tool operations, and no project process execution. */
export async function runFixtureBenchmark({ guard, keepWorkspaces = false } = {}) {
  const results = [];
  for (const fixture of fixtureCases) {
    const disposable = await disposableWorkspace();
    const start = Date.now();
    const repository = fixtureRepository();
    const engine = new CodingToolEngine({ repository });
    const files = new WorkspaceFiles({ root: disposable.root, ...(guard ? { guard } : {}) });
    const binding = digest(disposable.root);
    const context = {
      root: disposable.root,
      binding,
      currentBinding: binding,
      userId: 'benchmark-fixture',
      workspaceId: randomUUID(),
      taskId: randomUUID(),
      files,
    };
    const history = [],
      calls = [];
    let status = 'failed',
      error = null;
    try {
      for (const [name, content] of Object.entries(fixture.seed || {})) {
        await fs.mkdir(path.dirname(path.join(disposable.root, name)), { recursive: true });
        await fs.writeFile(path.join(disposable.root, name), content, { flag: 'wx' });
      }
      const model = fixtureModel(fixture.actions);
      for (let iteration = 0; iteration < 12; iteration++) {
        const { proposal: next } = await model.next({
          model: 'fixture-local:1',
          task: fixture.goal,
          history,
          tools: CODING_TOOLS,
        });
        if (next.kind === 'finish') {
          status = (await fixture.verify(files)) ? 'passed' : 'failed';
          break;
        }
        if (['exec.run', 'tests.run', 'git.status', 'git.diff'].includes(next.tool))
          throw new Error('Fixture benchmarks never execute project processes.');
        const result = await engine.execute({ tool: next.tool, params: next.params }, context);
        calls.push({ tool: next.tool, success: result.success, code: result.error?.code || null });
        history.push({ tool: next.tool, ...result });
        if (!result.success) {
          error = result.error;
          status = result.error?.code === 'ISOLATION_UNAVAILABLE' ? 'blocked' : 'failed';
          break;
        }
      }
    } catch (failure) {
      error = { code: failure.code || 'BENCHMARK_ERROR', message: failure.message };
      status = failure.code === 'ISOLATION_UNAVAILABLE' ? 'blocked' : 'failed';
    }
    results.push({
      id: fixture.id,
      difficulty: fixture.difficulty,
      mode: 'fixture',
      status,
      error,
      durationMs: Date.now() - start,
      iterations: calls.length,
      toolCalls: calls,
      toolCallValidity: calls.length
        ? calls.filter((call) => call.code !== 'INVALID_TOOL_INPUT').length / calls.length
        : null,
      unauthorizedActionCount: calls.filter((call) =>
        ['TOOL_DENIED', 'WORKSPACE_PATH_DENIED', 'PROTECTED_FILE'].includes(call.code),
      ).length,
      build: 'not_run',
      tests: 'not_run',
      modelTokenUsage: null,
      rollback: 'not_run',
      ...(keepWorkspaces ? { workspace: disposable.root } : {}),
    });
    if (!keepWorkspaces) await disposable.cleanup();
  }
  return {
    suiteVersion: BENCHMARK_VERSION,
    mode: 'fixture',
    interpretation:
      'Deterministic proposals exercise actual guarded file tools; these are not live-model coding success scores.',
    cases: results,
    fileWorkflowPassRate:
      results.filter((result) => result.status === 'passed').length / results.length,
    buildSuccessRate: null,
    testPassRate: null,
    rollbackSuccessRate: null,
  };
}

/** Opt-in safe live protocol check. Only a read of a disposable README may execute. */
export async function runLiveReadBenchmark({ model, signal, timeoutMs = 240000 } = {}) {
  if (typeof model !== 'string' || !model)
    throw new Error('Live benchmark requires an explicitly selected installed --model tag.');
  const local = await discoverCodingModels({ signal });
  const selected = local.models.find((entry) => entry.id === model);
  if (!local.connected || !selected)
    throw new Error('The chosen model is not available as a compatible installed local model.');
  const disposable = await disposableWorkspace();
  try {
    await fs.writeFile(
      path.join(disposable.root, 'README.md'),
      '# Disposable offline protocol fixture\nExpected marker: CHANAKYA_LOCAL_READ_ONLY\n',
      { flag: 'wx' },
    );
    const start = Date.now();
    const adapter = new CodingModelAdapter({ timeoutMs, maxOutputTokens: 256 });
    const { proposal: next, metrics } = await adapter.next({
      model,
      task: 'Propose exactly fs.read with path README.md. This disposable protocol benchmark permits one READ action only. Do not finish, modify files, execute commands or request other paths. The orchestrator will inspect the actual returned content.',
      tools: CODING_TOOLS,
      history: [],
      signal,
    });
    const protocolValid =
      next.kind === 'tool' && next.tool === 'fs.read' && next.params.path === 'README.md';
    let observed = null;
    if (protocolValid)
      observed = await new WorkspaceFiles({ root: disposable.root, signal }).read(next.params);
    return {
      suiteVersion: BENCHMARK_VERSION,
      mode: 'live',
      model,
      digest: selected.digest || null,
      protocolValid,
      observedRead: observed?.content.includes('CHANAKYA_LOCAL_READ_ONLY') === true,
      proposal: { kind: next.kind, tool: next.tool || null, path: next.params?.path || null },
      durationMs: Date.now() - start,
      metrics,
      build: 'not_run',
      tests: 'not_run',
      taskCompletionRate: null,
      interpretation:
        'One real local schema proposal and an actual disposable file read. This does not measure project creation, debugging or build/test success.',
    };
  } finally {
    await disposable.cleanup();
  }
}

/** Opt-in HTTP cancellation check; no filesystem or tool is dispatched. */
export async function runLiveCancellationBenchmark({ model, abortAfterMs = 200 } = {}) {
  if (
    typeof model !== 'string' ||
    !model ||
    !Number.isInteger(abortAfterMs) ||
    abortAfterMs < 1 ||
    abortAfterMs > 1000
  )
    throw new Error(
      'Cancellation benchmark needs a selected local model and bounded abort interval.',
    );
  const controller = new AbortController();
  const start = Date.now();
  let inferenceStarted = false,
    timer;
  const adapter = new CodingModelAdapter({
    maxOutputTokens: 256,
    fetch: async (url, options) => {
      if (url.endsWith('/api/chat')) {
        inferenceStarted = true;
        timer = setTimeout(() => controller.abort(), abortAfterMs);
      }
      return fetch(url, options);
    },
  });
  try {
    await adapter.next({
      model,
      task: 'Propose one read of README.md. No actions have executed; this is a cancellation protocol fixture.',
      history: [],
      tools: CODING_TOOLS,
      signal: controller.signal,
    });
    return {
      suiteVersion: BENCHMARK_VERSION,
      mode: 'live-cancellation',
      model,
      inferenceStarted,
      cancellationObserved: false,
      durationMs: Date.now() - start,
      toolsDispatched: 0,
      interpretation:
        'Inference completed before cancellation; no cancellation success is claimed.',
    };
  } catch (error) {
    if (error.name !== 'AbortError') throw error;
    return {
      suiteVersion: BENCHMARK_VERSION,
      mode: 'live-cancellation',
      model,
      inferenceStarted,
      cancellationObserved: true,
      durationMs: Date.now() - start,
      toolsDispatched: 0,
      interpretation:
        'Actual loopback inference fetch aborted. This verifies HTTP cancellation, not project process-tree containment.',
    };
  } finally {
    clearTimeout(timer);
  }
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const args = process.argv.slice(2);
  if (
    args.some(
      (arg) =>
        !['--live', '--cancel-live', '--keep-workspaces'].includes(arg) &&
        !arg.startsWith('--model='),
    )
  )
    throw new Error(
      'Usage: node backend/src/coding/benchmark.js [--keep-workspaces] or --live|--cancel-live --model=installed-tag',
    );
  if (args.includes('--live') && args.includes('--cancel-live'))
    throw new Error('Choose one live benchmark at a time.');
  const output = args.includes('--cancel-live')
    ? await runLiveCancellationBenchmark({
        model: args.find((arg) => arg.startsWith('--model='))?.slice(8),
      })
    : args.includes('--live')
      ? await runLiveReadBenchmark({
          model: args.find((arg) => arg.startsWith('--model='))?.slice(8),
        })
      : await runFixtureBenchmark({ keepWorkspaces: args.includes('--keep-workspaces') });
  console.log(JSON.stringify(output, null, 2));
  if (output.mode === 'fixture' && output.cases.some((result) => result.status !== 'passed'))
    process.exitCode = 1;
  if (output.mode === 'live' && (!output.protocolValid || !output.observedRead))
    process.exitCode = 1;
  if (output.mode === 'live-cancellation' && !output.cancellationObserved) process.exitCode = 1;
}
