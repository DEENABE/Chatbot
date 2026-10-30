#!/usr/bin/env node
/**
 * `npm run dev` (alias `npm run dev:tools`) — run the localhost UI with the same tool execution the
 * installed exe has (Windows Agent, app control, PowerShell/CMD, files,
 * services, registry, hardware, network, repair diagnostics).
 *
 *   1. start the dev tool host + loopback ToolBridge (frontend/dev-host)
 *   2. start the backend with the bridge URL/secret (so the Windows Agent route works)
 *   3. start Vite on a strict port, pointed at the tool host
 *
 * `npm run dev:plain` keeps the old behaviour (UI + API only, no desktop tools).
 */
import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const frontend = path.join(root, 'frontend');
const backend = path.join(root, 'backend');
const vitePort = Number(process.env.CHANAKYA_DEV_VITE_PORT) || 5173;
const children = [];
let closing = false;

const tag = (name, color) => (line) =>
  process.stdout.write(`\x1b[${color}m[${name}]\x1b[0m ${line}\n`);
function run(name, color, args, options) {
  const log = tag(name, color);
  const child = spawn(process.execPath, args, {
    ...options,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [child.stdout, child.stderr]) {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      lines.forEach((line) => line && log(line));
    });
  }
  child.once('exit', (code) => {
    if (!closing) {
      log(`exited (${code}); stopping the rest.`);
      shutdown(code || 1);
    }
  });
  children.push(child);
  return child;
}

let host;
async function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  for (const child of children) {
    if (child.exitCode !== null) continue;
    try {
      if (process.platform === 'win32')
        execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
          timeout: 5000,
        });
      else child.kill();
    } catch {
      child.kill();
    }
  }
  await host?.close().catch(() => {});
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// A leftover `npm run dev` (UI on 5173, API on 3001) would keep serving a page/backend that has
// no tool bridge, which shows up as "required desktop tool is unavailable". Fail early instead.
const portInUse = (port) =>
  Promise.all(
    ['127.0.0.1', '::1'].map(
      (host) =>
        new Promise((resolve) => {
          const socket = net.connect({ port, host });
          const done = (busy) => {
            socket.destroy();
            resolve(busy);
          };
          socket.setTimeout(800, () => done(false));
          socket.once('connect', () => done(true));
          socket.once('error', () => done(false));
        }),
    ),
  ).then((r) => r.some(Boolean));
const apiPort =
  Number(new URL(process.env.CHANAKYA_DEV_API_URL || 'http://127.0.0.1:3001').port) || 3001;
const toolsPort = Number(process.env.CHANAKYA_DEV_TOOLS_PORT) || 3002;
const busy = [];
for (const [name, port] of [
  ['UI (Vite)', vitePort],
  ['API (backend)', apiPort],
  ['tool host', toolsPort],
])
  if (await portInUse(port)) busy.push(`${name} port ${port}`);
if (busy.length) {
  console.error(
    `[dev:tools] Already in use: ${busy.join(', ')}.\n` +
      'Close the other `npm run dev` terminal / old backend (end its node.exe), then run `npm run dev` again.',
  );
  process.exit(1);
}

if (process.platform !== 'win32')
  console.warn(
    '[dev:tools] Desktop tools target Windows; on this OS most will report unavailable.',
  );

const { startDevToolHost } = await import(
  pathToFileURL(path.join(frontend, 'dev-host', 'index.js')).href
);
const log = tag('tools', 35);
try {
  host = await startDevToolHost({ vitePort });
  log(`tool host  ${host.hostUrl}  (browser origin allowed: http://localhost:${vitePort})`);
  log(`state dir  ${host.userDataDir}`);
  const desktop = host.diagnostics?.desktopControl;
  if (desktop && !desktop.ready) log(`desktop control not ready: ${desktop.reasons?.join(', ')}`);
  log(
    'Windows Repair "start spooler" needs the installed exe (protected runner is fail-closed here).',
  );
} catch (error) {
  // Never make `npm run dev` worse than before: keep UI + API up, say why tools are off.
  log(`TOOLS DISABLED - tool host failed to start: ${error.message}`);
}

// vite's package "exports" hides bin/vite.js from require.resolve; locate it via package.json.
const viteBin = path.join(
  path.dirname(createRequire(path.join(frontend, 'package.json')).resolve('vite/package.json')),
  'bin',
  'vite.js',
);
run('API', 33, ['--watch', 'src/server.js'], {
  cwd: backend,
  env: {
    ...process.env,
    ...(host
      ? {
          TOOL_ENGINE_INTERNAL_URL: host.bridge.url,
          TOOL_ENGINE_SESSION_SECRET: host.bridge.secret,
        }
      : {}),
  },
});
run('UI', 36, [viteBin, '--port', String(vitePort), '--strictPort', '--host', 'localhost'], {
  cwd: frontend,
  env: { ...process.env, ...(host ? { VITE_DEV_TOOL_HOST: host.hostUrl } : {}) },
});
