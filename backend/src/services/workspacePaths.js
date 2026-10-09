import fs from 'node:fs/promises';
import path from 'node:path';

export const SUPPORTED_WORKSPACE_EXTENSIONS = new Set([
  '.pdf',
  '.docx',
  '.txt',
  '.md',
  '.csv',
  '.xlsx',
]);
const sensitive =
  /(?:^|[\\/])(?:\.ssh|\.aws|\.azure|\.gnupg|\.kube|credentials?|secrets?|tokens?|vault|\.env(?:\..*)?|id_rsa|id_ed25519)(?:[\\/]|$)|\.(?:pem|key|pfx|p12|kdbx)$/i;
const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const isWithin = (root, target) => {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
};

// Native dialog and API input pass through the same checks. Never follow links
// in a root or tree; a selected directory grants access only to that directory.
export async function validateWorkspaceRoot(input) {
  if (
    typeof input !== 'string' ||
    !input.trim() ||
    input.length > 4096 ||
    !path.isAbsolute(input) ||
    /^[\\/]{2}/.test(input) ||
    /[\x00-\x1f]/.test(input)
  ) {
    throw failure('Choose an absolute local directory.');
  }
  const resolved = path.resolve(input.trim());
  if (sensitive.test(resolved))
    throw failure('This directory contains protected credentials. Choose a document directory.');
  if (
    /^[a-z]:[\\/](?:windows|program files(?: \(x86\))?|programdata|\$recycle\.bin|system volume information)(?:[\\/]|$)/i.test(
      resolved,
    )
  )
    throw failure('Choose a personal document directory rather than a protected system directory.');
  try {
    let current = path.parse(resolved).root;
    for (const part of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      const info = await fs.lstat(current);
      if (info.isSymbolicLink())
        throw failure('Workspace directories cannot pass through a symbolic link.');
    }
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) throw failure('The workspace root must be a directory.');
    await fs.access(resolved, fs.constants.R_OK);
    return {
      root: await fs.realpath(resolved),
      name: path.basename(resolved) || 'Workspace',
    };
  } catch (error) {
    if (error.status) throw error;
    if (error.code === 'ENOENT')
      throw Object.assign(
        failure('This directory is unavailable. Reconnect the drive or choose another directory.'),
        { code: error.code },
      );
    if (['EACCES', 'EPERM'].includes(error.code))
      throw Object.assign(
        failure('Access to this directory was denied. Choose a directory you can read.'),
        { code: error.code },
      );
    throw error;
  }
}

export async function resolveWorkspaceFile(root, relativePath) {
  if (
    typeof relativePath !== 'string' ||
    !relativePath ||
    relativePath.length > 4096 ||
    /[\x00-\x1f]/.test(relativePath) ||
    path.isAbsolute(relativePath) ||
    /^[a-z]:/i.test(relativePath)
  )
    throw failure('Invalid workspace file path.');
  const normalized = relativePath.replace(/[\\/]/g, path.sep);
  const target = path.resolve(root, normalized);
  if (!isWithin(root, target) || sensitive.test(target))
    throw failure('This file is outside the workspace or is protected.');
  let current = root;
  for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if ((await fs.lstat(current)).isSymbolicLink())
      throw failure('Symbolic links cannot be indexed.');
  }
  const canonical = await fs.realpath(target);
  if (!isWithin(root, canonical)) throw failure('The file resolves outside the workspace.');
  const stat = await fs.stat(canonical);
  if (!stat.isFile()) throw failure('Choose a file to index.');
  return {
    path: canonical,
    originalname: path.basename(canonical),
    relativePath: path.relative(root, canonical).split(path.sep).join('/'),
    size: stat.size,
  };
}

export async function enumerateWorkspace(
  rootInput,
  { maxEntries = 10000, signal, onProgress } = {},
) {
  const { root } = await validateWorkspaceRoot(rootInput);
  const entries = [];
  const errors = [];
  let files = 0,
    directories = 0,
    supportedFiles = 0,
    totalBytes = 0;
  let truncated = false;
  const seen = new Set([root]);
  const walk = async (directory, depth) => {
    signal?.throwIfAborted();
    let children;
    try {
      children = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      errors.push({
        relativePath: path.relative(root, directory).split(path.sep).join('/'),
        code: error.code || 'READ_ERROR',
        message: 'This directory could not be read.',
      });
      return;
    }
    children.sort(
      (a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name),
    );
    for (const child of children) {
      signal?.throwIfAborted();
      if (entries.length >= maxEntries) {
        truncated = true;
        return;
      }
      const target = path.join(directory, child.name);
      const relativePath = path.relative(root, target).split(path.sep).join('/');
      try {
        if (sensitive.test(target)) {
          errors.push({
            relativePath,
            code: 'PROTECTED',
            message: 'Protected credentials were skipped.',
          });
          continue;
        }
        const stat = await fs.lstat(target);
        if (stat.isSymbolicLink()) {
          errors.push({
            relativePath,
            code: 'SYMLINK',
            message: 'Symbolic links were skipped to keep files inside the workspace.',
          });
          continue;
        }
        const real = await fs.realpath(target);
        if (!isWithin(root, real)) {
          errors.push({
            relativePath,
            code: 'OUTSIDE_ROOT',
            message: 'A file outside the workspace was skipped.',
          });
          continue;
        }
        const type = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';
        const supported =
          type === 'file' &&
          SUPPORTED_WORKSPACE_EXTENSIONS.has(path.extname(child.name).toLowerCase());
        entries.push({
          name: child.name,
          relativePath,
          parent: path.posix.dirname(relativePath) === '.' ? '' : path.posix.dirname(relativePath),
          depth,
          type,
          size: type === 'file' ? stat.size : 0,
          supported,
          modifiedAt: stat.mtime.toISOString(),
        });
        if (type === 'file') {
          files++;
          totalBytes += stat.size;
          if (supported) supportedFiles++;
        }
        if (type === 'directory') {
          directories++;
          if (!seen.has(real) && depth < 64) {
            seen.add(real);
            await walk(target, depth + 1);
          }
        }
        if (entries.length % 100 === 0) {
          onProgress?.({ files, directories, scanned: entries.length });
          await new Promise((resolve) => setImmediate(resolve));
        }
      } catch (error) {
        if (signal?.aborted) throw error;
        errors.push({
          relativePath,
          code: error.code || 'READ_ERROR',
          message: 'This entry could not be read.',
        });
      }
    }
  };
  await walk(root, 0);
  return {
    entries,
    errors,
    files,
    directories,
    supportedFiles,
    unsupportedFiles: files - supportedFiles,
    totalBytes,
    truncated,
  };
}
