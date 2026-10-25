import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { classifyIntent, toTaskRoute } from '../src/services/intentRouter.js';
import { AGENT_PROFILES, agentProfile } from '../src/services/agentProfiles.js';
import {
  DEFAULT_MODEL_PREFERENCES,
  selectModelRoute,
  validateModelPreferences,
} from '../src/services/modelRouter.js';
import { describeAgents } from '../src/services/modelRegistry.js';

const m = (id, family, size, capabilities) => ({
  id,
  family,
  size,
  capabilities,
  capabilityVerified: true,
  contextWindow: 32768,
});
// What the person has today: a text-only Qwen and a tool-capable Qwen.
const TODAY = [
  m('qwen:latest', 'qwen2', 2e9, ['completion']),
  m('qwen3.5:9b', 'qwen35', 6e9, ['completion', 'tools', 'vision']),
  m('nomic-embed-text:latest', 'nomic-bert', 3e8, ['embedding']),
];
const CANDIDATES = [
  m('gemma-e2b:latest', 'gemma', 3e9, ['completion', 'vision']),
  m('embeddinggemma:300m', 'gemma', 3e8, ['embedding']),
  m('phi4-mini:3.8b', 'phi3', 2.5e9, ['completion', 'tools']),
  m('ministral-3:3b', 'mistral3', 3e9, ['completion', 'tools', 'vision']),
];
const ALL = [...TODAY, ...CANDIDATES];
const WINDOWS = { computerRequest: { requiresTools: true } };
const pick = (models, agentId, extra = {}) => selectModelRoute({ models, agentId, ...extra });

afterEach(() => {
  delete process.env.AGENT_MODEL_HINTS;
});

// ---- intent router ---------------------------------------------------------------------------------------------
test('every request gets exactly the agent family its admission allows: tools only when computerRequest says so', () => {
  const inputs = [
    { message: 'hello' },
    { message: 'my printer is not working' },
    { message: 'summarize this', hasAttachments: true },
    { message: 'what is in this picture', hasImages: true },
    { message: 'install vlc', computerRequest: { software: { name: 'vlc' } } },
    { message: 'open notepad', computerRequest: { requiresTools: true } },
    { message: 'click save', computerRequest: { requiresUI: true } },
    { message: 'fix my printer', computerRequest: { requiresTools: true } },
  ];
  for (const input of inputs) {
    const route = classifyIntent(input);
    assert.equal(route.requiresTools, !!input.computerRequest, input.message);
    const profile = agentProfile(route.agentId);
    assert.ok(profile, `${input.message} → unknown agent ${route.agentId}`);
    assert.ok(
      profile.routes.includes(input.computerRequest ? 'windows' : 'general'),
      `${input.message} → ${route.agentId} cannot run on that route`,
    );
  }
});
test('software, UI, OS and repair requests with tools go to their own agents', () => {
  const software = classifyIntent({ message: 'install 7zip', computerRequest: { software: {} } });
  assert.equal(software.agentId, 'software-install');
  assert.equal(software.requiresApproval, true);
  assert.deepEqual(software.requiredCapabilities, ['completion', 'tools']);
  assert.equal(
    classifyIntent({ message: 'type hello in word', computerRequest: { requiresUI: true } })
      .agentId,
    'app-automation',
  );
  assert.equal(
    classifyIntent({ message: 'ocr', computerRequest: { astra: {} } }).agentId,
    'app-automation',
  );
  assert.equal(
    classifyIntent({ message: 'open calculator', computerRequest: { requiresTools: true } })
      .agentId,
    'os-control',
  );
  assert.equal(
    classifyIntent({ message: 'fix my printer spooler', computerRequest: { requiresTools: true } })
      .agentId,
    'windows-repair',
  );
});
test("a settings change is not mistaken for a repair just because it says 'fix'", () => {
  const route = classifyIntent({
    message: 'fix the screen brightness',
    computerRequest: { requiresSettings: true },
  });
  assert.equal(route.agentId, 'os-control');
});
test('documents and images go to Document Intelligence; images also require vision', () => {
  const doc = classifyIntent({ message: 'summarize', hasAttachments: true });
  assert.equal(doc.agentId, 'document-intelligence');
  assert.deepEqual(doc.requiredCapabilities, ['completion']);
  const image = classifyIntent({ message: 'what is this', hasAttachments: true, hasImages: true });
  assert.equal(image.intent, 'image_understanding');
  assert.deepEqual(image.requiredCapabilities, ['completion', 'vision']);
  assert.equal(
    classifyIntent({ message: 'from my documents, who joined in 2020', wantsKnowledge: true })
      .agentId,
    'document-intelligence',
  );
});
test("a PC symptom without tools goes to Windows Repair; a coding question that says 'error' does not", () => {
  assert.equal(
    classifyIntent({ message: 'my wifi keeps disconnecting on my laptop' }).agentId,
    'windows-repair',
  );
  assert.equal(classifyIntent({ message: 'the printer is not working' }).requiresTools, false);
  assert.equal(
    classifyIntent({ message: 'What is error handling in JavaScript?' }).agentId,
    'general-chat',
  );
  assert.equal(
    classifyIntent({ message: 'my excel formula is not working' }).agentId,
    'general-chat',
  );
  assert.equal(
    classifyIntent({ message: 'how do I troubleshoot a memory leak in node' }).agentId,
    'general-chat',
  );
});
test('toTaskRoute carries the selected and fallback models', () => {
  const classification = classifyIntent({ message: 'hi' });
  const task = toTaskRoute(classification, { model: 'a', fallbackModel: 'b' });
  assert.deepEqual(Object.keys(task).sort(), [
    'agentId',
    'confidence',
    'fallbackModel',
    'intent',
    'requiredCapabilities',
    'requiresApproval',
    'requiresTools',
    'selectedModel',
  ]);
  assert.equal(task.selectedModel, 'a');
  assert.equal(task.fallbackModel, 'b');
});

