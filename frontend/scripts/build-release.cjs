/** Offline clean release: never restores user databases into an installer. */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const frontend = path.resolve(__dirname, '..');
let preflight;
try {
  preflight = require('./build-preflight.cjs').checkBuildRequirements(
    frontend,
    process.argv.slice(2),
  );
} catch (error) {
  console.error('[build] ' + error.message);
  process.exit(1);
}
const { output: releaseOutput, root } = preflight;
console.log(
  `[build] Preflight passed: Node ${preflight.nodeVersion}, Electron ${preflight.electronVersion}, isolated native dependencies ready.`,
);
console.log('[build] GPU and Ollama are not required to build the installer.');
if (preflight.check) {
  console.log('[build] Check completed; no source copies or installer build were performed.');
  process.exit(0);
}
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
run(process.execPath, [preflight.vite, 'build']);
run(process.execPath, [
  preflight.builder,
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
