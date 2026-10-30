import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fail, plain } from './contracts.js';
import { validateWorkspaceRoot } from '../services/workspacePaths.js';

// Windows reserved device names are invalid folder names even with an extension.
const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

/** One folder name only: no separators, traversal, reserved names or trailing dot/space. */
export function validateProjectName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (
    !name ||
    name.length > 64 ||
    !/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(name) ||
    name.includes('..') ||
    /[. ]$/.test(name) ||
    RESERVED.test(name)
  )
    throw fail(
      'INVALID_PROJECT_NAME',
      'Use 1-64 letters, numbers, spaces, dots, dashes or underscores, starting with a letter or number.',
    );
  return name;
}

export const defaultProjectsRoot = (home = os.homedir()) =>
  path.join(home, 'Documents', 'ChanakyaProjects');

/**
 * Creates a brand-new project folder and registers it as a workspace. It never
 * writes into a non-empty folder and never creates more than the single project
 * directory below an existing, validated parent.
 */
export async function createProjectWorkspace(
  userId,
  input,
  { save, validateRoot = validateWorkspaceRoot, home = os.homedir() } = {},
) {
  if (!plain(input) || Object.keys(input).some((key) => !['name', 'parent'].includes(key)))
    throw fail('INVALID_PROJECT', 'Send a project name and an optional parent folder.');
  const name = validateProjectName(input.name);
  let parentPath = input.parent;
  if (parentPath === undefined || parentPath === null || parentPath === '') {
    parentPath = defaultProjectsRoot(home);
    await fs.mkdir(parentPath, { recursive: true }).catch((error) => {
      throw fail('PROJECT_PARENT_INVALID', `Cannot prepare ${parentPath}: ${error.message}`, 500);
    });
  } else if (typeof parentPath !== 'string') {
    throw fail('INVALID_PROJECT', 'The parent folder must be a path.');
  }
  let parent;
  try {
    parent = await validateRoot(parentPath);
  } catch (error) {
    throw fail('PROJECT_PARENT_INVALID', error.message, error.status || 400);
  }
  const target = path.join(parent.root, name);
  if (path.dirname(target) !== parent.root)
    throw fail('INVALID_PROJECT_NAME', 'The project must be a single folder.');
  let created = false;
  try {
    await fs.mkdir(target);
    created = true;
  } catch (error) {
    if (error.code !== 'EEXIST')
      throw fail(
        'PROJECT_CREATE_FAILED',
        `Could not create the project folder: ${error.message}`,
        500,
      );
    const info = await fs.lstat(target);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw fail('PROJECT_EXISTS', `"${name}" already exists and is not a normal folder.`, 409);
    if ((await fs.readdir(target)).length)
      throw fail(
        'PROJECT_DIR_NOT_EMPTY',
        `A folder named "${name}" already exists and is not empty. Choose another name, or connect it as an existing project.`,
        409,
      );
  }
  try {
    // Loaded lazily: the workspace service opens the application database.
    save ||= (await import('../services/workspaceService.js')).saveWorkspace;
    const workspace = await save(userId, { name, root: target });
    return { workspace, created, root: target };
  } catch (error) {
    // Only remove a folder this call created, and only while it is still empty.
    if (created) await fs.rmdir(target).catch(() => {});
    throw error.code ? error : fail('PROJECT_CREATE_FAILED', error.message, error.status || 500);
  }
}
