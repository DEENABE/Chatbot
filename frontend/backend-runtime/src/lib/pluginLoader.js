import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from '../config.js';

export async function loadPlugins(app) {
  const pluginsDir = config.pluginsDir;
  try {
    await fs.mkdir(pluginsDir, { recursive: true });
    const files = await fs.readdir(pluginsDir);
    for (const file of files) {
      if (file.endsWith('.js')) {
        const pluginPath = path.join(pluginsDir, file);
        const pluginUrl = pathToFileURL(pluginPath).href;
        try {
          const plugin = await import(pluginUrl);
          if (typeof plugin.default === 'function') {
            await plugin.default(app);
            console.log(`[plugin] Loaded successfully: ${file}`);
          } else {
            console.warn(`[plugin] ${file} does not export a default function.`);
          }
        } catch (err) {
          console.error(`[plugin] Failed to load ${file}:`, err.message);
        }
      }
    }
  } catch (err) {
    console.error('[plugin] Failed to read plugins directory:', err.message);
  }
}
