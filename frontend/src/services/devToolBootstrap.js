// Side-effect module, imported FIRST by main.jsx so window.toolEngine exists before
// services/toolEngine.js and the stores read it. Inert in production builds and in
// the Electron app (import.meta.env.DEV is false / preload already defined the APIs).
import { installDevToolBridge } from './devToolBridge.js';

if (import.meta.env.DEV && !window.electronAPI) {
  const host = import.meta.env.VITE_DEV_TOOL_HOST;
  if (host) {
    installDevToolBridge(host);
    console.info(`[dev-tools] Desktop tools bridged to ${host}`);
  } else {
    console.warn(
      '[dev-tools] Desktop tools are OFF in this tab. Start the app from the repo root with `npm run dev` (not `dev:plain`, not `vite` alone). See docs/LOCALHOST_TOOL_MODE.md.',
    );
  }
}
