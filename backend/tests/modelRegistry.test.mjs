// node --test tests/modelRegistry.test.mjs   (from backend/)
// Registry behaviour against a fake Ollama: no real model, no network, no database file.
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import {
  discoverModels,
  normalizeDiscoveredModel,
  resolveGeneralModel,
} from '../src/services/modelRouter.js';
import {
  buildSnapshot,
  describeAssignments,
  describeEmbedding,
  getModelRegistry,
  modelRoles,
  recordModelHealth,
  registryStore,
  safeMessage,
} from '../src/services/modelRegistry.js';
import { listLoadedModels } from '../src/services/ollamaService.js';
import { modelRuntime, routedModelOr } from '../src/services/modelRuntime.js';

const memoryStore = () => registryStore(new Database(':memory:'));
const tag = (name, digest, extra = {}) => ({ name, digest, size: 2e9, ...extra });
const declared = (...capabilities) => ({
  capabilities,
  details: { family: 'fam', parameter_size: '7B', quantization_level: 'Q4_K_M' },
  model_info: { 'fam.context_length': 8192 },
});

test('discovery keeps provenance: capabilities declared by Ollama are labelled, nothing is guessed from a name', async () => {
  const found = await discoverModels({
    refresh: true,
    list: async () => [tag('prov-a:1b', 'sha-a')],
    show: async () => declared('completion', 'tools'),
  });
  assert.equal(found[0].capabilitySource, 'ollama');
  assert.equal(found[0].digest, 'sha-a');
  const unknown = normalizeDiscoveredModel({ name: 'qwen-looks-capable:latest' });
  assert.equal(unknown.capabilitySource, 'unknown');
  assert.deepEqual(unknown.capabilities, []);
});

test('a failed /api/show keeps the model visible and reuses the earlier declaration only for the identical build', async () => {
  await discoverModels({
    refresh: true,
    list: async () => [tag('carry:7b', 'sha-1')],
    show: async () => declared('completion', 'tools'),
  });
  const failingShow = async () => {
    throw new Error('Ollama busy');
  };
  const same = await discoverModels({
    refresh: true,
    list: async () => [tag('carry:7b', 'sha-1')],
    show: failingShow,
  });
  assert.equal(same[0].capabilitySource, 'cached');
  assert.equal(same[0].capabilityVerified, true);
  assert.equal(same[0].showFailed, true);
  assert.deepEqual(same[0].capabilities, ['completion', 'tools']);
  // A different build of the same tag is a different model: nothing is carried over.
  const rebuilt = await discoverModels({
    refresh: true,
    list: async () => [tag('carry:7b', 'sha-2')],
    show: failingShow,
  });
  assert.equal(rebuilt.length, 1, 'the model must stay visible');
  assert.equal(rebuilt[0].capabilitySource, 'unknown');
  assert.equal(rebuilt[0].capabilityVerified, false);
  assert.deepEqual(rebuilt[0].capabilities, []);
  assert.equal(modelRoles(rebuilt[0]).tools, false, 'unknown models are never offered tool use');
});

test('a partial result is re-queried within seconds, a complete one stays cached for the normal period', async () => {
  const realNow = Date.now;
  let clock = 1_000_000;
  Date.now = () => clock;
  try {
    let showCalls = 0;
    let works = false;
    const list = async () => [tag('ttl-partial:1b', 'sha-p')];
    const show = async () => {
      showCalls++;
      if (!works) throw new Error('busy');
      return declared('completion');
    };
    await discoverModels({ refresh: true, list, show });
    clock += 1000;
    await discoverModels({ list, show });
    assert.equal(showCalls, 1, 'inside the short window the partial result is served');
    clock += 6000;
    works = true;
    const recovered = await discoverModels({ list, show });
    assert.equal(showCalls, 2, 'after the short window discovery asks again');
    assert.equal(recovered[0].capabilitySource, 'ollama');
    clock += 6000;
    await discoverModels({ list, show });
    assert.equal(showCalls, 2, 'a complete result keeps the normal 30 s cache');
  } finally {
    Date.now = realNow;
  }
});

