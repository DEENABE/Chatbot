import path from 'node:path';
import { relativeWorkspacePath, workspaceError } from './WorkspaceFiles.js';

const pathTools = new Set([
  'fs.list',
  'fs.read',
  'fs.mkdir',
  'fs.write',
  'fs.patch',
  'fs.delete',
  'code.search',
  'code.symbols',
  'code.diff',
]);
const directoryTools = new Set(['fs.list', 'fs.mkdir', 'code.search', 'code.diff']);
const rootTools = new Set([
  'fs.list',
  'code.search',
  'code.diff',
  'exec.run',
  'exec.start',
  'tests.run',
  'deps.install',
]);
const denied = () =>
  workspaceError('WORKSPACE_PATH_DENIED', 'Use a path inside the selected project folder.');

/** Adapt model path spelling, never the bound workspace or the native guard's authority. */
export function codingWorkspacePath(value, root, { allowRoot = false, directory = false } = {}) {
  if (typeof value !== 'string' || !root || value.length > 4096 || /[\x00-\x1f]/.test(value))
    throw denied();
  let name = value.replaceAll('\\', '/');
  if (name.startsWith('//') || /(?:^|\/)\.\.(?:\/|$)/.test(name)) throw denied();
  while (name.startsWith('./')) name = name.slice(2);
  if (name === '.') name = '';
  if (directory) {
    if (name !== '/' && !/^[a-z]:\/$/i.test(name)) name = name.replace(/\/$/, '');
  } else if (name.endsWith('/')) throw denied();
  // Reject aliases before path.relative can silently collapse their spelling.
  if (/(?:^|\/)\.(?:\/|$)/.test(name) || name.includes('//')) throw denied();
  const windowsRoot = /^[a-z]:[\\/]/i.test(root);
  const windowsAbsolute = /^[a-z]:\//i.test(name);
  const absolute = windowsAbsolute || name.startsWith('/');
  if (absolute) {
    if (windowsRoot !== windowsAbsolute) throw denied();
    const paths = windowsRoot ? path.win32 : path.posix;
    const relative = paths.relative(root, name);
    if (relative === '..' || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative))
      throw denied();
    name = relative.replaceAll('\\', '/');
  }
  return relativeWorkspacePath(name, { allowEmpty: allowRoot });
}

export function normalizeCodingPaths(request, root) {
  const field =
    pathTools.has(request.tool) || request.tool === 'preview.start'
      ? 'path'
      : ['exec.run', 'exec.start', 'tests.run', 'deps.install'].includes(request.tool)
        ? 'cwd'
        : null;
  if (!field || !Object.hasOwn(request.params, field)) return request;
  return {
    ...request,
    params: {
      ...request.params,
      [field]: codingWorkspacePath(request.params[field], root, {
        allowRoot: rootTools.has(request.tool),
        directory: field === 'cwd' || directoryTools.has(request.tool),
      }),
    },
  };
}
