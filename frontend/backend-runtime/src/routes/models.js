import { Router } from 'express';
import { supportedModels } from '../config.js';
import { listInstalledModels, listLoadedModels, unloadAllModels } from '../services/ollamaService.js';

export const modelsRouter = Router();

// Which models are currently held in memory (RAM/VRAM).
modelsRouter.get('/loaded', async (_request, response) => {
  const loaded = await listLoadedModels();
  response.json({ loaded: loaded.map((m) => m.name) });
});

// Free all loaded models from memory — called when the assistant goes idle.
modelsRouter.post('/unload', async (_request, response) => {
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
