const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const frontendDir = path.resolve(__dirname, '..');
const backendSrc = path.resolve(frontendDir, '..', 'backend');
const out = path.join(frontendDir, 'backend-runtime');
const reuse = process.env.CHANAKYA_REUSE_RUNTIME !== '0';
function assertChild(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error('Unsafe build path: ' + target);
}
assertChild(frontendDir, out);
if (fs.existsSync(path.join(out, 'storage')))
  throw new Error(
    'Runtime contains user storage. Preserve it outside the runtime before building.',
  );
const expected = JSON.parse(fs.readFileSync(path.join(backendSrc, 'package.json'), 'utf8'));
if (reuse) {
  const existing = JSON.parse(fs.readFileSync(path.join(out, 'package.json'), 'utf8'));
  if (
    JSON.stringify(existing.dependencies) !== JSON.stringify(expected.dependencies) ||
    !fs.existsSync(path.join(out, 'node_modules'))
  )
    throw new Error(
      'Isolated runtime dependencies differ. Prepare matching dependencies offline before building.',
    );
} else {
  // Explicit opt-in uses only the local npm cache. Network installs are never implicit.
  fs.mkdirSync(out, { recursive: true });
  fs.copyFileSync(path.join(backendSrc, 'package.json'), path.join(out, 'package.json'));
  execFileSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['install', '--offline', '--omit=dev', '--no-audit', '--no-fund'],
    {
      cwd: out,
      stdio: 'inherit',
      windowsHide: true,
      shell: process.platform === 'win32',
    },
  );
}
for (const name of ['src', 'scripts']) {
  const target = path.join(out, name);
  assertChild(out, target);
  fs.rmSync(target, { recursive: true, force: true });
  if (fs.existsSync(path.join(backendSrc, name)))
    fs.cpSync(path.join(backendSrc, name), target, {
      recursive: true,
      filter: (entry) =>
        !/\.(?:test|spec)\.(?:js|mjs|cjs)$|model-route-smoke\.mjs$|\.before-[^\\/]+$/.test(entry),
    });
}
fs.copyFileSync(path.join(backendSrc, 'package.json'), path.join(out, 'package.json'));
console.log(
  '[prepare-backend] clean source assembled with existing offline dependencies; no user data copied',
);
