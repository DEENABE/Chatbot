/**
 * afterPack hook — copies the self-contained backend runtime (including its
 * node_modules) into the packed app's resources.
 *
 * electron-builder's `extraResources` silently skips node_modules, which left
 * the packaged backend without its dependencies. Doing the copy here (after the
 * app dir is packed, before the installer is built) guarantees the complete
 * backend — src + node_modules — ships inside the installer.
 */

const fs = require('fs');
const path = require('path');

// Confirmed during testing that touching this directory tree (rename OR
// delete) can hit a PERSISTENT EPERM on this machine — 6 retries over 3s
// still failed for a rename, most likely real-time antivirus scanning the
// freshly-written db.sqlite. A plain copy succeeds where rename doesn't
// (most scanners open with shared-read access), so preserve/restore copy
// rather than move; both that copy AND the plain deletes below get the
// same retry treatment, since either could hit the same lock.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function withRetry(label, fn, attempts = 6, delayMs = 500) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      fn();
      return;
    } catch (err) {
      if (attempt === attempts) throw err;
      console.log(`[afterPack] ${label} locked (attempt ${attempt}/${attempts}: ${err.code}), retrying in ${delayMs}ms...`);
      sleepSync(delayMs);
    }
  }
}

exports.default = async function afterPack(context) {
  const src = path.join(__dirname, '..', 'backend-runtime');
  const dest = path.join(context.appOutDir, 'resources', 'backend');

  withRetry('delete old backend', () => fs.rmSync(dest, { recursive: true, force: true }));
  withRetry('copy fresh backend', () => fs.cpSync(src, dest, { recursive: true }));

  // Restore whatever prepare-backend.cjs stashed away at the very start of
  // this build (a previous build's real storage/ — accounts, chat history,
  // uploads) — src (backend-runtime) never has its own storage/, so this
  // never overwrites anything real, only restores it.
  const stashRoot = path.join(__dirname, '..', '.storage-preserve-tmp');
  const preservedStorageStash = path.join(stashRoot, 'storage');
  if (fs.existsSync(preservedStorageStash)) {
    withRetry('restore preserved storage', () => fs.cpSync(preservedStorageStash, path.join(dest, 'storage'), { recursive: true }));
    try {
      withRetry('clean up stash', () => fs.rmSync(stashRoot, { recursive: true, force: true }));
    } catch {
      // Non-fatal — the restore itself already succeeded (the line above
      // completed), so the app has its data. A leftover stash folder is
      // harmless clutter, and gets overwritten by the next build's own
      // preserve step regardless.
      console.warn('[afterPack] could not clean up the preserve-tmp stash (non-fatal, data was restored successfully)');
    }
    console.log('[afterPack] restored preserved app data into the fresh package');
  }

  const mods = fs.existsSync(path.join(dest, 'node_modules'))
    ? fs.readdirSync(path.join(dest, 'node_modules')).length
    : 0;
  console.log(`[afterPack] backend copied → ${dest} (${mods} node_modules entries)`);
};
