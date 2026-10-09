import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binary = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
let failed = false;
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
for (const name of ['ipcTrust', 'navigationGuard']) {
  const result = spawnSync(
    binary,
    [path.join(root, 'frontend', 'electron', 'tests', `${name}.test.mjs`)],
    {
      cwd: root,
      stdio: 'inherit',
      windowsHide: true,
      timeout: 45000,
      env,
    },
  );
  if (result.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
