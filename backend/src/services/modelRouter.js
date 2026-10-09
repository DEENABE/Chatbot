import os from 'node:os';
import { listInstalledModels, showModel } from './ollamaService.js';
import { getDb } from '../db/connection.js';
import { agentProfile, hintRank } from './agentProfiles.js';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const TAG = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
export const DEFAULT_MODEL_PREFERENCES = Object.freeze({
  generalModel: '',
  windowsModel: '',
  keepAlive: '30s',
  contextWindow: 8192,
  // Explicit per-agent choices ({ "document-intelligence": "some-tag", ... }). Empty = decided automatically.
  agentModels: Object.freeze({}),
});

const plainAgentModels = (value) =>
  Object.fromEntries(
    Object.entries(value && typeof value === 'object' && !Array.isArray(value) ? value : {}).filter(
      ([, tag]) => typeof tag === 'string' && tag,
    ),
  );
let cached, pending;
const KEEP_ALIVE = new Set(['0', '30s', '2m', '5m', '10m']);

export function normalizeDiscoveredModel(item, detail = {}) {
  const capabilities = Array.isArray(detail.capabilities)
    ? detail.capabilities
    : item.capabilities || [];
  const info = detail.model_info || {};
  const context =
    Object.entries(info).find(([key]) => key.endsWith('.context_length'))?.[1] ||
    item.details?.context_length;
  return {
    id: item.name,
    label: item.name,
    installed: true,
    family: detail.details?.family || item.details?.family || 'unknown',
    size: item.size || 0,
    parameterSize: detail.details?.parameter_size || item.details?.parameter_size || 'unknown',
    quantization:
      detail.details?.quantization_level || item.details?.quantization_level || 'unknown',
    capabilities: capabilities.filter((value) => typeof value === 'string'),
    contextWindow: Number.isSafeInteger(context) ? context : null,
    capabilityVerified: Array.isArray(detail.capabilities) || Array.isArray(item.capabilities),
    // Where the capability list came from: "ollama" (declared by /api/show now), "cached" (declared earlier for
    // the identical build, see discoverModels) or "unknown". Never inferred from a model name.
    capabilitySource:
      Array.isArray(detail.capabilities) || Array.isArray(item.capabilities) ? 'ollama' : 'unknown',
    digest: typeof item.digest === 'string' ? item.digest : null,
    modifiedAt: typeof item.modified_at === 'string' ? item.modified_at : null,
  };
}

const CACHE_TTL_MS = 30_000;
// A failed /api/show (Ollama busy loading a model, 8 s timeout) must not hide an installed model for a full
// cache period, so a partial result is re-queried soon.
const PARTIAL_CACHE_TTL_MS = 5_000;
// Last successful /api/show result per model id. Used only when the digest of the installed build is unchanged.
const lastVerified = new Map();

/** Seed the "same build, verified earlier" memory, e.g. from the persisted registry snapshot after a restart. */
export function rememberVerifiedModels(models = []) {
  for (const model of Array.isArray(models) ? models : [])
    if (
      model?.id &&
      model.digest &&
      model.capabilityVerified === true &&
      model.capabilitySource === 'ollama' &&
      Array.isArray(model.capabilities)
    )
      lastVerified.set(model.id, model);
}

/**
 * Discovery never pulls a model or triggers inference. A short cache prevents repeated metadata requests.
 * If /api/show fails for a model whose installed build (digest) is the one verified earlier, that earlier,
 * Ollama-declared capability list is reused and labelled "cached"; otherwise the model stays visible with unknown
 * capabilities (never guessed from its name) and the next call retries soon.
 */
export async function discoverModels({
  refresh = false,
  list = listInstalledModels,
  show = showModel,
} = {}) {
  if (!refresh && cached && Date.now() - cached.at < cached.ttl) return cached.models;
  if (pending && !refresh) return pending;
  const task = (async () => {
    const installed = await list();
    const models = [];
    let partial = false;
    // Bound discovery work and parallelism. No prompt/model metadata is sent to the UI.
    for (let index = 0; index < installed.length; index += 3) {
      const batch = await Promise.all(
        installed.slice(index, index + 3).map(async (item) => {
          if (!TAG.test(item.name || '')) return null;
          let detail = null;
          try {
            detail = await show(item.name);
          } catch {
            detail = null;
          }
          if (detail && typeof detail === 'object') return normalizeDiscoveredModel(item, detail);
          const fresh = normalizeDiscoveredModel(item, {});
          const earlier = lastVerified.get(fresh.id);
          if (earlier && fresh.digest && earlier.digest === fresh.digest)
            return {
              ...fresh,
              family: earlier.family,
              parameterSize: earlier.parameterSize,
              quantization: earlier.quantization,
              capabilities: [...earlier.capabilities],
              contextWindow: earlier.contextWindow ?? null,
              capabilityVerified: true,
              capabilitySource: 'cached',
              showFailed: true,
            };
          partial = true;
          return { ...fresh, showFailed: true };
        }),
      );
      models.push(...batch.filter(Boolean));
    }
    for (const model of models)
      if (model.capabilityVerified && model.capabilitySource === 'ollama')
        lastVerified.set(model.id, model);
    cached = {
      at: Date.now(),
      models,
      ttl: partial ? PARTIAL_CACHE_TTL_MS : CACHE_TTL_MS,
    };
    return models;
  })();
  pending = task;
  try {
    return await task;
  } finally {
    if (pending === task) pending = null;
  }
}

