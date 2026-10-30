import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Folder organize / rename. Two steps: plan (read-only) → user clicks Apply.
 * Only moves/renames inside the chosen root; never deletes a file. Every applied
 * plan keeps an undo log.
 */

export class OrganizeError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'OrganizeError';
    this.status = status;
  }
}

export const CATEGORIES = {
  Documents: ['.pdf', '.doc', '.docx', '.odt', '.rtf', '.txt', '.md', '.epub'],
  Spreadsheets: ['.xls', '.xlsx', '.xlsm', '.csv', '.ods', '.tsv'],
  Presentations: ['.ppt', '.pptx', '.odp', '.key'],
  Images: ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.heic', '.tif', '.tiff', '.ico', '.raw'],
  Videos: ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.webm', '.flv', '.m4v'],
  Audio: ['.mp3', '.wav', '.m4a', '.flac', '.aac', '.ogg', '.wma', '.opus'],
  Archives: ['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.iso'],
  Installers: ['.exe', '.msi', '.msix', '.appx', '.bat', '.cmd'],
  Code: ['.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.c', '.cpp', '.h', '.cs', '.go', '.rs', '.html', '.css', '.json', '.xml', '.yml', '.yaml', '.sql', '.ps1', '.sh', '.ipynb'],
  Fonts: ['.ttf', '.otf', '.woff', '.woff2'],
};
const CATEGORY_BY_EXT = new Map(
  Object.entries(CATEGORIES).flatMap(([folder, exts]) => exts.map((e) => [e, folder])),
);
const CATEGORY_FOLDERS = new Set([...Object.keys(CATEGORIES), 'Others', '_Duplicates']);
const SKIP_NAMES = /^(?:desktop\.ini|thumbs\.db|\.ds_store|~\$.*|.*\.(?:tmp|crdownload|part|partial|lnk))$/i;
const SENSITIVE =
  /(?:^|[\\/])(?:\.ssh|\.aws|\.gnupg|credentials?|secrets?|vault|\.env(?:\..*)?|id_rsa|id_ed25519)(?:[\\/]|$)|\.(?:pem|key|pfx|p12|kdbx)$/i;
const MAX_FILES = 5000;

const within = (root, target) => {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** Refuse drive roots, the user profile root and the app's own data. */
export function assertOrganizableRoot(root, { home = process.env.USERPROFILE || process.env.HOME, protectedRoots = [] } = {}) {
  const resolved = path.resolve(root);
  if (path.parse(resolved).root === resolved || /^[a-z]:[\\/]?$/i.test(String(root).trim()))
    throw new OrganizeError('Choose a folder, not a whole drive.');
  if (home && path.resolve(home).toLowerCase() === resolved.toLowerCase())
    throw new OrganizeError('Choose a folder inside your user profile (for example Downloads), not the profile itself.');
  for (const p of protectedRoots)
    if (p && (within(path.resolve(p), resolved) || within(resolved, path.resolve(p))))
      throw new OrganizeError("This folder contains the assistant's own data. Choose another folder.");
  return resolved;
}

export async function scanFolder(root, { recursive = false } = {}) {
  const files = [];
  async function walk(dir, depth) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (files.length >= MAX_FILES) return;
      if (e.name.startsWith('.') || SKIP_NAMES.test(e.name)) continue;
      const full = path.join(dir, e.name);
      if (SENSITIVE.test(full)) continue;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        // Never descend into folders this tool creates (keeps re-runs idempotent).
        if (recursive && depth < 6 && !(depth === 0 && CATEGORY_FOLDERS.has(e.name))) await walk(full, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      let stat;
      try {
        stat = await fs.stat(full);
      } catch {
        continue;
      }
      files.push({
        rel: path.relative(root, full).split(path.sep).join('/'),
        name: e.name,
        ext: path.extname(e.name).toLowerCase(),
        size: stat.size,
        mtime: stat.mtime,
      });
    }
  }
  await walk(root, 0);
  return { files, truncated: files.length >= MAX_FILES };
}

const pad = (n) => String(n).padStart(2, '0');
const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function cleanName(name) {
  const ext = path.extname(name);
  let base = name.slice(0, name.length - ext.length);
  base = base
    .normalize('NFC')
    .replace(/[_]+/g, ' ')
    .replace(/[^\p{L}\p{N}\p{M} .()-]+/gu, ' ')
    .replace(/\s*\(\s*(\d+)\s*\)\s*$/, ' ($1)')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return `${base || 'file'}${ext.toLowerCase()}`;
}

