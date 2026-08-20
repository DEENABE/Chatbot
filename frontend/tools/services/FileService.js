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
 * PowerShell resolver used by `FileService.openTarget`.
 *
 * Reads its input from $env:CHANAKYA_OPEN_TARGET — never from interpolated
 * script text — so the target string is data, not code.
 *
 * Prints "OK|<via>|<resolved>" on success; writes an error and exits 1 when
 * nothing matches, so the caller can tell "not found" from "launch failed".
 */
const OPEN_TARGET_SCRIPT = `
$ErrorActionPreference = 'Stop'
$t = $env:CHANAKYA_OPEN_TARGET
if ([string]::IsNullOrWhiteSpace($t)) { Write-Error 'No target supplied.'; exit 1 }
$t = $t.Trim()

function Invoke-Target([string]$Path, [string]$Arg) {
  try {
    if ($Arg) { Start-Process -FilePath $Path -ArgumentList $Arg | Out-Null }
    else      { Start-Process -FilePath $Path | Out-Null }
    return $true
  } catch { return $false }
}

# 0. Explicit path, UNC share, URL or protocol handler (ms-settings:, mailto:).
if ($t -match '^[a-zA-Z]:[\\\\/]' -or $t -match '^\\\\\\\\' -or $t -match '^[a-zA-Z][a-zA-Z0-9+.\\-]*:') {
  if (Invoke-Target $t) { Write-Output "OK|path|$t"; exit 0 }
}

$key = $t.ToLowerInvariant()

# 1. Friendly names people actually type -> the executable Windows knows.
$alias = @{
  'chrome'='chrome.exe'; 'google chrome'='chrome.exe'; 'browser'='msedge.exe'
  'edge'='msedge.exe'; 'microsoft edge'='msedge.exe'; 'firefox'='firefox.exe'
  'brave'='brave.exe'; 'opera'='opera.exe'
  'word'='winword.exe'; 'microsoft word'='winword.exe'; 'ms word'='winword.exe'
  'excel'='excel.exe'; 'microsoft excel'='excel.exe'; 'ms excel'='excel.exe'
  'powerpoint'='powerpnt.exe'; 'ppt'='powerpnt.exe'
  'outlook'='outlook.exe'; 'access'='msaccess.exe'; 'onenote'='onenote.exe'
  'vscode'='code.cmd'; 'vs code'='code.cmd'; 'visual studio code'='code.cmd'; 'code'='code.cmd'
  'notepad'='notepad.exe'; 'wordpad'='write.exe'; 'paint'='mspaint.exe'
  'calculator'='calc.exe'; 'calc'='calc.exe'
  'cmd'='cmd.exe'; 'command prompt'='cmd.exe'; 'terminal'='wt.exe'; 'windows terminal'='wt.exe'
  'powershell'='powershell.exe'; 'pwsh'='pwsh.exe'
  'explorer'='explorer.exe'; 'file explorer'='explorer.exe'; 'files'='explorer.exe'
  'task manager'='taskmgr.exe'; 'taskmgr'='taskmgr.exe'
  'device manager'='devmgmt.msc'; 'disk management'='diskmgmt.msc'
  'services'='services.msc'; 'event viewer'='eventvwr.msc'
  'computer management'='compmgmt.msc'; 'performance monitor'='perfmon.exe'
  'resource monitor'='resmon.exe'; 'system information'='msinfo32.exe'
  'registry editor'='regedit.exe'; 'regedit'='regedit.exe'
  'control panel'='control.exe'; 'control'='control.exe'
  'settings'='ms-settings:'; 'windows settings'='ms-settings:'
  'snipping tool'='snippingtool.exe'; 'snip'='snippingtool.exe'
  'notepad++'='notepad++.exe'; 'sublime'='sublime_text.exe'
  'spotify'='spotify.exe'; 'discord'='discord.exe'; 'steam'='steam.exe'
  'vlc'='vlc.exe'; 'zoom'='zoom.exe'; 'slack'='slack.exe'
  'teams'='ms-teams.exe'; 'microsoft teams'='ms-teams.exe'
  'photoshop'='photoshop.exe'; 'obs'='obs64.exe'; 'git bash'='git-bash.exe'
}
if ($alias.ContainsKey($key)) {
  if (Invoke-Target $alias[$key]) { Write-Output "OK|alias|$($alias[$key])"; exit 0 }
}

# 2. Anything already on PATH.
$cmd = Get-Command -Name $t -ErrorAction SilentlyContinue | Select-Object -First 1
if ($cmd -and $cmd.Source) {
  if (Invoke-Target $cmd.Source) { Write-Output "OK|path-env|$($cmd.Source)"; exit 0 }
}

# 3. App Paths registry - this is how Win+R resolves "chrome" without PATH.
foreach ($name in @($t, "$t.exe")) {
  foreach ($hive in @('HKLM:', 'HKCU:')) {
    $reg = Join-Path $hive "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\$name"
    if (Test-Path -LiteralPath $reg) {
      $exe = (Get-ItemProperty -LiteralPath $reg).'(default)'
      if ($exe -and (Invoke-Target $exe)) { Write-Output "OK|app-paths|$exe"; exit 0 }
    }
  }
}

# 4. Start menu, which is the only place Store/UWP apps are listed.
try {
  $apps = @(Get-StartApps -ErrorAction Stop)
  $ordered = @()
  $ordered += @($apps | Where-Object { $_.Name -ieq $t })
  $ordered += @($apps | Where-Object { $_.Name -ilike "$t*" })
  $ordered += @($apps | Where-Object { $_.Name -ilike "*$t*" })
  foreach ($app in $ordered) {
    if (Invoke-Target 'explorer.exe' ("shell:AppsFolder\\" + $app.AppID)) {
      Write-Output "OK|start-menu|$($app.Name)"; exit 0
    }
  }
} catch { }

Write-Error "No application, file or folder matching '$t' was found."
exit 1
`;

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
 * Same boundary the existing dangerGuard/dangerClassifier blocklists draw
 * for PowerShell text commands, applied here to FileService's structured
 * path parameters — InputValidator.validatePath() only rejects traversal
 * and malformed paths, it says nothing about *which* absolute path is safe
 * to write/delete/move. Scoped to the Windows system directory specifically
 * (not Program Files) so legitimate repair work — fixing an app's own
 * files — isn't blocked alongside it.
 */
