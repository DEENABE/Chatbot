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
const cleanPackage = process.env.CHANAKYA_CLEAN_PACKAGE === '1';
const reuseRuntime = process.env.CHANAKYA_REUSE_RUNTIME === '1';
// Verify every destructive build path is within its named build root.
function assertChild(root,target) {
  const relative=path.relative(path.resolve(root),path.resolve(target));
  if(!relative || relative.startsWith('..') || path.isAbsolute(relative))throw new Error('Unsafe build path: '+target);
}
assertChild(frontendDir,out);assertChild(os.tmpdir(),tmp);

// Synchronous sleep (no external deps) — used only to retry a Windows
// rename that's transiently locked, see renameWithRetry below.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// fs.renameSync on the storage/ directory hit a persistent EPERM during
// testing — even several seconds after the exe process was already fully
// closed, so this isn't the transient "OS hasn't released the handle yet"
// race it looks like at first; something else (most likely antivirus
// real-time scanning the just-modified db.sqlite) was holding a lock long
// enough to fail every retry. A rename needs nothing else referencing the
// directory at all; a plain copy doesn't — most readers/scanners open
// files with shared-read access, so cpSync succeeds where renameSync
// didn't. Copy to the stash rather than move; the original is left in
// place but gets deleted anyway moments later by afterPack.cjs's own
// `fs.rmSync(dest)` when it wipes resources/backend for the fresh copy —
// so nothing extra to clean up here.
function withRetry(label, fn, attempts = 6, delayMs = 500) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      fn();
      return;
    } catch (err) {
      if (attempt === attempts) throw err;
      console.log(`[prepare-backend] ${label} locked (attempt ${attempt}/${attempts}: ${err.code}), retrying in ${delayMs}ms...`);
      sleepSync(delayMs);
    }
  }
}

// The packaged app now stores its database/uploads/etc INSIDE its own
// resources/backend/storage (config.js's appDataPath defaults to wherever
// backend/ itself lives — portable with the install, not a separate OS
// profile folder). electron-builder rebuilds release-build/win-unpacked
// from scratch on every `npm run electron:build`, which would otherwise
// silently delete a previous build's real user data (accounts, chat
// history) on every single rebuild. Stash any existing storage/ from the
// PREVIOUS build here, first thing, before electron-builder touches
// anything — afterPack.cjs restores it once the fresh package exists.
const preservedStorageStash = path.join(frontendDir, '.storage-preserve-tmp');
const previousPackagedStorage = path.join(frontendDir, 'release-build', 'win-unpacked', 'resources', 'backend', 'storage');
assertChild(frontendDir,preservedStorageStash);
if (!cleanPackage && fs.existsSync(previousPackagedStorage)) {
  // A fresh, real storage/ exists in the current package — this run's own
  // copy supersedes anything already stashed (from, say, a previous build
  // that failed partway through its own restore step), so it's safe to
  // clear the old stash ONLY here, right before writing a new one.
  withRetry('clear old stash', () => fs.rmSync(preservedStorageStash, { recursive: true, force: true }));
  fs.mkdirSync(preservedStorageStash, { recursive: true });
  withRetry('preserve app data', () => fs.cpSync(previousPackagedStorage, path.join(preservedStorageStash, 'storage'), { recursive: true }));
  console.log('[prepare-backend] preserved existing packaged app data for restore after this rebuild');
} else if (!cleanPackage && fs.existsSync(preservedStorageStash)) {
  // Nothing to preserve from THIS run (a previous build already wiped its
  // own resources/backend/storage on its way to failing before it could
  // restore) — but a stash from that earlier, still-unrestored attempt may
  // be the only surviving copy of real user data. Never touch it in this
  // branch; afterPack.cjs still gets to restore it into the fresh package
  // being built now.
  console.log('[prepare-backend] no current packaged storage/ to preserve, but a stash from an earlier interrupted build exists — leaving it for afterPack.cjs to restore');
}

if(reuseRuntime) {
  const existing=JSON.parse(fs.readFileSync(path.join(out,'package.json'),'utf8'));
  const expected=JSON.parse(fs.readFileSync(path.join(backendSrc,'package.json'),'utf8'));
  if(JSON.stringify(existing.dependencies)!==JSON.stringify(expected.dependencies) || !fs.existsSync(path.join(out,'node_modules')))throw new Error('Existing backend dependency set differs; run normal preparation first.');
  console.log('[prepare-backend] reusing matching isolated dependencies (offline)');
} else {
console.log('[prepare-backend] isolated production install…');
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });
fs.copyFileSync(path.join(backendSrc, 'package.json'), path.join(tmp, 'package.json'));
execSync('npm install --omit=dev --no-audit --no-fund', { cwd: tmp, stdio: 'inherit' });
}

console.log('[prepare-backend] assembling backend-runtime…');
if(reuseRuntime) {
  for(const name of ['src','scripts']){const target=path.join(out,name);assertChild(out,target);fs.rmSync(target,{recursive:true,force:true});}
}else fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.cpSync(path.join(backendSrc, 'src'), path.join(out, 'src'), { recursive: true });
if (fs.existsSync(path.join(backendSrc, 'scripts'))) {
  fs.cpSync(path.join(backendSrc, 'scripts'), path.join(out, 'scripts'), { recursive: true });
}
fs.copyFileSync(path.join(backendSrc, 'package.json'), path.join(out, 'package.json'));
if(!reuseRuntime)fs.cpSync(path.join(tmp, 'node_modules'), path.join(out, 'node_modules'), { recursive: true });
if(cleanPackage && fs.existsSync(path.join(out,'storage')))throw new Error('Clean runtime must not contain user storage.');

const count = fs.readdirSync(path.join(out, 'node_modules')).length;
console.log(`[prepare-backend] done → ${out} (${count} node_modules entries)`);
