import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [];
function walk(directory) {
  if (!fs.existsSync(directory)) return;
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, item.name);
    if (item.isDirectory()) walk(full);
    else if (
      /\.test\.(?:js|mjs|cjs)$/.test(item.name) &&
      !['ipcTrust.test.mjs', 'navigationGuard.test.mjs'].includes(item.name)
    )
      files.push(full);
  }
}
for (const name of [
  'backend/src',
  'backend/test',
  'backend/tests',
  'frontend/tools/tests',
  'frontend/electron/tests',
  'frontend/src',
  'frontend/test',
])
  walk(path.join(root, name));
if (!files.length) throw new Error('No component tests found.');
const result = spawnSync(process.execPath, ['--test', ...files], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true,
});
process.exit(result.status ?? 1);