// ---- model selection per agent ---------------------------------------------------------------------------------
test("with only today's models installed, every agent picks exactly what the old routes picked", () => {
  for (const profile of Object.values(AGENT_PROFILES)) {
    for (const route of profile.routes) {
      const extra = route === 'windows' ? WINDOWS : {};
      const before = selectModelRoute({ models: TODAY, ...extra });
      const after = pick(TODAY, profile.id, extra);
      assert.equal(after.model, before.model, `${profile.id} on ${route}`);
      assert.equal(after.route, before.route);
    }
  }
});
test('installed candidate families are chosen per agent, by declared capability', () => {
  assert.equal(pick(ALL, 'document-intelligence').model, 'gemma-e2b:latest');
  assert.equal(pick(ALL, 'windows-repair').model, 'phi4-mini:3.8b');
  assert.equal(pick(ALL, 'app-automation', WINDOWS).model, 'ministral-3:3b');
  assert.equal(pick(ALL, 'os-control', WINDOWS).model, 'qwen3.5:9b');
  assert.equal(pick(ALL, 'software-install', WINDOWS).model, 'qwen3.5:9b');
  assert.equal(pick(ALL, 'general-chat').model, 'qwen:latest');
  assert.equal(pick(ALL, 'document-intelligence').selection, 'auto-hint');
});
test('an embedding-only model is never picked for chat, even when its name matches the hint', () => {
  const route = pick([CANDIDATES[1], ...TODAY], 'document-intelligence');
  assert.notEqual(route.model, 'embeddinggemma:300m');
});
test('a name match without the declared capability does not make a model eligible', () => {
  const noTools = m('ministral-3:3b', 'mistral3', 3e9, ['completion']);
  const route = pick([noTools, ...TODAY], 'app-automation', WINDOWS);
  assert.equal(route.model, 'qwen3.5:9b');
  const phiNoTools = m('phi4-mini:3.8b', 'phi3', 2.5e9, ['completion']);
  assert.equal(pick([phiNoTools, ...TODAY], 'windows-repair', WINDOWS).model, 'qwen3.5:9b');
  assert.equal(
    pick([phiNoTools, ...TODAY], 'windows-repair').model,
    'phi4-mini:3.8b',
    'no tools needed on the general route',
  );
});
test('an unverified model (Ollama did not report capabilities) is not chosen by a hint', () => {
  const unknown = {
    ...CANDIDATES[0],
    capabilities: [],
    capabilityVerified: false,
    capabilitySource: 'unknown',
  };
  assert.equal(pick([unknown, ...TODAY], 'document-intelligence').model, 'qwen:latest');
});
test('an agent can never change the route or grant tools', () => {
  const general = pick(ALL, 'os-control');
  assert.equal(general.route, 'general');
  assert.equal(general.agentId, null, 'tool agent ignored on the tool-free route');
  assert.equal(general.model, selectModelRoute({ models: ALL }).model);
  const windows = pick(ALL, 'document-intelligence', WINDOWS);
  assert.equal(windows.route, 'windows');
  assert.equal(windows.agentId, null);
  assert.equal(pick(ALL, 'no-such-agent').model, selectModelRoute({ models: ALL }).model);
});
test('explicit choices win: agent pin, then the General / Windows model, then hints', () => {
  const generalPinned = pick(ALL, 'document-intelligence', {
    preferences: { ...DEFAULT_MODEL_PREFERENCES, generalModel: 'qwen:latest' },
  });
  assert.equal(generalPinned.model, 'qwen:latest');
  assert.equal(generalPinned.selection, 'pinned');
  const agentPinned = pick(ALL, 'document-intelligence', {
    preferences: {
      ...DEFAULT_MODEL_PREFERENCES,
      generalModel: 'qwen:latest',
      agentModels: { 'document-intelligence': 'phi4-mini:3.8b' },
    },
  });
  assert.equal(agentPinned.model, 'phi4-mini:3.8b');
  assert.equal(agentPinned.selection, 'pinned-agent');
  assert.equal(agentPinned.fallback, false);
});
test('a pinned model that vanished falls back safely and says so', () => {
  const route = pick(ALL, 'document-intelligence', {
    preferences: {
      ...DEFAULT_MODEL_PREFERENCES,
      agentModels: { 'document-intelligence': 'gone:1b' },
    },
  });
  assert.equal(route.fallback, true);
  assert.match(route.reason, /gone:1b is unavailable or incompatible/);
  assert.match(route.agentReason, /gone:1b/);
  assert.equal(route.model, 'gemma-e2b:latest');
});
test('the fallback model is another eligible model, or null when there is none', () => {
  const route = pick(ALL, 'app-automation', WINDOWS);
  assert.notEqual(route.fallbackModel, route.model);
  const eligible = ALL.filter((x) => x.capabilities.includes('tools')).map((x) => x.id);
  assert.ok(eligible.includes(route.fallbackModel));
  assert.equal(pick([TODAY[1]], 'os-control', WINDOWS).fallbackModel, null);
});
test('AGENT_MODEL_HINTS=off ranks exactly like the original routes', () => {
  process.env.AGENT_MODEL_HINTS = 'off';
  assert.equal(pick(ALL, 'document-intelligence').model, selectModelRoute({ models: ALL }).model);
  assert.equal(
    pick(ALL, 'app-automation', WINDOWS).model,
    selectModelRoute({ models: ALL, ...WINDOWS }).model,
  );
});
test('images still require a vision-capable model', () => {
  const noVision = [TODAY[0], CANDIDATES[2]];
  assert.throws(() => pick(noVision, 'document-intelligence', { hasImages: true }), /vision/);
  assert.equal(pick(ALL, 'document-intelligence', { hasImages: true }).model, 'gemma-e2b:latest');
});
test("no installed model at all still fails with the router's own clear error", () => {
  assert.throws(() => pick([], 'general-chat'), /No installed local model supports completion/);
});

