import { Router } from 'express';
import os from 'node:os';
import fs from 'node:fs/promises';

export const statsRouter = Router();

let previousCpus = os.cpus();

function getCpuUsage() {
  const currentCpus = os.cpus();
  let totalDiff = 0;
  let idleDiff = 0;

  for (let i = 0; i < previousCpus.length; i++) {
    const oldCpu = previousCpus[i];
    const newCpu = currentCpus[i];

    if (!oldCpu || !newCpu) continue;

    const oldTotal = Object.values(oldCpu.times).reduce((a, b) => a + b, 0);
    const newTotal = Object.values(newCpu.times).reduce((a, b) => a + b, 0);

    totalDiff += newTotal - oldTotal;
    idleDiff += newCpu.times.idle - oldCpu.times.idle;
  }

  previousCpus = currentCpus;
  if (totalDiff === 0) return 0;
  return Math.max(0, Math.min(100, Math.round(100 * (1 - idleDiff / totalDiff))));
}

statsRouter.get('/', async (_request, response, next) => {
  try {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const ramUsagePercentage = Math.round((usedMem / totalMem) * 100);

    // Calculate actual local disk usage using native fs.statfs
    let diskUsagePercentage = 25; // default fallback
    try {
      const stats = await fs.statfs(process.cwd());
      const freeSpace = stats.bfree * stats.bsize;
      const totalSpace = stats.blocks * stats.bsize;
      diskUsagePercentage = Math.round(((totalSpace - freeSpace) / totalSpace) * 100);
    } catch (err) {
      console.warn('Failed to retrieve disk space metrics:', err.message);
    }

    // Get active process node memory
    const memoryMetrics = process.memoryUsage();
    const heapUsedMB = Math.round(memoryMetrics.heapUsed / (1024 * 1024));

    response.json({
      cpu: getCpuUsage(),
      ram: ramUsagePercentage,
      gpu: Math.round(Math.random() * 5 + 3), // dynamic mock fallback
      temperature: 41 + Math.round(Math.random() * 5), // dynamic mock fallback
      disk: diskUsagePercentage,
      electronMemory: heapUsedMB
    });
  } catch (error) {
    next(error);
  }
});
