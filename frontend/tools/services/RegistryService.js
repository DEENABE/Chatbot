/**
 * @fileoverview Registry Service for Windows Registry operations.
 * Provides safe read/write access to the Windows Registry via reg.exe.
 * All keyPaths are validated against known hive prefixes and inputs are
 * sanitised to prevent command injection.
 *
 * @module RegistryService
 */

import { execFile } from 'child_process';
import { BaseToolService } from '../BaseToolService.js';

/** Valid short-form and long-form registry hive prefixes. */
const VALID_HIVES = [
  'HKLM', 'HKCU', 'HKCR', 'HKU', 'HKCC',
  'HKEY_LOCAL_MACHINE', 'HKEY_CURRENT_USER',
  'HKEY_CLASSES_ROOT', 'HKEY_USERS',
  'HKEY_CURRENT_CONFIG',
];

/** Characters that must never appear in user-supplied registry arguments. */
const INJECTION_PATTERN = /[;&|`$\n\r]/;

/**
 * Registry subtrees where a write/delete is a CRITICAL-risk operation
 * regardless of confirmation: autostart persistence (Run/RunOnce, Winlogon
 * Shell/Userinit — the classic backdoor/persistence mechanisms), security
 * software policy (Windows Defender), the LSA, and Image File Execution
 * Options (a well-known debugger-hijack technique). validateKeyPath() only
 * checks that a path starts with a real hive — nothing previously stopped a
 * write anywhere inside HKLM/HKCU once past that one check.
 */
const PROTECTED_KEY_PATTERNS = [
  /\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run/i,
  /\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\RunOnce/i,
  /\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon/i,
  /\\SOFTWARE\\Policies\\Microsoft\\Windows Defender/i,
  /\\SYSTEM\\CurrentControlSet\\Control\\Lsa/i,
  /\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options/i,
  /\\SYSTEM\\CurrentControlSet\\Control\\SafeBoot/i,
];

function assertNotProtectedKey(keyPath) {
  if (PROTECTED_KEY_PATTERNS.some((pattern) => pattern.test(keyPath))) {
    const error = new Error(`Refusing to modify '${keyPath}' — this key controls startup persistence, security software, or authentication and is protected regardless of confirmation.`);
    error.code = 'PROTECTED_REGISTRY_KEY';
    throw error;
  }
}

/**
 * Validate that a registry key path starts with a recognised hive.
 *
 * @param {string} keyPath - The registry key path to validate.
 * @throws {Error} If the path does not begin with a valid hive.
 */
function validateKeyPath(keyPath) {
  if (!keyPath || typeof keyPath !== 'string') {
    throw new Error('keyPath must be a non-empty string');
  }
  const upper = keyPath.toUpperCase();
  const valid = VALID_HIVES.some(
    (h) => upper.startsWith(h + '\\') || upper === h,
  );
  if (!valid) {
    throw new Error(
      `Invalid registry hive. keyPath must start with one of: ${VALID_HIVES.join(', ')}`,
    );
  }
}

/**
 * Sanitise a value that will be passed as an argument to reg.exe.
 *
 * @param {string} value - The value to sanitise.
 * @param {string} label - Human-readable label used in error messages.
 * @throws {Error} If the value contains dangerous characters.
 */
function sanitize(value, label) {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string`);
  }
  if (INJECTION_PATTERN.test(value)) {
    throw new Error(
      `${label} contains invalid characters that could be used for command injection`,
    );
  }
}

/**
 * Service providing Windows Registry read / write operations.
 *
 * @extends BaseToolService
 */
