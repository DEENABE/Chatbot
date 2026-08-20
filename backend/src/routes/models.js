import { Router } from 'express';
import { supportedModels } from '../config.js';
import { listInstalledModels, listLoadedModels, unloadAllModels } from '../services/ollamaService.js';
import { requireAuth } from '../middleware/auth.js';

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

// Free all loaded models from memory — called when the assistant goes idle.
modelsRouter.post('/unload', requireAuth, async (_request, response) => {
  try {
    const unloaded = await unloadAllModels();
    response.json({ ok: true, unloaded });
  } catch (error) {
    response.status(200).json({ ok: false, error: error.message });
  }
});

modelsRouter.get('/', async (_request, response) => {
  try {
    const installed = await listInstalledModels();
    response.json({
      connected: true,
      models: supportedModels.map((model) => ({
        ...model,
        installed: installed.some((item) => item.name === model.id || item.name.startsWith(`${model.id}:`))
      })),
      installed: installed.map((item) => item.name)
    });
  } catch (error) {
    response.json({
      connected: false,
      models: supportedModels.map((model) => ({ ...model, installed: false })),
      installed: [],
      error: error.message
    });
  }
});