export function modelPreferencesRepository(db = getDb()) {
  db.exec(
    `CREATE TABLE IF NOT EXISTS model_preferences (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, preferences TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
  );
  return {
    get(userId) {
      const row = db
        .prepare('SELECT preferences FROM model_preferences WHERE user_id=?')
        .get(userId);
      try {
        const merged = {
          ...DEFAULT_MODEL_PREFERENCES,
          ...JSON.parse(row?.preferences || '{}'),
        };
        return { ...merged, agentModels: plainAgentModels(merged.agentModels) };
      } catch {
        return { ...DEFAULT_MODEL_PREFERENCES, agentModels: {} };
      }
    },
    save(userId, preferences) {
      db.prepare(
        'INSERT INTO model_preferences(user_id,preferences,updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET preferences=excluded.preferences,updated_at=excluded.updated_at',
      ).run(userId, JSON.stringify(preferences), Date.now());
      return preferences;
    },
  };
}

export function validateModelPreferences(value, models) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !Object.hasOwn(DEFAULT_MODEL_PREFERENCES, key))
  )
    throw fail('Invalid model settings.');
  const preferences = { ...DEFAULT_MODEL_PREFERENCES, ...value };
  if (!KEEP_ALIVE.has(preferences.keepAlive))
    throw fail('Choose a supported model keep-alive duration.');
  if (
    !Number.isSafeInteger(preferences.contextWindow) ||
    preferences.contextWindow < 2048 ||
    preferences.contextWindow > 32768
  )
    throw fail('Context window must be between 2048 and 32768 tokens.');
  for (const [key, capability] of [
    ['generalModel', 'completion'],
    ['windowsModel', 'tools'],
  ]) {
    if (preferences[key] === '') continue;
    const selected = models.find((item) => item.id === preferences[key]);
    if (
      !selected?.capabilities.includes('completion') ||
      !selected.capabilities.includes(capability)
    )
      throw fail(
        `${key === 'windowsModel' ? 'Windows Agent' : 'General'} requires an installed model with ${capability} capability.`,
      );
  }
  const rawAgentModels = value.agentModels ?? {};
  if (!rawAgentModels || typeof rawAgentModels !== 'object' || Array.isArray(rawAgentModels))
    throw fail('Invalid model settings.');
  const agentModels = {};
  for (const [agentId, tag] of Object.entries(rawAgentModels)) {
    const profile = agentProfile(agentId);
    if (!profile || (tag !== '' && tag != null && typeof tag !== 'string'))
      throw fail('Invalid model settings.');
    if (!tag) continue;
    // An agent that can also run without tools only needs a text model here; selection skips the pin on a tools route
    // if the model cannot call tools.
    const needs = profile.routes.includes('general') ? ['completion'] : profile.requires;
    const selected = models.find((item) => item.id === tag);
    if (!selected || !needs.every((cap) => selected.capabilities.includes(cap)))
      throw fail(
        `${profile.label} requires an installed model with ${needs.join(' and ')} capability.`,
      );
    agentModels[agentId] = tag;
  }
  preferences.agentModels = agentModels;
  return preferences;
}

const order = (a, b) => (a === b ? 0 : a < b ? -1 : 1);

export function selectModelRoute({
  models,
  preferences = DEFAULT_MODEL_PREFERENCES,
  computerRequest,
  hasAttachments = false,
  hasImages = false,
  requestedModel,
  agentId,
  totalMemory = os.totalmem(),
  freeMemory = os.freemem(),
}) {
  const route = computerRequest ? 'windows' : 'general';
  // An agent can refine WHICH model runs on a route; it can never change the route (and so never grant tools).
  const profile = agentId ? agentProfile(agentId) : null;
  const agent = profile && profile.routes.includes(route) ? profile : null;
  const required = route === 'windows' ? ['completion', 'tools'] : ['completion'];
  if (hasImages) required.push('vision');
  const eligible = models.filter((item) =>
    required.every((cap) => item.capabilities.includes(cap)),
  );
  const routePin =
    preferences[route === 'windows' ? 'windowsModel' : 'generalModel'] || requestedModel;
  const agentPin = agent ? preferences.agentModels?.[agent.id] || '' : '';
  // Explicit choices win, most specific first: the agent's own pin, then the General / Windows model.
  const pins = [agentPin, routePin].filter(Boolean);
  const desired = pins[0];
  const matches = (item, tag) => item.id === tag || item.id === `${tag}:latest`;
  let selected;
  let source = 'auto';
  for (const tag of pins) {
    selected = eligible.find((item) => matches(item, tag));
    if (selected) {
      source = tag === agentPin ? 'pinned-agent' : 'pinned';
      break;
    }
  }
  const fallback = !!desired && !(selected && matches(selected, desired));
  // Prefer the agent's recommended families (when any is installed AND declares the needed capabilities), then
  // discovered Qwen capabilities, then the smallest local completion model. Never assume a tag exists.
  const ranked = [...eligible].sort(
    (a, b) =>
      order(hintRank(agent, a), hintRank(agent, b)) ||
      Number(/^qwen/i.test(b.family) || /^qwen/i.test(b.id)) -
        Number(/^qwen/i.test(a.family) || /^qwen/i.test(a.id)) ||
      a.size - b.size,
  );
  if (!selected) {
    selected = ranked[0];
    if (selected && Number.isFinite(hintRank(agent, selected))) source = 'auto-hint';
  }
  if (!selected)
    throw fail(
      `No installed local model supports ${required.join(' and ')} for the ${route === 'windows' ? 'Windows Agent' : 'General'} route. No computer action was performed.`,
      503,
    );
  const contextWindow = Math.min(preferences.contextWindow || 8192, selected.contextWindow || 8192);
  const generalCandidates = models
    .filter((item) => item.capabilities.includes('completion'))
    .sort(
      (a, b) =>
        Number(/^qwen/i.test(b.family) || /^qwen/i.test(b.id)) -
          Number(/^qwen/i.test(a.family) || /^qwen/i.test(a.id)) || a.size - b.size,
    );
  const general =
    generalCandidates.find((item) => item.id === preferences.generalModel) || generalCandidates[0];
  // Disk size is not a VRAM estimate. Report actual host memory and use short residency by default.
  return {
    route,
    model: selected.id,
    generalModel: general?.id || null,
    fallback,
    reason: fallback
      ? `Selected model ${desired} is unavailable or incompatible; using installed ${selected.id}.`
      : hasAttachments && !computerRequest
        ? 'Attached documents use the General route.'
        : route === 'windows'
          ? 'This task requires approved computer tools.'
          : 'General chat uses no computer tools.',
    options: { num_ctx: contextWindow },
    keepAlive: preferences.keepAlive || '30s',
    memory: {
      totalBytes: totalMemory,
      freeBytes: freeMemory,
      modelDiskBytes: selected.size,
    },
    capabilities: selected.capabilities,
    // Agent routing (additive): which agent asked, how the model was chosen, and the next-best eligible model.
    agentId: agent?.id || null,
    selection: source,
    fallbackModel: ranked.find((item) => item.id !== selected.id)?.id || null,
    agentReason: agent
      ? fallback
        ? `${agent.label}: the model you chose (${desired}) is unavailable or incompatible; using ${selected.id}.`
        : source === 'pinned-agent'
          ? `${agent.label}: using the model you chose for this agent (${selected.id}).`
          : source === 'pinned'
            ? `${agent.label}: using the ${route === 'windows' ? 'Windows Agent' : 'General'} model you chose (${selected.id}).`
            : source === 'auto-hint'
              ? `${agent.label}: ${selected.id} matches the recommended family (${agent.recommended}).`
              : `${agent.label}: no installed model matches the recommended family (${agent.recommended}); using ${selected.id}.`
      : null,
  };
}

export async function routeChatModel(options) {
  const models = await discoverModels();
  const preferences = modelPreferencesRepository().get(options.userId);
  return selectModelRoute({ ...options, models, preferences });
}

/**
 * The model for a background text job (translation fallback / polish) that is not a chat turn: a pinned tag wins
 * only if it is actually installed and can complete text; otherwise the General route decides, using the user's saved
 * General model when a user is known. Throws the General route's own "no installed model" error when none exists.
 */
export async function resolveGeneralModel({
  configured = '',
  userId = null,
  discover = discoverModels,
  preferencesFor = (id) => modelPreferencesRepository().get(id),
} = {}) {
  const models = await discover();
  const wanted = String(configured || '').trim();
  if (wanted) {
    const pinned = models.find(
      (item) =>
        (item.id === wanted || item.id === `${wanted}:latest`) &&
        item.capabilities.includes('completion'),
    );
    if (pinned) return pinned.id;
  }
  let preferences = DEFAULT_MODEL_PREFERENCES;
  if (userId) {
    try {
      preferences = preferencesFor(userId);
    } catch {
      preferences = DEFAULT_MODEL_PREFERENCES;
    }
  }
  return selectModelRoute({ models, preferences }).model;
}