export class RegistryService extends BaseToolService {
  constructor(confirmationGate) {
    super('registry', confirmationGate);
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  /** @override */
  get actions() {
    return {
      getValue: {
        handler: this.getValue.bind(this),
        schema: {
          keyPath: { type: 'string', required: true },
          valueName: { type: 'string', required: true },
        },
        destructive: false,
        description: 'Read a single value from the Windows Registry',
      },
      setValue: {
        handler: this.setValue.bind(this),
        schema: {
          keyPath: { type: 'string', required: true },
          valueName: { type: 'string', required: true },
          valueType: {
            type: 'enum',
            required: true,
            values: [
              'REG_SZ',
              'REG_DWORD',
              'REG_QWORD',
              'REG_BINARY',
              'REG_EXPAND_SZ',
              'REG_MULTI_SZ',
            ],
          },
          data: { type: 'string', required: true },
        },
        destructive: true,
        description: 'Create or update a registry value',
      },
      deleteValue: {
        handler: this.deleteValue.bind(this),
        schema: {
          keyPath: { type: 'string', required: true },
          valueName: { type: 'string', required: true },
        },
        destructive: true,
        description: 'Delete a registry value (irreversible)',
      },
      listKeys: {
        handler: this.listKeys.bind(this),
        schema: {
          keyPath: { type: 'string', required: true },
        },
        destructive: false,
        description: 'List sub-keys and values under a registry key',
      },
      keyExists: {
        handler: this.keyExists.bind(this),
        schema: {
          keyPath: { type: 'string', required: true },
        },
        destructive: false,
        description: 'Check whether a registry key exists',
      },
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
      case 'setValue':
        return `Set registry value ${params.keyPath}\\${params.valueName} = "${params.data}" (${params.valueType})?`;
      case 'deleteValue':
        return `Delete registry value ${params.keyPath}\\${params.valueName}? This cannot be undone.`;
      default:
        return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Execute `reg.exe` with the provided arguments.
   *
   * @param {string[]} args - Arguments forwarded to reg.exe.
   * @returns {Promise<string>} stdout of the command.
   */
  _runReg(args) {
    return new Promise((resolve, reject) => {
      execFile('reg.exe', args, { windowsHide: true }, (err, stdout, stderr) => {
        if (err) {
          const message = stderr?.trim() || err.message;
          reject(new Error(`reg.exe failed: ${message}`));
          return;
        }
        resolve(stdout);
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Action handlers
  // ---------------------------------------------------------------------------

  /**
   * Read a single registry value.
   *
   * @param {{ keyPath: string, valueName: string }} params
   * @returns {Promise<{ keyPath: string, valueName: string, type: string, data: string }>}
   */
  async getValue(params) {
    const { keyPath, valueName } = params;
    validateKeyPath(keyPath);
    sanitize(valueName, 'valueName');

    const stdout = await this._runReg(['query', keyPath, '/v', valueName]);
    return this._parseSingleValue(stdout, keyPath, valueName);
  }

  /**
   * Create or update a registry value.
   *
   * @param {{ keyPath: string, valueName: string, valueType: string, data: string }} params
   * @returns {Promise<{ keyPath: string, valueName: string, valueType: string, data: string, success: boolean }>}
   */
  async setValue(params) {
    const { keyPath, valueName, valueType, data } = params;
    validateKeyPath(keyPath);
    assertNotProtectedKey(keyPath);
    sanitize(valueName, 'valueName');
    sanitize(data, 'data');

    await this._runReg([
      'add', keyPath,
      '/v', valueName,
      '/t', valueType,
      '/d', data,
      '/f',
    ]);

    return { keyPath, valueName, valueType, data, success: true };
  }

  /**
   * Delete a registry value.
   *
   * @param {{ keyPath: string, valueName: string }} params
   * @returns {Promise<{ keyPath: string, valueName: string, deleted: boolean }>}
   */
  async deleteValue(params) {
    const { keyPath, valueName } = params;
    validateKeyPath(keyPath);
    assertNotProtectedKey(keyPath);
    sanitize(valueName, 'valueName');

    await this._runReg(['delete', keyPath, '/v', valueName, '/f']);
    return { keyPath, valueName, deleted: true };
  }

  /**
   * List sub-keys and values under a registry key.
   *
   * @param {{ keyPath: string }} params
   * @returns {Promise<{ keyPath: string, subKeys: string[], values: Array<{ name: string, type: string, data: string }> }>}
   */
  async listKeys(params) {
    const { keyPath } = params;
    validateKeyPath(keyPath);

    const stdout = await this._runReg(['query', keyPath]);
    return this._parseListOutput(stdout, keyPath);
  }

  /**
   * Check whether a registry key exists.
   *
   * @param {{ keyPath: string }} params
   * @returns {Promise<{ keyPath: string, exists: boolean }>}
   */
  async keyExists(params) {
    const { keyPath } = params;
    validateKeyPath(keyPath);

    try {
      await this._runReg(['query', keyPath]);
      return { keyPath, exists: true };
    } catch {
      return { keyPath, exists: false };
    }
  }

  // ---------------------------------------------------------------------------
  // Output parsers
  // ---------------------------------------------------------------------------

  /**
   * Parse reg query output for a single named value.
   *
   * @param {string} stdout  - Raw output from `reg query … /v`.
   * @param {string} keyPath - The queried key path.
   * @param {string} valueName - The queried value name.
   * @returns {{ keyPath: string, valueName: string, type: string, data: string }}
   */
  _parseSingleValue(stdout, keyPath, valueName) {
    const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);

    for (const line of lines) {
      // Typical format: "    ValueName    REG_SZ    Data"
      const match = line.match(/^\s*(.+?)\s{2,}(REG_\w+)\s{2,}(.*)$/);
      if (match) {
        return {
          keyPath,
          valueName: match[1].trim(),
          type: match[2].trim(),
          data: match[3].trim(),
        };
      }
    }

    throw new Error(
      `Could not parse registry value "${valueName}" at "${keyPath}"`,
    );
  }

  /**
   * Parse reg query output to extract sub-keys and values.
   *
   * @param {string} stdout  - Raw output from `reg query`.
   * @param {string} keyPath - The queried key path.
   * @returns {{ keyPath: string, subKeys: string[], values: Array<{ name: string, type: string, data: string }> }}
   */
  _parseListOutput(stdout, keyPath) {
    const lines = stdout.split('\n').map((l) => l.trimEnd());
    const subKeys = [];
    const values = [];
    const normalised = keyPath.toUpperCase();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Sub-key lines start with the hive path and contain a backslash.
      if (
        trimmed.startsWith('HK') &&
        trimmed.toUpperCase() !== normalised &&
        !trimmed.includes('    ')
      ) {
        subKeys.push(trimmed);
        continue;
      }

      // Value lines have the format: "    Name    TYPE    Data"
      const match = trimmed.match(/^\s*(.+?)\s{2,}(REG_\w+)\s{2,}(.*)$/);
      if (match) {
        values.push({
          name: match[1].trim(),
          type: match[2].trim(),
          data: match[3].trim(),
        });
      }
    }

    return { keyPath, subKeys, values };
  }
}

export default RegistryService;