test('roles: tool and vision use need declared capability; embedding models are not general models', () => {
  const embed = modelRoles({ capabilities: ['embedding'], capabilityVerified: true });
  assert.deepEqual(embed, { general: false, tools: false, vision: false, embedding: true });
  const agent = modelRoles({
    capabilities: ['completion', 'tools', 'vision'],
    capabilityVerified: true,
  });
  assert.deepEqual(agent, { general: true, tools: true, vision: true, embedding: false });
  assert.equal(
    modelRoles({ capabilities: ['completion', 'tools'], capabilityVerified: false }).tools,
    false,
  );
});

test('snapshot carries residency, health and first-seen time, and tracks models that disappear', () => {
  const models = [
    {
      id: 'a:1',
      size: 1,
      capabilities: ['completion'],
      capabilityVerified: true,
      capabilitySource: 'ollama',
      contextWindow: 4096,
    },
    {
      id: 'b:1',
      size: 2,
      capabilities: ['completion', 'tools'],
      capabilityVerified: true,
      capabilitySource: 'ollama',
      contextWindow: null,
    },
  ];
  const first = buildSnapshot({
    models,
    loaded: [{ name: 'a:1', expires_at: 'later', size: 5, size_vram: 0 }],
    now: 100,
  });
  assert.equal(first.models[0].residency.loaded, true);
  assert.equal(first.models[0].residency.vramBytes, 0);
  assert.equal(first.models[1].residency.loaded, false);
  assert.equal(first.models[1].provenance.contextWindow, 'unknown');
  first.models[1].health = { state: 'ready', lastLatencyMs: 900 };
  const second = buildSnapshot({ models: [models[1]], previous: first, now: 200 });
  assert.equal(second.models[0].firstSeenAt, 100);
  assert.equal(second.models[0].health.state, 'ready');
  assert.deepEqual(
    second.missing.map((item) => item.id),
    ['a:1'],
  );
  const third = buildSnapshot({ models, previous: second, now: 300 });
  assert.deepEqual(third.missing, [], 'a model that is installed again is no longer missing');
});

test('the snapshot persists and survives corrupt or foreign data', () => {
  const db = new Database(':memory:');
  const store = registryStore(db);
  assert.equal(store.get(), null);
  const snapshot = buildSnapshot({ models: [], now: 1 });
  store.save(snapshot);
  assert.equal(registryStore(db).get().schemaVersion, 1);
  db.prepare('UPDATE model_registry_snapshot SET snapshot = ?').run('{not json');
  assert.equal(store.get(), null);
  db.prepare('UPDATE model_registry_snapshot SET snapshot = ?').run(
    JSON.stringify({ schemaVersion: 99, models: [] }),
  );
  assert.equal(store.get(), null);
});

test('offline: the last snapshot is returned as stale, otherwise an empty list — never an invented one', async () => {
  const store = memoryStore();
  const online = await getModelRegistry({
    store,
    discover: async () => [
      {
        id: 'm:1',
        size: 1,
        capabilities: ['completion'],
        capabilityVerified: true,
        capabilitySource: 'ollama',
      },
    ],
    loadedModels: async () => [{ name: 'm:1' }],
  });
  assert.equal(online.stale, false);
  assert.equal(online.models[0].residency.loaded, true);
  const offline = await getModelRegistry({
    store,
    refresh: true,
    discover: async () => {
      throw new Error('Cannot reach Ollama at http://127.0.0.1:11434.\n    at fetch (stack line)');
    },
  });
  assert.equal(offline.stale, true);
  assert.equal(offline.ollama.connected, false);
  assert.ok(!offline.ollama.error.includes('\n'), 'no multi-line error text');
  assert.ok(!offline.ollama.error.includes('stack'));
  assert.deepEqual(
    offline.models.map((item) => item.id),
    ['m:1'],
  );
  assert.equal(
    offline.models[0].residency.loaded,
    false,
    'residency is unknown offline, not stale',
  );
  const cold = await getModelRegistry({
    store: memoryStore(),
    discover: async () => {
      throw new Error('offline');
    },
  });
  assert.deepEqual(cold.models, []);
  assert.equal(cold.stale, true);
});

