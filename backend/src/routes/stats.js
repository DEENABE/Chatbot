import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getCachedHardwareProfile, observeResidency } from '../services/gpuProfile.js';
import { listLoadedModels } from '../services/ollamaService.js';
import { createStatsReader } from '../services/statsMetrics.js';

export const statsRouter = Router();
statsRouter.use(requireAuth);

// Startup/explicit hardware inspection performs bounded discovery. Polling reads its cache and never spawns a helper.
const readStats = createStatsReader({ hardware: getCachedHardwareProfile });
let placementRefresh;
let placementCheckedAt = 0;
statsRouter.get('/', async (_request, response, next) => {
  try {
    if (!placementRefresh && Date.now() - placementCheckedAt > 5000) {
      placementCheckedAt = Date.now();
      placementRefresh = listLoadedModels()
        .then(observeResidency)
        .finally(() => {
          placementRefresh = null;
        });
    }
    response.json(await readStats());
  } catch (error) {
    next(error);
  }
});