// ---- preferences ------------------------------------------------------------------------------------------------
test('per-agent choices are validated against what is installed and declared', () => {
  const ok = validateModelPreferences(
    {
      ...DEFAULT_MODEL_PREFERENCES,
      agentModels: { 'app-automation': 'ministral-3:3b', 'document-intelligence': '' },
    },
    ALL,
  );
  assert.deepEqual(ok.agentModels, { 'app-automation': 'ministral-3:3b' });
  assert.throws(
    () =>
      validateModelPreferences(
        { ...DEFAULT_MODEL_PREFERENCES, agentModels: { 'app-automation': 'gemma-e2b:latest' } },
        ALL,
      ),
    /Application Automation requires an installed model with completion and tools/,
  );
  assert.throws(
    () =>
      validateModelPreferences(
        {
          ...DEFAULT_MODEL_PREFERENCES,
          agentModels: { 'document-intelligence': 'not-installed:1b' },
        },
        ALL,
      ),
    /requires an installed model/,
  );
  assert.throws(
    () =>
      validateModelPreferences(
        { ...DEFAULT_MODEL_PREFERENCES, agentModels: { 'made-up-agent': 'qwen:latest' } },
        ALL,
      ),
    /Invalid model settings/,
  );
  assert.throws(
    () =>
      validateModelPreferences({ ...DEFAULT_MODEL_PREFERENCES, agentModels: ['qwen:latest'] }, ALL),
    /Invalid model settings/,
  );
  assert.deepEqual(
    validateModelPreferences(
      { generalModel: '', windowsModel: '', keepAlive: '30s', contextWindow: 8192 },
      ALL,
    ).agentModels,
    {},
  );
});

