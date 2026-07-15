/**
 * prepare-backend — builds a self-contained backend runtime for packaging.
 *
 * Why: the repo uses npm workspaces, which hoist the backend's dependencies to
 * the ROOT node_modules. So `backend/node_modules` is incomplete and the
 * packaged app's backend crashes on startup (missing express, @lancedb, …).
 *
 * This performs an isolated production install (outside the workspace, so
 * nothing hoists) and assembles `frontend/backend-runtime/` with:
 *   src/ + scripts/ + package.json + a COMPLETE node_modules
 * electron-builder then copies that to resources/backend.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const frontendDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(frontendDir, '..');
const backendSrc = path.join(repoRoot, 'backend');
const out = path.join(frontendDir, 'backend-runtime');
const tmp = path.join(os.tmpdir(), 'chanakya-backend-build');

console.log('[prepare-backend] isolated production install…');
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });
fs.copyFileSync(path.join(backendSrc, 'package.json'), path.join(tmp, 'package.json'));
execSync('npm install --omit=dev --no-audit --no-fund', { cwd: tmp, stdio: 'inherit' });

console.log('[prepare-backend] assembling backend-runtime…');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.cpSync(path.join(backendSrc, 'src'), path.join(out, 'src'), { recursive: true });
if (fs.existsSync(path.join(backendSrc, 'scripts'))) {
  fs.cpSync(path.join(backendSrc, 'scripts'), path.join(out, 'scripts'), { recursive: true });
}
fs.copyFileSync(path.join(backendSrc, 'package.json'), path.join(out, 'package.json'));
fs.cpSync(path.join(tmp, 'node_modules'), path.join(out, 'node_modules'), { recursive: true });

const count = fs.readdirSync(path.join(out, 'node_modules')).length;
console.log(`[prepare-backend] done → ${out} (${count} node_modules entries)`);