function uniqueTarget(target, taken) {
  if (!taken.has(target.toLowerCase())) return target;
  const dir = path.posix.dirname(target);
  const ext = path.posix.extname(target);
  const base = path.posix.basename(target, ext);
  for (let n = 2; ; n++) {
    const candidate = `${dir === '.' ? '' : `${dir}/`}${base} (${n})${ext}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  const handle = await fs.open(file, 'r');
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk);
  } finally {
    await handle.close().catch(() => {});
  }
  return hash.digest('hex');
}

/** Build the list of moves for a mode. Pure except for hashing in duplicates mode. */
export async function buildMoves(root, files, mode) {
  const taken = new Set(files.map((f) => f.rel.toLowerCase()));
  const moves = [];
  const add = (file, target) => {
    if (target.toLowerCase() === file.rel.toLowerCase()) return;
    taken.delete(file.rel.toLowerCase());
    const finalTarget = uniqueTarget(target, taken);
    taken.add(finalTarget.toLowerCase());
    moves.push({ from: file.rel, to: finalTarget, size: file.size });
  };
  const dirOf = (rel) => {
    const d = path.posix.dirname(rel);
    return d === '.' ? '' : `${d}/`;
  };

  if (mode === 'duplicates') {
    const bySize = new Map();
    for (const f of files) {
      if (!f.size) continue;
      if (!bySize.has(f.size)) bySize.set(f.size, []);
      bySize.get(f.size).push(f);
    }
    for (const group of bySize.values()) {
      if (group.length < 2) continue;
      const byHash = new Map();
      for (const f of group) {
        let h;
        try {
          h = await hashFile(path.join(root, f.rel));
        } catch {
          continue;
        }
        if (!byHash.has(h)) byHash.set(h, []);
        byHash.get(h).push(f);
      }
      for (const same of byHash.values()) {
        if (same.length < 2) continue;
        // Keep the oldest copy where it is; move the rest aside (never delete).
        same.sort((a, b) => a.mtime - b.mtime || a.rel.length - b.rel.length);
        for (const dup of same.slice(1)) add(dup, `_Duplicates/${dup.name}`);
      }
    }
    return moves;
  }

  for (const f of files) {
    const top = f.rel.split('/')[0];
    if (mode === 'type') {
      const folder = CATEGORY_BY_EXT.get(f.ext) || 'Others';
      if (f.rel.includes('/') && top === folder) continue;
      add(f, `${folder}/${f.name}`);
    } else if (mode === 'extension') {
      const folder = f.ext ? f.ext.slice(1).toUpperCase() : 'No extension';
      if (f.rel.includes('/') && top === folder) continue;
      add(f, `${folder}/${f.name}`);
    } else if (mode === 'date') {
      const d = f.mtime;
      add(f, `${d.getFullYear()}/${d.getFullYear()}-${pad(d.getMonth() + 1)}/${f.name}`);
    } else if (mode === 'rename-date') {
      if (/^\d{4}-\d{2}-\d{2}[_ -]/.test(f.name)) continue;
      add(f, `${dirOf(f.rel)}${isoDate(f.mtime)}_${f.name}`);
    } else if (mode === 'rename-clean') {
      add(f, `${dirOf(f.rel)}${cleanName(f.name)}`);
    } else {
      throw new OrganizeError(`Unknown organize mode "${mode}".`);
    }
  }
  return moves;
}

// ---------- plan storage ----------
export class PlanStore {
  constructor(directory) {
    this.directory = directory;
  }
  file(id) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new OrganizeError('Invalid plan id.', 404);
    return path.join(this.directory, `${id}.json`);
  }
  async save(plan) {
    await fs.mkdir(this.directory, { recursive: true });
    const tmp = `${this.file(plan.id)}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(plan), 'utf8');
    await fs.rename(tmp, this.file(plan.id));
    return plan;
  }
  async load(userId, id) {
    let plan;
    try {
      plan = JSON.parse(await fs.readFile(this.file(id), 'utf8'));
    } catch {
      throw new OrganizeError('This plan was not found. Ask again to create a new plan.', 404);
    }
    if (plan.userId !== userId) throw new OrganizeError('This plan was not found.', 404);
    return plan;
  }
}

export async function createPlan(store, { userId, root, mode, recursive = false }) {
  const { files, truncated } = await scanFolder(root, { recursive });
  const moves = await buildMoves(root, files, mode);
  const plan = {
    id: crypto.randomUUID(),
    userId,
    root,
    mode,
    recursive,
    status: 'pending',
    scanned: files.length,
    truncated,
    moves,
    applied: [],
    failed: [],
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  };
  return store.save(plan);
}

async function exists(p) {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function safePath(root, rel) {
  const abs = path.resolve(root, rel);
  if (!within(root, abs) || abs === root) throw new OrganizeError('A path left the chosen folder.');
  // No component of the path may be a link (no escaping through junctions).
  let current = root;
  for (const part of path.relative(root, abs).split(path.sep).slice(0, -1)) {
    current = path.join(current, part);
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) throw new OrganizeError('A folder in the path is a link.');
    } catch (e) {
      if (e instanceof OrganizeError) throw e;
      break; // does not exist yet: fine, it will be created
    }
  }
  return abs;
}

