/**
 * Keeps the isolated backend runtime (frontend/backend-runtime) in step with
 * backend/package.json before a release build.
 *
 * When backend/package.json gains a dependency (e.g. exceljs for the Document
 * Intelligence agent), the runtime that gets packaged must have it too. This
 * step installs only what is missing, from the local npm cache first, and
 * never runs package install scripts, so the native modules already built for
 * Electron (better-sqlite3, lancedb) are left untouched.
 *
 * Opt out (strict offline builds): set CHANAKYA_NO_DEP_SYNC=1.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const sortedDependencies = (value) =>
  JSON.stringify(Object.entries(value || {}).sort(([a], [b]) => a.localeCompare(b)));

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/** npm-cli.js next to the Node running the build (npm does not have to be on PATH). */
function findNpmCli(nodeExe = process.execPath, env = process.env) {
  const dir = path.dirname(nodeExe);
  const candidates = [
    path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(dir, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ...(env.APPDATA
      ? [path.join(env.APPDATA, 'npm', 'node_modules', 'npm', 'bin', 'npm-cli.js')]
      : []),
  ];
  return candidates.find((file) => fs.existsSync(file)) || null;
}

/** Dependencies of backend/package.json that the runtime lacks or declares differently. */
function runtimeDifferences(frontend) {
  const runtime = path.join(frontend, 'backend-runtime');
  const expected =
    readJson(path.join(frontend, '..', 'backend', 'package.json')).dependencies || {};
  const current = fs.existsSync(path.join(runtime, 'package.json'))
    ? readJson(path.join(runtime, 'package.json')).dependencies || {}
    : {};
  const missing = Object.keys(expected).filter(
    (name) =>
      !fs.existsSync(path.join(runtime, 'node_modules', ...name.split('/'), 'package.json')),
  );
  const changed = Object.keys(expected).filter((name) => current[name] !== expected[name]);
  const removed = Object.keys(current).filter((name) => !(name in expected));
  return {
    runtime,
    missing,
    changed,
    removed,
    inSync: !missing.length && sortedDependencies(current) === sortedDependencies(expected),
  };
}

/**
 * @param {string} frontend absolute path of the frontend folder
 * @param {{ execute?: Function, log?: Function, nodeExe?: string, env?: object }} [options]
 * @returns {{ changed: boolean, installed?: string[] }}
 */
function syncBackendRuntime(
  frontend,
  { execute = execFileSync, log = console.log, nodeExe = process.execPath, env = process.env } = {},
) {
  const diff = runtimeDifferences(frontend);
  const { runtime } = diff;
  if (
    !fs.existsSync(path.join(runtime, 'package.json')) ||
    !fs.existsSync(path.join(runtime, 'node_modules'))
  )
    return { changed: false }; // not prepared at all: the preflight reports how to prepare it
  if (fs.existsSync(path.join(runtime, 'storage'))) return { changed: false }; // preflight refuses user data
  if (diff.inSync) return { changed: false };

  const names = [...new Set([...diff.missing, ...diff.changed])];
  log(
    `[build] Backend runtime dependencies are out of date (${[
      names.length ? `add/update: ${names.join(', ')}` : '',
      diff.removed.length ? `no longer used: ${diff.removed.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('; ')}). Syncing frontend/backend-runtime...`,
  );
  fs.copyFileSync(
    path.join(frontend, '..', 'backend', 'package.json'),
    path.join(runtime, 'package.json'),
  );
  const npmArgs = [
    'install',
    '--omit=dev',
    '--no-audit',
    '--no-fund',
    '--prefer-offline',
    '--ignore-scripts',
  ];
  const npmCli = findNpmCli(nodeExe, env);
  const childEnv = { ...env };
  delete childEnv.npm_config_offline; // allow fetching a missing package once
  try {
    if (npmCli)
      execute(nodeExe, [npmCli, ...npmArgs], {
        cwd: runtime,
        stdio: 'inherit',
        windowsHide: true,
        env: childEnv,
      });
    else
      execute(process.platform === 'win32' ? 'npm.cmd' : 'npm', npmArgs, {
        cwd: runtime,
        stdio: 'inherit',
        windowsHide: true,
        env: childEnv,
        shell: process.platform === 'win32',
      });
  } catch {
    throw new Error(
      `Could not install the backend runtime dependencies (${names.join(', ') || 'package update'}). ` +
        'Connect to the internet once and run rebuild.cmd again (packages already in the npm cache install offline).',
    );
  }
  const after = runtimeDifferences(frontend);
  if (!after.inSync)
    throw new Error(
      `Backend runtime is still missing: ${after.missing.join(', ') || 'matching dependency list'}. Run "npm install --omit=dev" in frontend\\backend-runtime and retry.`,
    );
  log(`[build] Backend runtime synced${names.length ? `: ${names.join(', ')}` : ''}.`);
  return { changed: true, installed: names };
}

module.exports = { syncBackendRuntime, runtimeDifferences, findNpmCli };
