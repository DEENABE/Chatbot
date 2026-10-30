import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { normalizeAppName } from './AppQueryNormalizer.js';
// Canonical application identity and the candidate model behind "which application do you mean?".
// Nothing here knows an application by name: two registry records are the same application when they launch the same
// package (AUMID) or the same executable file, however many shortcuts or registrations point at it.
export const MAX_APP_CANDIDATES = 10;
// Sources a user recognises, most recognisable first. Only decides whose metadata represents a group of duplicates.
const SOURCE_RANK = [
  'msix',
  'start_menu',
  'shell_apps',
  'app_paths',
  'install_roots',
  'running',
  'path',
  'uninstall',
];
// Code-owned launchers: explorer/mmc/control host many distinct capabilities, so each id stands alone.
const SYSTEM_SOURCES = new Set(['windows_system', 'windows_management', 'control_panel']);
const nativeRealpath = (file) => {
  try {
    return fs.realpathSync.native(file);
  } catch {
    return file;
  }
};
const sourceRank = (app) => {
  const index = SOURCE_RANK.indexOf(app?.source);
  return index < 0 ? SOURCE_RANK.length : index;
};
function normalizeExecutable(file, realpath) {
  const cleaned = path.win32.normalize(
    String(file)
      .trim()
      .replace(/^"+|"+$/g, '')
      .replace(/\//g, '\\'),
  );
  // Resolves 8.3 names, junctions and casing so two spellings of one file compare equal.
  return String(realpath(cleaned)).toLowerCase().replace(/\\+$/, '');
}
/** Stable string identifying the application a record launches; equal strings mean the same application. */
export function canonicalIdentity(app, realpath = nativeRealpath) {
  if (!app) return null;
  if (SYSTEM_SOURCES.has(app.source) || app.trusted === true) return `system:${app.id}`;
  if (app.launchType === 'app_user_model_id' && app.appUserModelId)
    return `aumid:${String(app.appUserModelId).toLowerCase()}`;
  if (typeof app.executablePath === 'string' && app.executablePath.trim())
    return `exe:${normalizeExecutable(app.executablePath, realpath)}`;
  return `id:${app.id}`;
}
/** The candidate id: derived only from the canonical identity, so it survives registry rescans and record merges. */
export const candidateIdFor = (app, realpath) =>
  createHash('sha256').update(canonicalIdentity(app, realpath)).digest('hex').slice(0, 24);
const better = (a, b) => b.score - a.score || sourceRank(a.app) - sourceRank(b.app);
/**
 * Collapses ranked rows ({app,score,...}, best first) that are the same application into one row, the best-scoring
 * and then most recognisable record. Rows below `floor` are left alone: they can never be shown or accepted.
 */
export function collapseDuplicateApps(
  rows,
  { floor = 0, limit = 60, realpath = nativeRealpath } = {},
) {
  const groups = new Map(),
    order = [];
  let inspected = 0;
  for (const row of rows) {
    if (row.score < floor || inspected >= limit) {
      order.push(row);
      continue;
    }
    inspected++;
    const key = canonicalIdentity(row.app, realpath),
      group = groups.get(key);
    if (group) {
      group.push(row);
      continue;
    }
    const created = [row];
    groups.set(key, created);
    order.push(created);
  }
  return order.map((item) => (Array.isArray(item) ? [...item].sort(better)[0] : item));
}
/** The user-facing description of one application. Selection is always by `id`, never by display name. */
export function toCandidate(app, confidence = 0, realpath = nativeRealpath) {
  return {
    id: candidateIdFor(app, realpath),
    appId: app.id,
    canonicalName: app.normalizedName || normalizeAppName(app.displayName || app.name),
    displayName: String(app.displayName || app.name),
    executablePath: app.executablePath || null,
    launchTarget: app.launchTarget || app.appUserModelId || app.executablePath || null,
    source: app.source || null,
    publisher: app.publisher || null,
    confidence: Math.round((Number.isFinite(confidence) ? confidence : 0) * 1000) / 1000,
  };
}
/** Deduplicated, ordered candidates for ranked rows. */
export function buildCandidates(
  rows,
  { realpath = nativeRealpath, limit = MAX_APP_CANDIDATES } = {},
) {
  return collapseDuplicateApps(rows, { realpath })
    .map((row) => toCandidate(row.app, row.score, realpath))
    .slice(0, limit)
    .sort(
      (a, b) =>
        b.confidence - a.confidence ||
        a.displayName.localeCompare(b.displayName) ||
        a.id.localeCompare(b.id),
    );
}
/**
 * The registry record a previously offered candidate stands for, or null when it no longer exists or is unavailable.
 * The record id is tried first; if the registry was rebuilt, the canonical identity finds it again.
 */
export function findAppForCandidate(apps, candidate, realpath = nativeRealpath) {
  const usable = (app) => app?.available === true;
  const direct = apps.find((app) => app.id === candidate?.appId);
  if (usable(direct) && candidateIdFor(direct, realpath) === candidate.id) return direct;
  return (
    apps
      .filter((app) => usable(app) && candidateIdFor(app, realpath) === candidate?.id)
      .sort((a, b) => sourceRank(a) - sourceRank(b))[0] || null
  );
}