test('a storage failure never breaks the registry', async () => {
  const brokenStore = {
    get() {
      throw new Error('disk');
    },
    save() {
      throw new Error('disk');
    },
  };
  const result = await getModelRegistry({
    store: brokenStore,
    discover: async () => [
      {
        id: 'm:2',
        size: 1,
        capabilities: ['completion'],
        capabilityVerified: true,
        capabilitySource: 'ollama',
      },
    ],
    loadedModels: async () => [],
  });
  assert.equal(result.models[0].id, 'm:2');
});

test('health: first failure degrades, second fails, success recovers; errors are one short line', () => {
  const store = memoryStore();
  store.save(
    buildSnapshot({
      models: [
        {
          id: 'h:1',
          size: 1,
          capabilities: ['completion'],
          capabilityVerified: true,
          capabilitySource: 'ollama',
        },
      ],
      now: 1,
    }),
  );
  const tick = () => 5;
  assert.equal(
    recordModelHealth({
      modelId: 'h:1',
      ok: false,
      error: new Error('boom\n  at x.js:1'),
      store,
      now: tick,
    }).state,
    'degraded',
  );
  const failed = recordModelHealth({ modelId: 'h:1', ok: false, error: 'again', store, now: tick });
  assert.equal(failed.state, 'failed');
  assert.equal(failed.lastError, 'again');
  const ready = recordModelHealth({ modelId: 'h:1', ok: true, latencyMs: 812.4, store, now: tick });
  assert.deepEqual(
    [ready.state, ready.lastLatencyMs, ready.consecutiveFailures],
    ['ready', 812, 0],
  );
  assert.equal(recordModelHealth({ modelId: 'nope', ok: true, store }), null);
  assert.equal(safeMessage(new Error('a\nb')), 'a');
});

test('assignments report auto / ready / missing / incompatible without changing anything', () => {
  const models = [
    { id: 'chat:1', capabilities: ['completion'], capabilityVerified: true },
    { id: 'agent:1', capabilities: ['completion', 'tools'], capabilityVerified: true },
    {
      id: 'agent:cached-unverified',
      capabilities: ['completion', 'tools'],
      capabilityVerified: false,
    },
  ];
  const report = describeAssignments({ generalModel: '', windowsModel: 'gone:1' }, models);
  assert.equal(report.generalModel.state, 'auto');
  assert.equal(report.windowsModel.state, 'missing');
  assert.equal(
    describeAssignments({ windowsModel: 'chat:1' }, models).windowsModel.state,
    'incompatible',
  );
  assert.equal(
    describeAssignments({ windowsModel: 'agent:cached-unverified' }, models).windowsModel.state,
    'incompatible',
  );
  assert.equal(
    describeAssignments({ generalModel: 'chat:1', windowsModel: 'agent:1' }, models).windowsModel
      .state,
    'ready',
  );
});

