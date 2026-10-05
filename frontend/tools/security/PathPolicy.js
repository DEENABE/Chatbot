import fs from 'node:fs';
import path from 'node:path';
const fail = code => { throw Object.assign(new Error(code), { code }); };
const inside = (root, target) => target.toLowerCase() === root.toLowerCase() || target.toLowerCase().startsWith(root.toLowerCase().replace(/[\\/]+$/, '') + path.sep);
const sensitive = /(?:^|[\\/])(?:\.ssh|\.aws|\.azure|\.gnupg|\.kube|credentials?|secrets?|tokens?|vault|sam|security|protect|credentials|login data|local state|cookies|web data|key[34]\.db|logins\.json|\.env(?:\..*)?|id_rsa|id_ed25519)(?:[\\/]|$)|\.(?:pem|key|pfx|p12|kdbx)$/i;
const system = /^[a-z]:[\\/](?:windows|program files(?: \(x86\))?|programdata|\$recycle\.bin|system volume information)(?:[\\/]|$)/i;
/** Fail closed for aliases and link components, including nonexistent destinations. */
export class PathPolicy {
  constructor({ readRoots = [], writeRoots = [] } = {}) { this.readRoots = [...readRoots]; this.writeRoots = [...writeRoots]; }
  canonical(input) {
    if (typeof input !== 'string' || input.length > 4096 || !path.isAbsolute(input) ||
        /^[\\/]{2}/.test(input) || /[\x00-\x1f%~<>"|?*]/.test(input) || /(^|[\\/])\.\.?(?:[\\/]|$)/.test(input) ||
        input.slice(2).includes(':') || input.split(/[\\/]/).some(s => /[. ]$/.test(s) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s))) fail('DISALLOWED_PATH');
    const absolute = path.resolve(input);
    let current = path.parse(absolute).root;
    for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      try {
        const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink() || stat.isFile() && stat.nlink > 1) fail('DISALLOWED_PATH');
        const real = fs.realpathSync.native(current);
        if (real.toLowerCase() !== current.toLowerCase()) fail('DISALLOWED_PATH');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return absolute;
  }
  validate(input, { write = false } = {}) {
    const resolved = this.canonical(input);
    if (sensitive.test(resolved)) fail(write ? 'DISALLOWED_PATH' : 'SENSITIVE_READ');
    if (system.test(resolved)) fail('DISALLOWED_PATH');
    const roots = write ? this.writeRoots : this.readRoots;
    if (!roots.some(root => inside(this.canonical(root), resolved))) fail('DISALLOWED_PATH');
    return resolved;
  }
  validateParameters(name, params) {
    if (name === 'file.createTextFile' && !/\.(txt|md|json|csv)$/i.test(params.path)) fail('INVALID_TARGET');
    const write = ['file.writeFile','file.deleteFile','file.moveFile','file.createTextFile','file.createDirectory'].includes(name);
    for (const key of ['path','source','destination']) if (params[key] !== undefined) this.validate(params[key], { write: key === 'destination' || (key === 'source' ? name === 'file.moveFile' : write) });
    if (name === 'file.deleteFile' && params.recursive === true) fail('CRITICAL_OPERATION');
    // Recursive copies/moves need a bounded tree contract; never classify them safe.
    if (['file.copyFile','file.moveFile'].includes(name) && !fs.lstatSync(params.source).isFile()) fail('INVALID_TARGET');
    if (['file.createTextFile','file.createDirectory'].includes(name) && fs.existsSync(params.path)) fail('INVALID_TARGET');
  }
}