const PROTECTED_PATH_PATTERN = /^[a-zA-Z]:\\windows(\\|$)/i;

function assertNotProtectedPath(p) {
  const resolved = path.resolve(p);
  if (PROTECTED_PATH_PATTERN.test(resolved)) {
    const error = new Error(`Refusing to modify '${resolved}' — paths under the Windows system directory are protected regardless of confirmation.`);
    error.code = 'PROTECTED_PATH';
    throw error;
  }
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
        // Was previously marked non-destructive, but fs.cp/copyFile
        // silently overwrite an existing file at the destination — the
        // same data-loss shape as writeFile/moveFile, which are both
        // correctly gated. There's no dry-run signal here to fall back on.
        destructive: true,
        description: 'Copy a file or directory to a new location (overwrites an existing destination)'
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
   * Opens a file, folder, drive, URL, or *any installed application* using the
   * Windows default handler. Non-destructive — runs immediately so "open X"
   * requests just work without a confirmation prompt.
   *
   * A bare `Start-Process -FilePath 'chrome'` only succeeds when the name
   * happens to be on PATH, which is why it worked for notepad but failed for
   * Chrome, Word, VS Code and every Store app. This resolves the target
   * through the same chain the Windows Run dialog and Start menu use:
   *
   *   0. explicit path / UNC / URL / protocol  → open directly
   *   1. friendly-name alias table             ("word" → winword.exe)
   *   2. PATH lookup                           (Get-Command)
   *   3. App Paths registry                    (how Win+R resolves "chrome")
   *   4. Start menu apps incl. UWP/Store       (Get-StartApps → shell:AppsFolder)
   *
   * The target is passed through an environment variable rather than being
   * interpolated into the script text, so a name containing quotes or
   * semicolons cannot break out into a command position.
   *
   * @param {Object} params
   * @param {string} params.target - A path ("C:\\", a document), a URL, or an
   *   application name ("notepad", "chrome", "word", "spotify", "settings").
   * @returns {Promise<{opened: string, resolved: string, via: string}>}
   */
  openTarget(params) {
    const target = String(params.target || '').trim();
    if (!target) {
      throw new Error('A target path or application name is required.');
    }
    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      const proc = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', OPEN_TARGET_SCRIPT],
        { windowsHide: true, env: { ...process.env, CHANAKYA_OPEN_TARGET: target } }
      );
      proc.stdout.on('data', (d) => { stdout += d.toString(); });
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('error', (err) => reject(new Error(`Failed to open '${target}': ${err.message}`)));
      proc.on('close', (code) => {
        if (code === 0) {
          // "OK|<via>|<resolved>"
          const [, via = 'direct', resolved = target] = stdout.trim().split('|');
          resolve({ opened: target, resolved, via });
        } else {
          reject(new Error(
            stderr.trim() ||
            `Could not find an application, file or folder matching '${target}'.`
          ));
        }
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
    assertNotProtectedPath(filePath);
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
      case 'copyFile':
        return `Copy ${params.source} to ${params.destination}? This will overwrite an existing file there.`;
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
    assertNotProtectedPath(filePath);

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
    assertNotProtectedPath(destination);

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
    assertNotProtectedPath(source);
    assertNotProtectedPath(destination);

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

