const path = require('node:path');
function resolveReleaseOutput(frontend, args = []) {
  if (args.length > 1 || (args.length && !args[0].startsWith('--output-dir=')))
    throw new Error('Expected one optional --output-dir=release-name argument');
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const name = args.length ? args[0].slice('--output-dir='.length) : `release-desktop-${stamp}`;
  if (!/^release-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))
    throw new Error('Release output must be one relative release-* directory name');
  const root = path.resolve(frontend);
  const directory = path.resolve(root, name);
  if (path.dirname(directory) !== root || path.relative(root, directory) !== name)
    throw new Error('Release output must be an immediate child of frontend');
  return { name, directory };
}
module.exports = { resolveReleaseOutput };
