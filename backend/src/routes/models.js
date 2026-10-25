import { Router } from 'express';
import {
  discoverModels,
  modelPreferencesRepository,
  validateModelPreferences,
} from '../services/modelRouter.js';
import { listLoadedModels } from '../services/ollamaService.js';
import { config } from '../config.js';
import { EMBEDDING_CANDIDATE } from '../services/agentProfiles.js';
import {
  describeAgents,
  describeAssignments,
  describeEmbedding,
  getModelRegistry,
  hostMemory,
  safeMessage,
} from '../services/modelRegistry.js';
import { requireAuth } from '../middleware/auth.js';
import { memoryManager } from '../memory/runtime.js';
import { getHardwareProfile, inferencePlanForHardware } from '../services/gpuProfile.js';

export const modelsRouter = Router();

// The GET routes below are deliberately left open (no requireAuth): they
// return only static/global model info — no per-user data, no resource ID,
// nothing ownership-scoped — and the frontend fetches them on mount before
// login completes (App.jsx calls fetchModels() alongside checkAuth()), so
// gating them would break the pre-login model list. /unload is different:
// it's a mutating, disruptive action (drops every loaded model from RAM/VRAM
// for whoever else is mid-request), so it gets the same requireAuth every
// other mutating route in this app already has.
modelsRouter.get('/loaded', async (_request, response) => {
  const loaded = await listLoadedModels();
  response.json({ loaded: loaded.map((m) => m.name) });
});

modelsRouter.get('/settings', requireAuth, async (request, response) => {
  try {
    const [models, hardware] = await Promise.all([
      discoverModels(),
      getHardwareProfile({ residency: listLoadedModels }),
    ]);
    const preferences = modelPreferencesRepository().get(request.userId);
    response.json({
      preferences,
      models,
      hardware,
      automatic: inferencePlanForHardware(hardware, { contextWindow: preferences.contextWindow }),
    });
  } catch (error) {
    response.status(error.status || 503).json({ error: error.message });
  }
});

modelsRouter.get('/hardware', requireAuth, async (_request, response) => {
  try {
    const hardware = await getHardwareProfile({ residency: listLoadedModels });
    response.setHeader('Cache-Control', 'no-store');
    response.json({ hardware, automatic: inferencePlanForHardware(hardware) });
  } catch {
    response
      .status(503)
      .json({
        error: 'Hardware details are unavailable. Automatic CPU-safe inference remains enabled.',
      });
  }
});

modelsRouter.put('/settings', requireAuth, async (request, response) => {
  try {
    const models = await discoverModels();
    // An older client that does not know about per-agent models must not wipe them by saving the other settings.
    const carry =
      request.body &&
      typeof request.body === 'object' &&
      !Array.isArray(request.body) &&
      !Object.hasOwn(request.body, 'agentModels');
    let preferences;
    if (carry) {
      try {
        preferences = validateModelPreferences(
          {
            ...request.body,
            agentModels: modelPreferencesRepository().get(request.userId).agentModels,
          },
          models,
        );
      } catch {
        // A stored per-agent choice that no longer validates (model removed) is dropped; the rest is validated as sent.
        preferences = validateModelPreferences({ ...request.body, agentModels: {} }, models);
      }
    } else {
      preferences = validateModelPreferences(request.body, models);
    }
    response.json({
      preferences: modelPreferencesRepository().save(request.userId, preferences),
    });
  } catch (error) {
    response.status(error.status || 400).json({ error: error.message });
  }
});

// Read-only registry of what the local Ollama reports (capabilities with their source, residency, health, models
// that disappeared). Nothing here downloads, deletes or replaces a model.
let lastForcedRefresh = 0;
async function registryPayload(request, { refresh }) {
  const [registry, hardware] = await Promise.all([
    getModelRegistry({ refresh }),
    getHardwareProfile({ residency: listLoadedModels }),
  ]);
  let assignments = null;
  let agents = null;
  try {
    const preferences = modelPreferencesRepository().get(request.userId);
    assignments = describeAssignments(preferences, registry.models);
    agents = describeAgents(preferences, registry.models, hardware);
  } catch {
    /* Preferences are optional context for this view. */
  }
  return {
    ...registry,
    assignments,
    agents,
    embedding: {
      ...describeEmbedding(config.embeddingModel, registry.models),
      suggestion: EMBEDDING_CANDIDATE,
    },
    host: hostMemory(),
    hardware,
  };
}

modelsRouter.get('/registry', requireAuth, async (request, response) => {
  try {
    response.json(await registryPayload(request, { refresh: false }));
  } catch (error) {
    response.status(500).json({ error: safeMessage(error) });
  }
});

modelsRouter.post('/registry/refresh', requireAuth, async (request, response) => {
  try {
    // A second click within two seconds reuses the answer just fetched instead of asking Ollama again.
    const now = Date.now();
    const refresh = now - lastForcedRefresh > 2000;
    if (refresh) lastForcedRefresh = now;
    response.json(await registryPayload(request, { refresh }));
  } catch (error) {
    response.status(500).json({ error: safeMessage(error) });
  }
});

// Free all loaded models from memory — called when the assistant goes idle.
modelsRouter.post('/unload', requireAuth, async (_request, response) => {
  response.status(410).json({
    ok: false,
    error:
      'Global model unloading is retired because it can interrupt other requests. Model residency follows the keep-alive duration in Settings.',
  });
});

modelsRouter.get('/', async (_request, response) => {
  try {
    const installed = await discoverModels();
    try {
      memoryManager.system.setSystemMemory(
        'ollama.models',
        installed
          .map((m) => m.id)
          .slice(0, 30)
          .join(', ')
          .slice(0, 1900) || 'No installed models',
        'SEMI_STATIC',
        { source: 'ollama_local' },
      );
    } catch {
      /* Cache failure does not alter model discovery. */
    }
    response.json({
      connected: true,
      models: installed.filter((item) => item.capabilities.includes('completion')),
      installed: installed.map((item) => item.id),
    });
  } catch (error) {
    response.json({
      connected: false,
      models: [],
      installed: [],
      error: error.message,
    });
  }
});
