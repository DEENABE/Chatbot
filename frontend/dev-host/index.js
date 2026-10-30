/**
 * @module dev-host
 * @description Starts everything the exe's Electron main process provides for
 * tools, for `npm run dev:tools`:
 *   - the loopback ToolBridge the backend's Windows Agent route calls
 *     (same electron/ipc/toolBridgeServer.js, same per-launch secret), and
 *   - the browser-facing tool host the React page talks to.
 */
import { createToolBridgeServer } from '../electron/ipc/toolBridgeServer.js';
import { stopOwnedHelpers } from '../tools/ExecutionContext.js';
import { createDevToolRuntime } from './runtime.js';
import { createDevToolHost, createBackendUserResolver } from './server.js';
import { defaultAllowedOrigins } from './guard.js';

export async function startDevToolHost({
  hostPort = Number(process.env.CHANAKYA_DEV_TOOLS_PORT) || 3002,
  vitePort = Number(process.env.CHANAKYA_DEV_VITE_PORT) || 5173,
  apiBase = `${process.env.CHANAKYA_DEV_API_URL || 'http://127.0.0.1:3001'}/api`,
  userDataDir,
} = {}) {
  const { ledger, userDataDir: dataDir } = createDevToolRuntime({ userDataDir });
  await ledger.ready;
  const bridge = await createToolBridgeServer(ledger);
  const host = createDevToolHost({
    ledger,
    bridgeSecret: bridge.secret,
    resolveUserId: createBackendUserResolver({ apiBase }),
    port: hostPort,
    allowedOrigins: defaultAllowedOrigins(vitePort),
  });
  const hostUrl = await host.listen();
  return {
    hostUrl,
    bridge: { url: bridge.url, secret: bridge.secret },
    userDataDir: dataDir,
    diagnostics: ledger.desktopDiagnostics(),
    async close() {
      for (const active of ledger.active?.values() || []) active.controller.abort();
      stopOwnedHelpers();
      bridge.server.close();
      await host.close();
    },
  };
}