// ---- what Settings shows ----------------------------------------------------------------------------------------
test('describeAgents reports the same model the router uses, and whether a recommended family is installed', () => {
  const today = describeAgents(DEFAULT_MODEL_PREFERENCES, TODAY);
  assert.equal(today.length, Object.keys(AGENT_PROFILES).length);
  const documents = today.find((agent) => agent.id === 'document-intelligence');
  assert.equal(documents.recommendedInstalled, false);
  assert.equal(documents.assignments[0].model, 'qwen:latest');
  assert.match(
    documents.assignments[0].reason,
    /no installed model matches the recommended family \(Gemma 4 E2B\)/,
  );
  const all = describeAgents(DEFAULT_MODEL_PREFERENCES, ALL);
  const repair = all.find((agent) => agent.id === 'windows-repair');
  assert.equal(repair.recommendedInstalled, true);
  assert.deepEqual(
    repair.assignments.map((a) => [a.route, a.model]),
    [
      ['general', 'phi4-mini:3.8b'],
      ['windows', 'phi4-mini:3.8b'],
    ],
  );
  for (const agent of all)
    for (const a of agent.assignments)
      assert.equal(
        a.model,
        pick(ALL, agent.id, a.route === 'windows' ? WINDOWS : {}).model,
        `${agent.id}/${a.route}`,
      );
});
test('describeAgents reports an error instead of throwing when nothing can serve an agent', () => {
  const agents = describeAgents(DEFAULT_MODEL_PREFERENCES, []);
  assert.ok(
    agents.every((agent) =>
      agent.assignments.every((a) => a.model === null && /No installed local model/.test(a.error)),
    ),
  );
});
test('profiles never name a concrete model tag', () => {
  for (const profile of Object.values(AGENT_PROFILES))
    for (const hint of profile.hints)
      assert.ok(
        /^[a-z]+$/.test(hint),
        `${profile.id}: ${hint} looks like a tag, not a family word`,
      );
});
