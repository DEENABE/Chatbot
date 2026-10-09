/** Offline clean release: never restores user databases into an installer. */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const frontend = path.resolve(__dirname, '..');
const releaseOutput = require('./release-output.cjs').resolveReleaseOutput(
  frontend,
  process.argv.slice(2),
);
const root = path.dirname(frontend);
const config = require('../package.json');
const electronPackage = require(path.join(root, 'node_modules', 'electron', 'package.json'));
if (config.build.electronVersion !== electronPackage.version)
  throw new Error('Installed Electron differs from the pinned build version');
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const env = {
  ...process.env,
  CHANAKYA_CLEAN_PACKAGE: '1',
  CHANAKYA_REUSE_RUNTIME: '1',
  npm_config_offline: 'true',
  CSC_IDENTITY_AUTO_DISCOVERY: 'false',
};
const run = (file, args, extra = {}) =>
  execFileSync(file, args, {
    cwd: frontend,
    env,
    stdio: 'inherit',
    windowsHide: true,
    ...extra,
  });

// A release always uses a fresh output. Never remove an old app's databases or a recovery stash.
const outDir = releaseOutput.directory;
if (fs.existsSync(outDir) && fs.readdirSync(outDir).length)
  throw new Error(
    'Release output already contains files. Choose a fresh --output-dir=release-name.',
  );

run(process.execPath, [path.join(__dirname, 'prepare-backend.cjs')]);
const runtime = path.join(frontend, 'backend-runtime', 'package.json');
run(
  electron,
  [
    '-e',
    `const r=require('node:module').createRequire(${JSON.stringify(runtime)});const Database=r('better-sqlite3');const db=new Database(':memory:');db.close();r('@lancedb/lancedb');console.log('Packaged backend native dependencies passed');`,
  ],
  { env: { ...env, ELECTRON_RUN_AS_NODE: '1' } },
);
run(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build']);
run(process.execPath, [
  path.join(root, 'node_modules', 'electron-builder', 'cli.js'),
  '--win',
  '--publish=never',
  '--config.directories.output=' + releaseOutput.name,
  '--config.npmRebuild=false',
]);
const output = path.join(outDir, 'win-unpacked');
require('./validate-repair-package.cjs').validateRepairPackage(
  path.join(output, 'resources', 'app'),
);
require('./validate-security-package.cjs').validateSecurityPackage(output, frontend);
console.log('Clean Windows security release validated at ' + path.dirname(output));
