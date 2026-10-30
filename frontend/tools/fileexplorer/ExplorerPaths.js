import fs from 'node:fs/promises';
import path from 'node:path';
import { explorerError } from './errors.js';

// Names that never open: credential stores, key material, secrets.
const SENSITIVE =
  /(?:^|[\\/])(?:\.ssh|\.aws|\.azure|\.gnupg|\.kube|\.docker|credentials?|secrets?|tokens?|vault|id_rsa|id_ed25519|ntds\.dit)(?:[\\/]|$)|(?:^|[\\/])\.env(?:\.[^\\/]*)?$|\.(?:pem|key|pfx|p12|kdbx)$|[\\/]appdata[\\/][^\\/]+[\\/][^\\/]+[\\/](?:credentials|protect)(?:[\\/]|$)|[\\/]config[\\/](?:sam|security|system|software)$/i;
// Windows system trees. Listing a drive root shows them as protected; they cannot be entered.
const SYSTEM =
  /^[a-z]:[\\/](?:windows|program files(?: \(x86\))?|programdata|\$recycle\.bin|system volume information|recovery|\$windows\.~bt)(?:[\\/]|$)/i;
const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

/**
 * Central path policy for the explorer tools. Every tool resolves its paths here and nothing else
 * touches the filesystem with a model-supplied string.
 */
export class ExplorerPathGuard {
  constructor({ roots, fsImpl = fs, pathImpl = path, platform = process.platform } = {}) {
    Object.assign(this, { roots, fsImpl, pathImpl, platform });
  }
  /** Syntax only: no filesystem access. */
  canonicalize(input) {
    const { pathImpl: p, platform } = this;
    const win = platform === 'win32';
    if (
      typeof input !== 'string' ||
      !input ||
      input.length > 4096 ||
      /[\x00-\x1f]/.test(input) ||
      !p.isAbsolute(input) ||
      (win && (/^[\\/]{2}/.test(input) || /[<>"|?*]/.test(input) || input.slice(2).includes(':')))
    )
      throw explorerError('DISALLOWED_PATH', 'Use a full local path such as C:\\Projects.');
    const parts = input.split(/[\\/]+/).filter(Boolean);
    if (
      parts.some(
        (part) =>
          part === '..' ||
          part === '.' ||
          (win && (/[. ]$/.test(part) || RESERVED.test(part.replace(/^[a-z]:$/i, '')))),
      )
    )
      throw explorerError(
        'DISALLOWED_PATH',
        'Relative segments and reserved names are not allowed.',
      );
    let resolved = p.resolve(input);
    if (win && /^[a-z]:/.test(resolved)) resolved = resolved[0].toUpperCase() + resolved.slice(1);
    return resolved;
  }
  classify(resolved) {
    if (SENSITIVE.test(resolved)) return 'sensitive';
    if (this.platform === 'win32' && SYSTEM.test(resolved)) return 'system';
    return null;
  }
  isProtected(resolved) {
    return this.classify(resolved) !== null;
  }
  /** Rejects links (symlinks and Windows junctions both report as links) on every component. */
  async assertNoLinks(resolved, { allowMissingTail = false } = {}) {
    const { pathImpl: p } = this;
    let current = p.parse(resolved).root;
    for (const part of resolved.slice(current.length).split(p.sep).filter(Boolean)) {
      current = p.join(current, part);
      try {
        const info = await this.fsImpl.lstat(current);
        if (info.isSymbolicLink())
          throw explorerError('LINK_NOT_FOLLOWED', `"${current}" is a link and is not followed.`);
      } catch (error) {
        if (error.code === 'ENOENT' && allowMissingTail) return;
        if (error.code === 'LINK_NOT_FOLLOWED') throw error;
        throw error.code === 'ENOENT'
          ? explorerError('NOT_FOUND', `"${current}" does not exist.`)
          : error;
      }
    }
  }
  /** Full check for one path: syntax, protection, approval for this scope, no links. */
  async resolve(scope, input, { protectedOk = false } = {}) {
    const resolved = this.canonicalize(input);
    if (!protectedOk && this.isProtected(resolved))
      throw explorerError(
        'PROTECTED_PATH',
        'This location holds system or credential data and cannot be opened.',
      );
    const root = this.roots.find(scope, resolved);
    if (!root)
      throw explorerError(
        'ROOT_NOT_APPROVED',
        `"${resolved}" is not inside an approved location. Ask the user to approve it first (explorer.approveRoot).`,
        { path: resolved },
      );
    await this.assertNoLinks(resolved);
    return { path: resolved, root };
  }
}