test('the registry only reads: discovery and residency use GET /api/tags, POST /api/show and GET /api/ps', async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    calls.push(`${options.method || 'GET'} ${path}`);
    const body = (value) =>
      new Response(JSON.stringify(value), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    if (path === '/api/tags') return body({ models: [tag('ro:1b', 'sha-ro')] });
    if (path === '/api/show') return body(declared('completion'));
    if (path === '/api/ps') return body({ models: [{ name: 'ro:1b' }] });
    return new Response('unexpected', { status: 500 });
  };
  try {
    const registry = await getModelRegistry({
      refresh: true,
      store: memoryStore(),
      discover: (options) => discoverModels(options),
      loadedModels: listLoadedModels,
    });
    assert.equal(registry.models[0].id, 'ro:1b');
    assert.ok(calls.length >= 3);
    const allowed = new Set(['GET /api/tags', 'POST /api/show', 'GET /api/ps']);
    for (const call of calls) assert.ok(allowed.has(call), `unexpected Ollama call: ${call}`);
    assert.ok(!calls.some((call) => /pull|delete|copy|create|push|generate|chat|embed/.test(call)));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('routedModelOr follows the routed model inside a request and the fallback outside', () => {
  assert.equal(routedModelOr('fixed:tag'), 'fixed:tag');
  modelRuntime.run({ model: 'routed:9b' }, () => {
    assert.equal(routedModelOr('fixed:tag'), 'routed:9b');
  });
  modelRuntime.run({}, () => assert.equal(routedModelOr('fixed:tag'), 'fixed:tag'));
});

const installedModels = [
  {
    id: 'small-chat:1b',
    size: 1e9,
    family: 'x',
    capabilities: ['completion'],
    contextWindow: 8192,
    capabilityVerified: true,
  },
  {
    id: 'big-chat:9b',
    size: 6e9,
    family: 'y',
    capabilities: ['completion', 'tools'],
    contextWindow: 8192,
    capabilityVerified: true,
  },
  {
    id: 'embed:latest',
    size: 1e8,
    family: 'bert',
    capabilities: ['embedding'],
    contextWindow: 2048,
    capabilityVerified: true,
  },
];
const discoverFake = (list) => async () => list;

test('background jobs: a pinned tag is used only if installed, otherwise the General route decides', async () => {
  const discover = discoverFake(installedModels);
  const hardware = {
    cpu: { parallelism: 8 },
    memory: {
      totalBytes: 64 * 1024 ** 3,
      freeBytes: 48 * 1024 ** 3,
      usableModelBytes: 40 * 1024 ** 3,
    },
    gpus: [],
    acceleration: { mode: 'cpu', verified: true },
    residency: [],
  };
  assert.equal(
    await resolveGeneralModel({ configured: 'big-chat:9b', discover, hardware }),
    'big-chat:9b',
  );
  assert.equal(
    await resolveGeneralModel({
      configured: 'big-chat',
      hardware,
      discover: discoverFake([{ ...installedModels[1], id: 'big-chat:latest' }]),
    }),
    'big-chat:latest',
  );
  // Pinned but not installed → an installed completion model, never the missing tag and never the embedding model.
  const chosen = await resolveGeneralModel({ configured: 'gone:7b', discover });
  assert.ok(['small-chat:1b', 'big-chat:9b'].includes(chosen));
  // An embedding model cannot be pinned as a text model.
  assert.notEqual(
    await resolveGeneralModel({ configured: 'embed:latest', discover }),
    'embed:latest',
  );
  // The signed-in user's saved General model wins when nothing is pinned.
  assert.equal(
    await resolveGeneralModel({
      userId: 'u',
      discover,
      hardware,
      preferencesFor: () => ({
        generalModel: 'big-chat:9b',
        windowsModel: '',
        keepAlive: '30s',
        contextWindow: 8192,
      }),
    }),
    'big-chat:9b',
  );
  // A broken preference store falls back to automatic selection instead of failing.
  assert.ok(
    await resolveGeneralModel({
      userId: 'u',
      discover,
      preferencesFor: () => {
        throw new Error('db');
      },
    }),
  );
  await assert.rejects(
    resolveGeneralModel({ discover: discoverFake([installedModels[2]]) }),
    /No installed local model/,
  );
  await assert.rejects(
    resolveGeneralModel({ discover: discoverFake([]) }),
    /No installed local model/,
  );
});

test('embedding readiness: ready / missing / unknown / incompatible, without changing anything', () => {
  assert.equal(describeEmbedding('embed', installedModels).state, 'ready');
  assert.equal(describeEmbedding('embed:latest', installedModels).state, 'ready');
  const missing = describeEmbedding('nomic-embed-text', [installedModels[0]]);
  assert.equal(missing.state, 'missing');
  assert.match(missing.message, /Chat is not affected/);
  assert.equal(describeEmbedding('small-chat:1b', installedModels).state, 'incompatible');
  assert.equal(
    describeEmbedding('embed', [
      { id: 'embed:latest', capabilities: [], capabilityVerified: false },
    ]).state,
    'unknown',
  );
});

test('config.js names no chat model and carries no model list', () => {
  const source = fs.readFileSync(new URL('../src/config.js', import.meta.url), 'utf8');
  assert.ok(!/supportedModels/.test(source), 'the static model list is gone');
  // Strip comments, then look for a quoted model tag of a known family.
  const code = source.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(
    !/["'`](?:qwen|llama|mistral|gemma|phi|deepseek|mixtral)[^"'`]*["'`]/i.test(code),
    'no quoted chat-model tag in config.js',
  );
});
