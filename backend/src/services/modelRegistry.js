import os from 'node:os';
import { discoverModels, rememberVerifiedModels, selectModelRoute } from './modelRouter.js';
import { AGENT_PROFILES, hintRank, hintsEnabled } from './agentProfiles.js';
import { listLoadedModels } from './ollamaService.js';
import { getDb } from '../db/connection.js';

/**
 * Local model registry: a read-only, persisted view of what Ollama reports about the installed models.
 *
 * It only ever uses discovery (GET /api/tags, POST /api/show) and residency (GET /api/ps). It never pulls, deletes,
 * copies or replaces a model. A snapshot served while Ollama is unreachable is marked `stale` and is for display
 * only: routing keeps using live discovery and never trusts a stale snapshot.
 */
export const REGISTRY_SCHEMA_VERSION = 1;
const MAX_MISSING = 50;
const MAX_ERROR_LENGTH = 200;

/** One short line, no stack, no multi-line server bodies in the UI or the database. */
export const safeMessage = (error) =>
  String(error?.message ?? error ?? 'Unknown error')
    .split(/\r?\n/)[0]
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_ERROR_LENGTH) || 'Unknown error';

export function registryStore(db = getDb()) {
  db.exec(
    `CREATE TABLE IF NOT EXISTS model_registry_snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), snapshot TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
  );
  return {
    get() {
      const row = db.prepare('SELECT snapshot FROM model_registry_snapshot WHERE id = 1').get();
      if (!row) return null;
      try {
        const snapshot = JSON.parse(row.snapshot);
        return snapshot?.schemaVersion === REGISTRY_SCHEMA_VERSION && Array.isArray(snapshot.models)
          ? snapshot
          : null;
      } catch {
        return null;
      }
    },
    save(snapshot) {
      db.prepare(
        'INSERT INTO model_registry_snapshot(id,snapshot,updated_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET snapshot=excluded.snapshot,updated_at=excluded.updated_at',
      ).run(JSON.stringify(snapshot), Date.now());
      return snapshot;
    },
  };
}

/** What a model may be offered for. Tool use needs a capability list that Ollama itself declared (now or for this build). */
export function modelRoles(model) {
  const capabilities = Array.isArray(model.capabilities) ? model.capabilities : [];
  const completion = capabilities.includes('completion');
  return {
    general: completion,
    tools: completion && capabilities.includes('tools') && model.capabilityVerified === true,
    vision: completion && capabilities.includes('vision') && model.capabilityVerified === true,
    embedding: capabilities.includes('embedding'),
  };
}

const UNKNOWN_HEALTH = Object.freeze({ state: 'unknown' });

export function buildSnapshot({
  models,
  loaded = [],
  previous = null,
  now = Date.now(),
  ollama = { connected: true },
}) {
  const resident = new Map(
    (Array.isArray(loaded) ? loaded : []).map((item) => [item?.name ?? item?.model, item]),
  );
  const before = new Map((previous?.models ?? []).map((item) => [item.id, item]));
  const records = models.map((model) => {
    const earlier = before.get(model.id);
    const live = resident.get(model.id);
    const source = model.capabilitySource || (model.capabilityVerified ? 'ollama' : 'unknown');
    return {
      id: model.id,
      label: model.label || model.id,
      family: model.family,
      parameterSize: model.parameterSize,
      quantization: model.quantization,
      sizeBytes: model.size || 0,
      contextWindow: model.contextWindow ?? null,
      capabilities: [...(model.capabilities ?? [])],
      capabilityVerified: model.capabilityVerified === true,
      capabilitySource: source,
      showFailed: model.showFailed === true,
      digest: model.digest ?? null,
      provenance: {
        capabilities: source,
        contextWindow: model.contextWindow ? source : 'unknown',
      },
      roles: modelRoles(model),
      residency: live
        ? {
            loaded: true,
            expiresAt: live.expires_at ?? null,
            sizeBytes: live.size ?? null,
            vramBytes: live.size_vram ?? null,
          }
        : { loaded: false },
      health: earlier?.health ?? UNKNOWN_HEALTH,
      firstSeenAt: earlier?.firstSeenAt ?? now,
      lastSeenAt: now,
    };
  });
  const present = new Set(records.map((item) => item.id));
  const missing = [
    ...(previous?.missing ?? []),
    ...(previous?.models ?? [])
      .filter((item) => !present.has(item.id))
      .map((item) => ({
        id: item.id,
        lastSeenAt: item.lastSeenAt ?? null,
        capabilities: item.capabilities ?? [],
      })),
  ]
    .filter(
      (item, index, all) =>
        !present.has(item.id) && all.findIndex((other) => other.id === item.id) === index,
    )
    .slice(-MAX_MISSING);
  return {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    refreshedAt: now,
    ollama,
    models: records,
    missing,
  };
}

/**
 * Current registry. Live discovery wins; if Ollama cannot be reached the last persisted snapshot is returned as
 * `stale: true` (never an invented list). Persistence problems never fail the call.
 */
export async function getModelRegistry({
  refresh = false,
  discover = discoverModels,
  loadedModels = listLoadedModels,
  store,
  now = Date.now,
} = {}) {
  let persistent = store;
  let previous = null;
  try {
    persistent ||= registryStore();
    previous = persistent.get();
  } catch {
    persistent = null;
  }
  if (previous) rememberVerifiedModels(previous.models);
  try {
    const models = await discover({ refresh });
    let loaded = [];
    try {
      loaded = await loadedModels();
    } catch {
      loaded = [];
    }
    const snapshot = buildSnapshot({ models, loaded, previous, now: now() });
    try {
      persistent?.save(snapshot);
    } catch {
      /* The registry still answers from memory. */
    }
    return { ...snapshot, stale: false };
  } catch (error) {
    const ollama = { connected: false, error: safeMessage(error) };
    if (previous)
      return {
        ...previous,
        ollama,
        stale: true,
        models: previous.models.map((item) => ({ ...item, residency: { loaded: false } })),
      };
    return {
      schemaVersion: REGISTRY_SCHEMA_VERSION,
      refreshedAt: null,
      ollama,
      models: [],
      missing: [],
      stale: true,
    };
  }
}

/** Record the outcome of a real request or an explicit model test. Two failures in a row mark the model failed. */
export function recordModelHealth({
  modelId,
  ok,
  latencyMs = null,
  error = null,
  store,
  now = Date.now,
}) {
  const persistent = store ?? registryStore();
  const snapshot = persistent.get();
  const target = snapshot?.models.find((item) => item.id === modelId);
  if (!target) return null;
  const failures = ok ? 0 : (target.health?.consecutiveFailures ?? 0) + 1;
  target.health = {
    state: ok ? 'ready' : failures >= 2 ? 'failed' : 'degraded',
    lastCheckedAt: now(),
    lastLatencyMs: Number.isFinite(latencyMs)
      ? Math.round(latencyMs)
      : (target.health?.lastLatencyMs ?? null),
    consecutiveFailures: failures,
    ...(ok ? {} : { lastError: safeMessage(error) }),
  };
  persistent.save(snapshot);
  return target.health;
}

/** Whether each saved assignment can still be honoured by an installed model. */
export function describeAssignments(preferences, models) {
  const describe = (configured, capability, label) => {
    if (!configured)
      return {
        configured: '',
        state: 'auto',
        message: 'Chosen automatically from installed capabilities.',
      };
    const model = models.find((item) => item.id === configured);
    if (!model)
      return {
        configured,
        state: 'missing',
        message: `${configured} is no longer installed. ${label} uses an installed model until you choose another.`,
      };
    if (
      !model.capabilities.includes('completion') ||
      !model.capabilities.includes(capability) ||
      (capability === 'tools' && model.capabilityVerified !== true)
    )
      return {
        configured,
        state: 'incompatible',
        message: `${configured} does not declare ${capability} support. ${label} uses an installed model until you choose another.`,
      };
    return { configured, state: 'ready', message: 'Installed and compatible.' };
  };
  return {
    generalModel: describe(preferences?.generalModel, 'completion', 'General answers'),
    windowsModel: describe(preferences?.windowsModel, 'tools', 'The Windows Agent'),
  };
}

/**
 * What each logical agent would use right now, computed by the same selection code the chat route runs (so this view
 * cannot disagree with what actually happens). `recommendedInstalled` says whether any installed model matches the
 * agent's recommended family AND declares what the agent needs; when it is false the agent uses the best installed
 * model instead, and nothing is downloaded.
 */
export function describeAgents(preferences, models, hardware) {
  return Object.values(AGENT_PROFILES).map((profile) => {
    const assignments = profile.routes.map((route) => {
      try {
        const chosen = selectModelRoute({
          models,
          preferences: preferences || undefined,
          agentId: profile.id,
          hardware,
          ...(route === 'windows' ? { computerRequest: { requiresTools: true } } : {}),
        });
        return {
          route,
          model: chosen.model,
          fallbackModel: chosen.fallbackModel,
          source: chosen.selection,
          reason: chosen.agentReason,
          error: null,
        };
      } catch (error) {
        return {
          route,
          model: null,
          fallbackModel: null,
          source: null,
          reason: null,
          error: safeMessage(error),
        };
      }
    });
    const needs = profile.routes.includes('general') ? ['completion'] : profile.requires;
    return {
      id: profile.id,
      label: profile.label,
      role: profile.role,
      routes: [...profile.routes],
      requires: [...profile.requires],
      pinned: preferences?.agentModels?.[profile.id] || '',
      recommended: profile.recommended,
      recommendedInstalled: models.some(
        (item) =>
          Number.isFinite(hintRank(profile, item)) &&
          needs.every((cap) => item.capabilities.includes(cap)),
      ),
      hintsEnabled: hintsEnabled(),
      assignments,
    };
  });
}

/** Whether the embedding model that the document index was built with is installed. */
export function describeEmbedding(configured, models) {
  const model = models.find((item) => item.id === configured || item.id === `${configured}:latest`);
  if (!model)
    return {
      configured,
      state: 'missing',
      message: `Document search needs the embedding model ${configured}, which is not installed in Ollama. Chat is not affected; new documents stay unindexed until it is installed.`,
    };
  if (!model.capabilityVerified)
    return {
      configured,
      state: 'unknown',
      message: `${configured} is installed, but Ollama did not report its capabilities yet. Refresh to check again.`,
    };
  if (!model.capabilities.includes('embedding'))
    return {
      configured,
      state: 'incompatible',
      message: `${configured} is installed but does not declare embedding support.`,
    };
  return { configured, state: 'ready', message: 'Installed and compatible.' };
}

export const hostMemory = () => ({ totalBytes: os.totalmem(), freeBytes: os.freemem() });
