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

exports.default = async function afterPack(context) {
  const src = path.join(__dirname, '..', 'backend-runtime');
  const dest = path.join(context.appOutDir, 'resources', 'backend');

  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });

  const mods = fs.existsSync(path.join(dest, 'node_modules'))
    ? fs.readdirSync(path.join(dest, 'node_modules')).length
    : 0;
  console.log(`[afterPack] backend copied → ${dest} (${mods} node_modules entries)`);
};
