import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  discoverModels,
  normalizeDiscoveredModel,
  modelPreferencesRepository,
  validateModelPreferences,
  selectModelRoute,
} from '../src/services/modelRouter.js';

const models = [
  {
    id: 'qwen:latest',
    family: 'qwen2',
    size: 2e9,
    capabilities: ['completion'],
    contextWindow: 32768,
  },
  {
    id: 'qwen3.5:9b',
    family: 'qwen35',
    size: 6e9,
    capabilities: ['completion', 'tools', 'vision'],
    contextWindow: 262144,
  },
  {
    id: 'embed:latest',
    family: 'embed',
    size: 1e8,
    capabilities: ['embedding'],
    contextWindow: 2048,
  },
];
test('discovers actual local tags and capabilities without static whitelist', async () => {
  const found = await discoverModels({
    refresh: true,
    list: async () => [{ name: 'local-custom:4b', size: 23 }],
    show: async () => ({
      capabilities: ['completion'],
      model_info: { 'custom.context_length': 4096 },
    }),
  });
  assert.equal(found[0].id, 'local-custom:4b');
  assert.equal(found[0].contextWindow, 4096);
});
test('general and attachment requests use completion route without OS capability', () => {
  const route = selectModelRoute({ models, hasAttachments: true });
  assert.equal(route.route, 'general');
  assert.equal(route.model, 'qwen:latest');
  assert.equal(route.keepAlive, '30s');
});
test('Windows requires discovered native tools and compounds carry the General model', () => {
  const route = selectModelRoute({
    models,
    computerRequest: { requiresTools: true, compound: {} },
  });
  assert.equal(route.route, 'windows');
  assert.equal(route.model, 'qwen3.5:9b');
  assert.equal(route.generalModel, 'qwen:latest');
});
test('missing or incompatible route preference falls back only to eligible installed models', () => {
  const route = selectModelRoute({
    models,
    computerRequest: {},
    preferences: {
      windowsModel: 'qwen:latest',
      contextWindow: 4096,
      keepAlive: '0',
    },
  });
  assert.equal(route.model, 'qwen3.5:9b');
  assert.equal(route.fallback, true);
  assert.equal(route.options.num_ctx, 4096);
  assert.throws(
    () => selectModelRoute({ models: [models[0]], computerRequest: {} }),
    /No installed local model/,
  );
});
test('vision requests require declared vision capability', () => {
  assert.equal(selectModelRoute({ models, hasImages: true }).model, 'qwen3.5:9b');
  assert.throws(() => selectModelRoute({ models: [models[0]], hasImages: true }), /vision/);
});
test('unknown model capabilities are not inferred from name', () => {
  const unknown = normalizeDiscoveredModel({ name: 'qwen-unknown:latest' });
  assert.equal(unknown.capabilityVerified, false);
  assert.deepEqual(unknown.capabilities, []);
});
test('validates route capability and bounded context/lifecycle preferences', () => {
  assert.throws(() => validateModelPreferences({ windowsModel: 'qwen:latest' }, models), /tools/);
  assert.throws(
    () => validateModelPreferences({ contextWindow: 200000 }, models),
    /Context window/,
  );
  assert.throws(() => validateModelPreferences({ keepAlive: 'forever' }, models), /keep-alive/);
  assert.equal(
    validateModelPreferences({ generalModel: 'qwen:latest', windowsModel: 'qwen3.5:9b' }, models)
      .windowsModel,
    'qwen3.5:9b',
  );
});
test('user preferences are additive, persistent and isolated across accounts', () => {
  const database = new Database(':memory:');
  database.exec("CREATE TABLE users(id TEXT PRIMARY KEY); INSERT INTO users VALUES('a'),('b')");
  const repository = modelPreferencesRepository(database);
  repository.save('a', {
    generalModel: 'qwen:latest',
    windowsModel: 'qwen3.5:9b',
    keepAlive: '2m',
    contextWindow: 4096,
  });
  assert.equal(modelPreferencesRepository(database).get('a').keepAlive, '2m');
  assert.equal(repository.get('b').generalModel, '');
  database.close();
});
test('offline discovery rejects without inventing installed models', async () => {
  await assert.rejects(
    discoverModels({
      refresh: true,
      list: async () => {
        throw new Error('offline');
      },
    }),
    /offline/,
  );
});