export async function applyPlan(store, userId, id) {
  const plan = await store.load(userId, id);
  if (plan.status !== 'pending')
    throw new OrganizeError(`This plan was already ${plan.status}.`, 409);
  if (Date.parse(plan.expiresAt) < Date.now())
    throw new OrganizeError('This plan expired. Ask again to create a fresh plan.', 410);
  plan.status = 'applying';
  await store.save(plan);
  const createdDirs = new Set();
  for (const move of plan.moves) {
    try {
      const from = await safePath(plan.root, move.from);
      let toRel = move.to;
      let to = await safePath(plan.root, toRel);
      const stat = await fs.lstat(from).catch(() => null);
      if (!stat || !stat.isFile()) throw new OrganizeError('File no longer exists.');
      for (let n = 2; await exists(to); n++) {
        const ext = path.posix.extname(move.to);
        toRel = `${move.to.slice(0, move.to.length - ext.length)} (${n})${ext}`;
        to = await safePath(plan.root, toRel);
      }
      // Remember which folders we create so undo can remove them if left empty.
      let dir = path.dirname(to);
      const missing = [];
      while (within(plan.root, dir) && dir !== plan.root && !(await exists(dir))) {
        missing.push(dir);
        dir = path.dirname(dir);
      }
      await fs.mkdir(path.dirname(to), { recursive: true });
      missing.forEach((d) => createdDirs.add(path.relative(plan.root, d).split(path.sep).join('/')));
      await fs.rename(from, to);
      plan.applied.push({ from: move.from, to: toRel });
    } catch (error) {
      plan.failed.push({ from: move.from, to: move.to, reason: error instanceof OrganizeError ? error.message : error.code || 'move failed' });
    }
  }
  plan.createdDirs = [...createdDirs];
  plan.status = 'applied';
  plan.appliedAt = new Date().toISOString();
  return store.save(plan);
}

export async function undoPlan(store, userId, id) {
  const plan = await store.load(userId, id);
  if (plan.status !== 'applied') throw new OrganizeError(`Only an applied plan can be undone (this one is ${plan.status}).`, 409);
  const restored = [];
  const failed = [];
  for (const move of [...plan.applied].reverse()) {
    try {
      const current = await safePath(plan.root, move.to);
      const original = await safePath(plan.root, move.from);
      if (!(await exists(current))) throw new OrganizeError('File was moved or removed since.');
      if (await exists(original)) throw new OrganizeError('A file with the original name exists now.');
      await fs.mkdir(path.dirname(original), { recursive: true });
      await fs.rename(current, original);
      restored.push(move);
    } catch (error) {
      failed.push({ ...move, reason: error instanceof OrganizeError ? error.message : error.code || 'undo failed' });
    }
  }
  // Remove only folders this plan created, and only when empty (deepest first).
  for (const rel of [...(plan.createdDirs || [])].sort((a, b) => b.length - a.length)) {
    try {
      await fs.rmdir(await safePath(plan.root, rel));
    } catch {
      /* not empty or already gone */
    }
  }
  plan.status = 'undone';
  plan.undoneAt = new Date().toISOString();
  plan.undo = { restored: restored.length, failed };
  return store.save(plan);
}

const fmtSize = (n) =>
  n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

const MODE_TEXT = {
  type: 'by file type',
  extension: 'by file extension',
  date: 'by modified date (year / month)',
  duplicates: 'moving exact duplicate files to _Duplicates (the oldest copy stays)',
  'rename-date': 'adding the modified date to each file name',
  'rename-clean': 'cleaning file names (spaces, symbols)',
};

export function describePlan(plan) {
  const lines = [];
  lines.push(`### Folder plan — ${MODE_TEXT[plan.mode] || plan.mode}`);
  lines.push(`**Folder:** \`${plan.root}\`${plan.recursive ? ' (including subfolders)' : ''}`);
  if (!plan.moves.length) {
    lines.push('', `Scanned ${plan.scanned} file(s). Nothing needs to change.`);
    return lines.join('\n');
  }
  const groups = new Map();
  for (const m of plan.moves) {
    const key = plan.mode.startsWith('rename') ? 'Renamed in place' : path.posix.dirname(m.to);
    groups.set(key, (groups.get(key) || 0) + 1);
  }
  lines.push('', `Scanned ${plan.scanned} file(s)${plan.truncated ? ' (first 5,000 only)' : ''}. **${plan.moves.length} file(s) will change:**`, '');
  for (const [dest, count] of [...groups.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20))
    lines.push(`- \`${dest}\` — ${count} file(s)`);
  lines.push('', '| Current | New |', '| --- | --- |');
  for (const m of plan.moves.slice(0, 25)) lines.push(`| ${m.from.replace(/\|/g, '\\|')} | ${m.to.replace(/\|/g, '\\|')} |`);
  if (plan.moves.length > 25) lines.push('', `…and ${plan.moves.length - 25} more.`);
  const total = plan.moves.reduce((n, m) => n + (m.size || 0), 0);
  lines.push(
    '',
    `Nothing is deleted. Files are only moved/renamed inside this folder (${fmtSize(total)}), and you can undo afterwards. The plan is valid for 1 hour.`,
    '',
    `[Apply this plan](#chanakya-plan-apply=${plan.id})`,
  );
  return lines.join('\n');
}
