const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { resolveReleaseOutput } = require('./release-output.cjs');

function parseBuildArguments(args = []) {
  const check = args.includes('--check');
  const releaseArgs = args.filter((arg) => arg !== '--check');
  if (args.filter((arg) => arg === '--check').length > 1)
    throw new Error('Pass --check only once.');
  return { check, releaseArgs };
}
const sortedDependencies = (value) =>
  JSON.stringify(Object.entries(value || {}).sort(([a], [b]) => a.localeCompare(b)));

/** Read-only preflight. No downloads, source copies, output creation, or user storage writes. */
function checkBuildRequirements(
  frontend,
  args = [],
  {
    platform = process.platform,
    nodeVersion = process.versions.node,
    architecture = process.arch,
    nativeProbe = true,
    execute = execFileSync,
  } = {},
) {
  if (platform !== 'win32') throw new Error('The Windows installer must be built on Windows.');
  if (Number(nodeVersion.split('.')[0]) < 20)
    throw new Error(
      'Building requires Node.js 20 or newer. Set CHANAKYA_NODE_EXE to a supported Node executable.',
    );
  if (architecture !== 'x64')
    throw new Error('Use the 64-bit Node.js runtime to build this Windows x64 installer.');
  const { check, releaseArgs } = parseBuildArguments(args);
  const output = resolveReleaseOutput(frontend, releaseArgs);
  const root = path.dirname(frontend);
  const need = (relative, detail = 'Install the project dependencies before rebuilding.') => {
    const file = path.resolve(root, relative);
    if (!fs.existsSync(file)) throw new Error(`Missing build input: ${relative}. ${detail}`);
    return file;
  };
  const readJson = (relative, detail) =>
    JSON.parse(fs.readFileSync(need(relative, detail), 'utf8'));
  const config = readJson('frontend/package.json');
  const electronPackage = readJson('node_modules/electron/package.json');
  if (config.build?.electronVersion !== electronPackage.version)
    throw new Error(
      `Installed Electron ${electronPackage.version} differs from pinned ${config.build?.electronVersion}. Restore the matching project dependencies before rebuilding.`,
    );
  const electron = need('node_modules/electron/dist/electron.exe');
  const vite = need('node_modules/vite/bin/vite.js');
  const builder = need('node_modules/electron-builder/cli.js');
  need('frontend/electron/preload.cjs', 'Restore the desktop source before rebuilding.');
  need('frontend/scripts/prepare-backend.cjs', 'Restore the release scripts before rebuilding.');
  const expected = readJson('backend/package.json');
  const runtimePackage = need(
    'frontend/backend-runtime/package.json',
    'The isolated offline backend runtime must be prepared before building; rebuild will not download dependencies.',
  );
  const runtime = JSON.parse(fs.readFileSync(runtimePackage, 'utf8'));
  need(
    'frontend/backend-runtime/node_modules',
    'Prepare the isolated offline backend dependencies before rebuilding.',
  );
  if (sortedDependencies(runtime.dependencies) !== sortedDependencies(expected.dependencies))
    throw new Error(
      'Isolated backend dependencies differ from backend/package.json. Prepare matching offline dependencies before rebuilding.',
    );
  if (fs.existsSync(path.join(frontend, 'backend-runtime', 'storage')))
    throw new Error(
      'The isolated backend runtime contains user storage. Preserve that data outside the runtime before building.',
    );
  if (
    fs.existsSync(output.directory) &&
    (!fs.statSync(output.directory).isDirectory() || fs.readdirSync(output.directory).length)
  )
    throw new Error(
      'Release output already contains files. Choose a fresh --output-dir=release-name.',
    );
  if (nativeProbe) {
    try {
      execute(
        electron,
        [
          '-e',
          `const r=require('node:module').createRequire(${JSON.stringify(runtimePackage)});const Database=r('better-sqlite3');const db=new Database(':memory:');db.close();r('@lancedb/lancedb');console.log('Packaged backend native dependencies passed');`,
        ],
        {
          cwd: frontend,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          windowsHide: true,
          timeout: 30000,
          stdio: 'pipe',
        },
      );
    } catch (error) {
      const detail = String(error.stderr || error.message || '')
        .trim()
        .slice(0, 1500);
      throw new Error(
        `The isolated backend native dependencies do not load in Electron. Prepare the runtime for Electron ${electronPackage.version} before rebuilding. ${detail}`,
      );
    }
  }
  return {
    check,
    output,
    root,
    electron,
    vite,
    builder,
    nodeVersion,
    electronVersion: electronPackage.version,
    nativeChecked: nativeProbe,
  };
}
module.exports = { parseBuildArguments, checkBuildRequirements };
