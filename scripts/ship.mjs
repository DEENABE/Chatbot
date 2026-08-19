#!/usr/bin/env node
/**
 * "Ship" pipeline — the local half of the Claude Code -> auto-commit flow:
 *
 *   modify project -> [secrets scan | tests | build | diff review] -> PASS?
 *     PASS -> commit locally, on the current branch. Nothing is pushed.
 *     FAIL -> stop, nothing committed
 *
 * The four checks run independently and ALL must pass. Nothing is committed
 * unless every one of them is green. Pushing to GitHub and opening PRs are
 * manual, human actions — this script never does either.
 *
 * Requires on PATH: git, gitleaks.
 *
 * Usage: node scripts/ship.mjs ["commit message"]
 */

import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function sh(cmd, opts = {}) {
  return execSync(cmd, { cwd: root, encoding: 'utf8', stdio: opts.silent ? 'pipe' : 'inherit', ...opts });
}
function shCapture(cmd) {
  try {
    return execSync(cmd, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    return { error: true, message: (err.stdout || '') + (err.stderr || err.message) };
  }
}
function has(cmd) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' });
  return r.status === 0;
}

const results = [];
function report(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ' — ' + detail : ''}`);
}

console.log('── Preflight ──────────────────────────────────────────────');
for (const tool of ['git', 'gitleaks']) {
  if (!has(tool)) {
    console.error(`\n✖ '${tool}' is not on PATH. Install it before running ship.`);
    if (tool === 'gitleaks') console.error('  https://github.com/gitleaks/gitleaks#installing');
    process.exit(1);
  }
}

const status = shCapture('git status --porcelain');
if (status.error) { console.error(status.message); process.exit(1); }
if (!status) {
  console.log('Nothing to ship — working tree is clean.');
  process.exit(0);
}

console.log('\n── Staging ─────────────────────────────────────────────────');
sh('git add -A');

console.log('\n── Security checks (all must pass) ───────────────────────────');

// 1. Secrets scan — gitleaks against exactly what's staged, so it only ever
// flags what this run is about to commit, not the whole repo history.
{
  const r = spawnSync('gitleaks', ['protect', '--staged', '--redact', '-v'], { cwd: root, encoding: 'utf8' });
  const ok = r.status === 0;
  report('Secrets scan (gitleaks)', ok, ok ? 'clean' : 'potential secret(s) found — see output above');
  if (!ok) console.log(r.stdout + r.stderr);
}

// 2. Tests
{
  // Single command string (not an argv array) with shell:true — passing an
  // array alongside shell:true triggers Node's DEP0190 warning, since the
  // array gets naively joined into a shell string without escaping. Safe
  // here either way (no interpolated input), but this is the pattern Node
  // itself recommends.
  const r = spawnSync('npm test', { cwd: root, encoding: 'utf8', shell: true });
  const ok = r.status === 0;
  report('Tests (npm test)', ok, ok ? 'passed' : 'failing — see output above');
  if (!ok) console.log(r.stdout + r.stderr);
}

// 3. Build
{
  const r = spawnSync('npm run build', { cwd: root, encoding: 'utf8', shell: true });
  const ok = r.status === 0;
  report('Build (npm run build)', ok, ok ? 'succeeded' : 'failed — see output above');
  if (!ok) console.log(r.stdout + r.stderr);
}

// 4. Git diff review — heuristic checks on the staged diff itself, not a
// human review (that happens later, at the PR). Blocks on sensitive file
// patterns; the size check is informational only (this repo legitimately
// ships large training .jsonl files).
{
  const staged = shCapture('git diff --cached --name-only');
  const files = typeof staged === 'string' ? staged.split('\n').filter(Boolean) : [];
  const SENSITIVE = /(^|[\\/])\.env($|[\\/.])|\.pem$|\.key$|id_rsa|credentials|secrets?\.(json|ya?ml)$/i;
  const flagged = files.filter((f) => SENSITIVE.test(f) && !f.endsWith('.env.example'));

  const statLine = shCapture('git diff --cached --shortstat');
  const ok = flagged.length === 0;
  report('Git diff review', ok, ok ? (statLine || 'no changes') : `sensitive file path(s): ${flagged.join(', ')}`);
  if (statLine) console.log(`  ${statLine}`);
}

console.log('\n── Result ──────────────────────────────────────────────────');
const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.error(`✖ ${failed.length} check(s) failed: ${failed.map((f) => f.name).join(', ')}`);
  console.error('Nothing committed. Fix the above and re-run.');
  sh('git reset'); // unstage — leave the working tree exactly as the user left it
  process.exit(1);
}

console.log('✔ All checks passed.\n');

console.log('── Commit ─────────────────────────────────────────────────');
const message = process.argv[2] || `chore: automated update ${new Date().toISOString()}`;
sh(`git commit -m ${JSON.stringify(message)}`);

const branch = shCapture('git rev-parse --abbrev-ref HEAD');
console.log(`\nCommitted locally on '${branch}'. Nothing was pushed — push and open a PR by hand when ready:`);
console.log(`  git push origin ${branch}`);
