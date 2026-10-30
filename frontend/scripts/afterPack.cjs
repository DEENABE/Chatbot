const fs = require('node:fs');
const path = require('node:path');
exports.default = async function afterPack(context) {
  require('./validate-repair-package.cjs').validateRepairPackage(
    path.join(context.appOutDir, 'resources', 'app'),
  );
  const src = path.resolve(__dirname, '..', 'backend-runtime');
  const dest = path.join(context.appOutDir, 'resources', 'backend');
  const relative = path.relative(path.resolve(context.appOutDir), path.resolve(dest));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error('Unsafe backend output path');
  if (fs.existsSync(path.join(src, 'storage')) || fs.existsSync(path.join(dest, 'storage')))
    throw new Error('Refusing to overwrite or package user storage. Use a fresh release output.');
  fs.cpSync(src, dest, { recursive: true });
  const portability = require('./validate-app-portability.cjs').validateApplicationPortability(
    path.join(context.appOutDir, 'resources'),
  );
  console.log(
    '[afterPack] clean backend runtime copied; portability: ' + JSON.stringify(portability),
  );
};
