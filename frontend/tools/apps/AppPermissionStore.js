import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Per-application permission levels. The level is the user's decision about how far the assistant may go inside
 * one application; it is stored by application id and can only be changed through the user-approved
 * `app.setAppPermission` action, which is not in the model's tool allow-list.
 *
 *   blocked  - the assistant may not launch, read or control the application
 *   read     - may launch/focus it and read its UI (observe, verify); no control is operated
 *   interact - + operate low-risk controls (navigate, select, expand, scroll, type in text fields, open/search/play)
 *   modify   - + operate controls that change data (save, delete, send, ...), each still needing a human confirmation
 *
 * Controls classified CRITICAL (security, credentials, system tools) are refused at every level.
 */
export const PERMISSION_LEVELS = Object.freeze(['blocked', 'read', 'interact', 'modify']);
// Matches the behavior before levels existed: data-changing controls need a per-action human confirmation.
export const DEFAULT_LEVEL = 'modify';
const RANK = Object.freeze({ blocked: 0, read: 1, interact: 2, modify: 3 });
// Minimum level for each action risk class (see security/ToolRegistry.js RISK). CRITICAL is never allowed.
const REQUIRED = Object.freeze({ READ: 'read', SAFE_WRITE: 'interact', DANGEROUS: 'modify' });

export const LEVEL_DESCRIPTIONS = Object.freeze({
  blocked: 'No access: the assistant will not open, read or control this application.',
  read: 'Read only: may open/focus the application and read what is on screen; it will not click, type or change anything.',
  interact: 'Interact: may also navigate and use low-risk controls (select, expand, scroll, type in text fields, open/search/play). Anything that changes data is refused.',
  modify: 'Modify: may also operate controls that change data (save, delete, send...), each one only after you confirm it. Security-sensitive controls stay blocked.',
});

export const isLevel = value => typeof value === 'string' && PERMISSION_LEVELS.includes(value);
export const levelAllows = (level, risk) => Object.hasOwn(REQUIRED, risk) && RANK[level] >= RANK[REQUIRED[risk]];
/** Human-readable list of what a level permits, for the model and the settings UI. */
export function levelSummary(level) {
  return { level, description: LEVEL_DESCRIPTIONS[level], allows: Object.keys(REQUIRED).filter(risk => levelAllows(level, risk)).map(risk => ({ READ: 'read_ui', SAFE_WRITE: 'use_low_risk_controls', DANGEROUS: 'change_data_with_confirmation' })[risk]) };
}
const validId = id => typeof id === 'string' && /^[A-Za-z0-9._-]{1,80}$/.test(id);

export class AppPermissionStore {
  constructor({ directory, defaultLevel = DEFAULT_LEVEL } = {}) {
    if (!isLevel(defaultLevel) || defaultLevel === 'blocked') throw new Error('INVALID_PERMISSION_LEVEL');
    this.directory = directory; this.defaultLevel = defaultLevel; this.levels = new Map();
    this.file = directory ? path.join(directory, 'app-permissions.json') : null;
    this.ready = this.load();
  }
  async load() {
    if (!this.file) return;
    try {
      const data = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (data?.schemaVersion !== 1 || !data.levels || typeof data.levels !== 'object') return;
      if (isLevel(data.default) && data.default !== 'blocked') this.defaultLevel = data.default;
      // Anything malformed in the file is ignored, never trusted.
      for (const [id, level] of Object.entries(data.levels)) if (validId(id) && isLevel(level)) this.levels.set(id, level);
    } catch { /* Missing or corrupt file: defaults apply. */ }
  }
  /** Effective level for an application record. Unknown applications get the default. */
  levelFor(app) { return (validId(app?.id) && this.levels.get(app.id)) || this.defaultLevel; }
  explicitLevel(appId) { return this.levels.get(appId) || null; }
  async setLevel(appId, level) {
    await this.ready;
    if (!validId(appId) || !isLevel(level)) throw Object.assign(new Error('INVALID_PERMISSION_LEVEL'), { code: 'INVALID_PERMISSION_LEVEL' });
    if (level === this.defaultLevel) this.levels.delete(appId); else this.levels.set(appId, level);
    await this.save();
    return this.levelFor({ id: appId });
  }
  async save() {
    if (!this.file) return;
    await fs.mkdir(this.directory, { recursive: true });
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify({ schemaVersion: 1, default: this.defaultLevel, levels: Object.fromEntries(this.levels) }), { mode: 0o600 });
      await fs.rename(tmp, this.file);
    } finally { await fs.rm(tmp, { force: true }).catch(() => {}); }
  }
}
