import { Router } from 'express';
import { supportedModels } from '../config.js';
import { listInstalledModels } from '../services/ollamaService.js';

export const modelsRouter = Router();

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
