/**
 * @fileoverview File management tool service for the Tool Engine.
 * Provides actions for reading, writing, listing, searching, copying,
 * moving, and deleting files and directories.
 *
 * @module tools/services/FileService
 */

import fs from 'fs/promises';
import { constants as fsConstants } from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { BaseToolService } from '../BaseToolService.js';

/** Maximum file size allowed for reading (10 MB). */
const MAX_READ_SIZE = 10 * 1024 * 1024;

/** Maximum entries returned by listDir. */
const MAX_LIST_ENTRIES = 1000;

/** Default maximum search results. */
const DEFAULT_MAX_RESULTS = 100;

/**
 * Converts a simple glob pattern to a RegExp.
 * Supports `*` (any chars) and `?` (single char).
 *
 * @param {string} pattern - Glob pattern string.
 * @returns {RegExp} Compiled regular expression.
 */
function globToRegex(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regexStr = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${regexStr}$`, 'i');
}

/**
 * FileService provides file-system operations as tool actions.
 *
 * @extends BaseToolService
 */
export class FileService extends BaseToolService {
  constructor(confirmationGate) {
    super('file', confirmationGate);
  }

  /**
   * Returns the action definitions for this service.
   *
   * @returns {Object} Map of action names to their configuration.
   */
  get actions() {
    return {
      open: {
        handler: this.openTarget.bind(this),
        schema: {
          target: { type: 'string', required: true }
        },
        destructive: false,
        description: 'Open a file, folder, drive, or application in Windows with its default handler. Examples: target "C:\\\\" opens the C drive in File Explorer, target "notepad" opens Notepad, target of a document path opens it in its default app. Use this whenever the user says "open ...", "launch ...", "show me ... folder", or "run ...".'
      },
      readFile: {
        handler: this.readFile.bind(this),
        schema: {
          path: { type: 'path', required: true },
          encoding: { type: 'string', required: false }
        },
        destructive: false,
        description: 'Read the contents of a file'
      },
      writeFile: {
        handler: this.writeFile.bind(this),
        schema: {
          path: { type: 'path', required: true },
          content: { type: 'string', required: true },
          encoding: { type: 'string', required: false }
        },
        destructive: true,
        description: 'Write content to a file, overwriting existing content'
      },
      listDir: {
        handler: this.listDir.bind(this),
        schema: {
          path: { type: 'path', required: true },
          recursive: { type: 'boolean', required: false }
        },
        destructive: false,
        description: 'List directory contents with file metadata'
      },
      fileInfo: {
        handler: this.fileInfo.bind(this),
        schema: {
          path: { type: 'path', required: true }
        },
        destructive: false,
        description: 'Get detailed file or directory information'
      },
      deleteFile: {
        handler: this.deleteFile.bind(this),
        schema: {
          path: { type: 'path', required: true },
          recursive: { type: 'boolean', required: false }
        },
        destructive: true,
        description: 'Delete a file or directory'
      },
      copyFile: {
        handler: this.copyFile.bind(this),
        schema: {
          source: { type: 'path', required: true },
          destination: { type: 'path', required: true }
        },
        destructive: false,
        description: 'Copy a file or directory to a new location'
      },
      moveFile: {
        handler: this.moveFile.bind(this),
        schema: {
          source: { type: 'path', required: true },
          destination: { type: 'path', required: true }
        },
        destructive: true,
        description: 'Move or rename a file or directory'
      },
      searchFiles: {
        handler: this.searchFiles.bind(this),
        schema: {
          path: { type: 'path', required: true },
          pattern: { type: 'string', required: true },
          maxResults: { type: 'number', required: false }
        },
        destructive: false,
        description: 'Search for files matching a glob pattern'
      }
    };
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  /**
   * Opens a file, folder, drive, or application using the Windows default
   * handler (Start-Process). Non-destructive — runs immediately so "open X"
   * requests just work without a confirmation prompt.
   *
   * @param {Object} params
   * @param {string} params.target - A path (e.g. "C:\\", a file) or app name (e.g. "notepad").
   * @returns {Promise<{opened: string}>}
   */
  openTarget(params) {
    const target = String(params.target || '').trim();
    if (!target) {
      throw new Error('A target path or application name is required.');
    }
    const escaped = target.replace(/'/g, "''");
    return new Promise((resolve, reject) => {
      let stderr = '';
      const proc = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `Start-Process -FilePath '${escaped}'`],
        { windowsHide: true }
      );
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('error', (err) => reject(new Error(`Failed to open '${target}': ${err.message}`)));
      proc.on('close', (code) => {
        if (code === 0) resolve({ opened: target });
        else reject(new Error(stderr.trim() || `Could not open '${target}'. Check the path or name.`));
      });
    });
  }

  /**
   * Reads a file and returns its content.
   *
   * @param {Object} params
   * @param {string} params.path - Absolute path to the file.
   * @param {string} [params.encoding='utf-8'] - File encoding.
   * @returns {Promise<{content: string, size: number, encoding: string}>}
   * @throws {Error} If the file exceeds the 10 MB size limit.
   */
  async readFile(params) {
    const filePath = path.resolve(params.path);
    const encoding = params.encoding || 'utf-8';

    const stat = await fs.stat(filePath);

    if (!stat.isFile()) {
      throw new Error(`Path is not a file: ${filePath}`);
    }

    if (stat.size > MAX_READ_SIZE) {
      throw new Error(
        `File size (${stat.size} bytes) exceeds the 10 MB limit. ` +
        `Use a streaming approach for large files.`
      );
    }

    const content = await fs.readFile(filePath, { encoding });

    return {
      content,
      size: stat.size,
      encoding
    };
  }

  /**
   * Writes content to a file, creating parent directories as needed.
   *
   * @param {Object} params
   * @param {string} params.path - Absolute path to write to.
   * @param {string} params.content - Content to write.
   * @param {string} [params.encoding='utf-8'] - File encoding.
   * @returns {Promise<{path: string, bytesWritten: number}>}
   */
  async writeFile(params) {
    const filePath = path.resolve(params.path);
    const encoding = params.encoding || 'utf-8';

    // Ensure parent directory exists
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    await fs.writeFile(filePath, params.content, { encoding });

    const stat = await fs.stat(filePath);

    return {
      path: filePath,
      bytesWritten: stat.size
    };
  }

  /**
   * Returns the confirmation message for destructive actions.
   *
   * @param {string} action - The action name.
   * @param {Object} params - The action parameters.
   * @returns {string|null} Confirmation message or null if not destructive.
   */
  getConfirmationMessage(action, params) {
    switch (action) {
      case 'writeFile':
        return `Write to ${params.path}? This will overwrite existing content.`;
      case 'deleteFile':
        return `Delete ${params.path}? This cannot be undone.`;
      case 'moveFile':
        return `Move ${params.source} to ${params.destination}?`;
      default:
        return null;
    }
  }

  /**
   * Lists directory entries with stat information.
   *
   * @param {Object} params
   * @param {string} params.path - Directory to list.
   * @param {boolean} [params.recursive=false] - Whether to recurse into subdirectories.
   * @returns {Promise<{entries: Array, totalEntries: number, truncated: boolean}>}
   */
  async listDir(params) {
    const dirPath = path.resolve(params.path);
    const recursive = params.recursive || false;
    const entries = [];

    await this._walkDir(dirPath, recursive, entries);

    const truncated = entries.length > MAX_LIST_ENTRIES;
    const result = entries.slice(0, MAX_LIST_ENTRIES);

    return {
      entries: result,
      totalEntries: entries.length,
      truncated
    };
  }

  /**
   * Gets detailed stat info for a file or directory.
   *
   * @param {Object} params
   * @param {string} params.path - Path to inspect.
   * @returns {Promise<{name: string, path: string, type: string, size: number, created: string, modified: string, accessed: string, permissions: string}>}
   */
  async fileInfo(params) {
    const filePath = path.resolve(params.path);
    const stat = await fs.stat(filePath);

    return {
      name: path.basename(filePath),
      path: filePath,
      type: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other',
      size: stat.size,
      created: stat.birthtime.toISOString(),
      modified: stat.mtime.toISOString(),
      accessed: stat.atime.toISOString(),
      permissions: (stat.mode & 0o777).toString(8)
    };
  }

  /**
   * Deletes a file or directory.
   *
   * @param {Object} params
   * @param {string} params.path - Path to delete.
   * @param {boolean} [params.recursive=false] - Delete directories recursively.
   * @returns {Promise<{deleted: string}>}
   */
  async deleteFile(params) {
    const filePath = path.resolve(params.path);

    await fs.rm(filePath, {
      recursive: params.recursive || false,
      force: false
    });

    return { deleted: filePath };
  }

  /**
   * Copies a file or directory.
   *
   * @param {Object} params
   * @param {string} params.source - Source path.
   * @param {string} params.destination - Destination path.
   * @returns {Promise<{source: string, destination: string}>}
   */
  async copyFile(params) {
    const source = path.resolve(params.source);
    const destination = path.resolve(params.destination);

    const stat = await fs.stat(source);

    if (stat.isDirectory()) {
      await fs.cp(source, destination, { recursive: true });
    } else {
      // Ensure destination parent exists
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(source, destination);
    }

    return { source, destination };
  }

  /**
   * Moves (renames) a file or directory.
   *
   * @param {Object} params
   * @param {string} params.source - Source path.
   * @param {string} params.destination - Destination path.
   * @returns {Promise<{source: string, destination: string}>}
   */
  async moveFile(params) {
    const source = path.resolve(params.source);
    const destination = path.resolve(params.destination);

    // Ensure destination parent exists
    await fs.mkdir(path.dirname(destination), { recursive: true });

    await fs.rename(source, destination);

    return { source, destination };
  }

  /**
   * Searches for files matching a glob pattern.
   *
   * @param {Object} params
   * @param {string} params.path - Root directory to search.
   * @param {string} params.pattern - Glob pattern (supports * and ?).
   * @param {number} [params.maxResults=100] - Maximum results to return.
   * @returns {Promise<{matches: Array<{path: string, name: string, size: number}>, totalFound: number}>}
   */
  async searchFiles(params) {
    const searchPath = path.resolve(params.path);
    const maxResults = params.maxResults || DEFAULT_MAX_RESULTS;
    const regex = globToRegex(params.pattern);
    const matches = [];

    await this._searchWalk(searchPath, regex, matches);

    return {
      matches: matches.slice(0, maxResults),
      totalFound: matches.length
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Recursively walks a directory collecting entry metadata.
   *
   * @param {string} dirPath - Directory to walk.
   * @param {boolean} recursive - Whether to recurse.
   * @param {Array} entries - Accumulator for entries.
   * @private
   */
  async _walkDir(dirPath, recursive, entries) {
    let dirEntries;
    try {
      dirEntries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch (err) {
      throw new Error(`Cannot read directory: ${dirPath} — ${err.message}`);
    }

    for (const dirent of dirEntries) {
      if (entries.length >= MAX_LIST_ENTRIES + 1) {
        return; // Stop collecting once we know we exceeded the limit
      }

      const fullPath = path.join(dirPath, dirent.name);

      try {
        const stat = await fs.stat(fullPath);
        entries.push({
          name: dirent.name,
          path: fullPath,
          type: dirent.isDirectory() ? 'directory' : 'file',
          size: stat.size,
          modified: stat.mtime.toISOString(),
          created: stat.birthtime.toISOString()
        });

        if (recursive && dirent.isDirectory()) {
          await this._walkDir(fullPath, recursive, entries);
        }
      } catch {
        // Skip entries we can't stat (e.g. permission denied, broken symlinks)
      }
    }
  }

  /**
   * Recursively searches for files matching a regex pattern.
   *
   * @param {string} dirPath - Directory to search.
   * @param {RegExp} regex - Pattern to match filenames against.
   * @param {Array} matches - Accumulator for matches.
   * @private
   */
  async _searchWalk(dirPath, regex, matches) {
    let dirEntries;
    try {
      dirEntries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch {
      return; // Skip directories we can't read
    }

    for (const dirent of dirEntries) {
      const fullPath = path.join(dirPath, dirent.name);

      if (dirent.isDirectory()) {
        await this._searchWalk(fullPath, regex, matches);
      } else if (regex.test(dirent.name)) {
        try {
          const stat = await fs.stat(fullPath);
          matches.push({
            path: fullPath,
            name: dirent.name,
            size: stat.size
          });
        } catch {
          // Skip files we can't stat
        }
      }
    }
  }
}

export default FileService;

