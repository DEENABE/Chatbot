const fs = require('node:fs');
const path = require('node:path');

// Check final resources, including the backend copied by afterPack. Globs alone
// cannot protect additional copy hooks from shipping developer-machine data.
function validateApplicationPortability(resources) {
  const root = path.resolve(resources);
  const cacheName = /^app-(?:registry|aliases|permissions|targets)(?:\..*)?$/i;
  const queue = [root];
  let checked = 0;
  while (queue.length) {
    const directory = queue.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (cacheName.test(entry.name))
        throw new Error(
          'Package contains machine-local application data: ' + path.relative(root, target),
        );
      if (entry.isSymbolicLink())
        throw new Error(
          'Package contains an unverified resource link: ' + path.relative(root, target),
        );
      if (entry.isDirectory()) queue.push(target);
      else checked++;
    }
  }
  for (const file of [
    'app/tools/apps/AppDiscoveryService.js',
    'app/tools/apps/AppRegistryService.js',
    'app/tools/apps/AppMachineIdentity.js',
    'app/tools/services/AppService.js',
    'app/tools/services/GenericDesktopService.js',
    'desktop-control/DiscoverApps.ps1',
    'desktop-control/ObserveApp.ps1',
    'desktop-control/DesktopUI.ps1',
    'desktop-control/DesktopAccessibility.cs',
  ]) {
    if (!fs.statSync(path.join(root, file)).isFile())
      throw new Error('Missing runtime discovery component: ' + file);
  }
  return {
    applicationPortability: 'passed',
    discovery: 'runtime',
    machineLocalData: 'absent',
    checkedFiles: checked,
  };
}
module.exports = { validateApplicationPortability };
if (require.main === module)
  console.log(JSON.stringify(validateApplicationPortability(path.resolve(process.argv[2]))));
