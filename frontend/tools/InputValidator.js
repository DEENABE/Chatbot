/**
 * @module InputValidator
 * @description Pure-function schema validator with zero external dependencies.
 * Validates parameters against declarative schemas with support for
 * string, number, boolean, enum, path, array, and object types.
 */

/**
 * @typedef {Object} ValidationResult
 * @property {boolean} valid - Whether validation passed.
 * @property {Array<{field: string, message: string}>} [errors] - Validation errors (present when valid is false).
 */

/**
 * @typedef {Object} PathValidationResult
 * @property {boolean} valid - Whether the path is valid.
 * @property {string} [error] - Error message (present when valid is false).
 */

/**
 * @typedef {Object} SchemaEntry
 * @property {('string'|'number'|'boolean'|'enum'|'path'|'array'|'object')} type - The expected type.
 * @property {boolean} [required=false] - Whether the parameter is required.
 * @property {number} [minLength] - Minimum string length (string type).
 * @property {number} [maxLength] - Maximum string length (string type).
 * @property {string} [pattern] - Regex pattern string (string type).
 * @property {number} [min] - Minimum value (number type).
 * @property {number} [max] - Maximum value (number type).
 * @property {boolean} [integer] - Whether the number must be an integer (number type).
 * @property {Array<*>} [values] - Allowed values (enum type).
 * @property {number} [minItems] - Minimum array length (array type).
 * @property {number} [maxItems] - Maximum array length (array type).
 * @property {SchemaEntry} [itemSchema] - Schema for each array item (array type).
 */

// Characters forbidden in Windows file paths (beyond basic printable ASCII control)
const DANGEROUS_PATH_CHARS = /[<>"|?*\x00-\x1F]/;

// Valid Windows path patterns: drive letter (C:\...) or UNC (\\server\share\...)
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:\\/;
const WINDOWS_UNC_PATH = /^\\\\\w/;

// Path traversal pattern
const PATH_TRAVERSAL = /(^|[\\/])\.\.($|[\\/])/;

export class InputValidator {
  /**
   * Validate parameters against a schema definition.
   *
   * @param {Object<string, SchemaEntry>} schema - Map of parameter names to their schema definitions.
   * @param {Object<string, *>} params - The parameters to validate.
   * @returns {ValidationResult} The validation result.
   *
   * @example
   * const schema = {
   *   filePath: { type: 'path', required: true },
   *   count: { type: 'number', required: false, min: 1, max: 100, integer: true }
   * };
   * const result = InputValidator.validate(schema, { filePath: 'C:\\Users\\test.txt', count: 5 });
   */
  static validate(schema, params) {
    const errors = [];
    const safeParams = params != null && typeof params === 'object' ? params : {};

    for (const [field, rules] of Object.entries(schema)) {
      const value = safeParams[field];

      // --- Required check ---
      if (rules.required && (value === undefined || value === null)) {
        errors.push({ field, message: `${field} is required` });
        continue;
      }

      // Skip further validation if the value is absent and not required
      if (value === undefined || value === null) {
        continue;
      }

      // --- Type-specific validation ---
      const typeErrors = InputValidator._validateType(field, value, rules);
      errors.push(...typeErrors);
    }

    return errors.length === 0
      ? { valid: true }
      : { valid: false, errors };
  }

  /**
   * Validate a Windows file-system path.
   *
   * @param {string} p - The path string to validate.
   * @returns {PathValidationResult} The validation result.
   *
   * @example
   * InputValidator.validatePath('C:\\Users\\Admin\\file.txt');
   * // => { valid: true }
   *
   * InputValidator.validatePath('C:\\Users\\..\\secret');
   * // => { valid: false, error: 'Path contains disallowed traversal (..)' }
   */
  static validatePath(p) {
    if (typeof p !== 'string') {
      return { valid: false, error: 'Path must be a string' };
    }

    if (p.trim().length === 0) {
      return { valid: false, error: 'Path must not be empty' };
    }

    // Must start with a drive letter (C:\) or UNC prefix (\\)
    if (!WINDOWS_DRIVE_PATH.test(p) && !WINDOWS_UNC_PATH.test(p)) {
      return { valid: false, error: 'Path must be an absolute Windows path (drive letter or UNC)' };
    }

    // Reject path traversal
    if (PATH_TRAVERSAL.test(p)) {
      return { valid: false, error: 'Path contains disallowed traversal (..)' };
    }

    // Reject dangerous characters
    if (DANGEROUS_PATH_CHARS.test(p)) {
      return { valid: false, error: 'Path contains dangerous or invalid characters' };
    }

    return { valid: true };
  }

  // ─── Private helpers ────────────────────────────────────────────────

  /**
   * Dispatch validation to the correct type handler.
   *
   * @param {string} field - The parameter name (for error messages).
   * @param {*} value - The value to validate.
   * @param {SchemaEntry} rules - The schema rules for this parameter.
   * @returns {Array<{field: string, message: string}>} Any validation errors.
   * @private
   */
  static _validateType(field, value, rules) {
    switch (rules.type) {
      case 'string':
        return InputValidator._validateString(field, value, rules);
      case 'number':
        return InputValidator._validateNumber(field, value, rules);
      case 'boolean':
        return InputValidator._validateBoolean(field, value);
      case 'enum':
        return InputValidator._validateEnum(field, value, rules);
      case 'path':
        return InputValidator._validatePathField(field, value);
      case 'array':
        return InputValidator._validateArray(field, value, rules);
      case 'object':
        return InputValidator._validateObject(field, value);
      default:
        return [{ field, message: `Unknown schema type: ${rules.type}` }];
    }
  }

  /**
   * @private
   */
  static _validateString(field, value, rules) {
    const errors = [];

    if (typeof value !== 'string') {
      errors.push({ field, message: `${field} must be a string` });
      return errors;
    }

    if (rules.minLength !== undefined && value.length < rules.minLength) {
      errors.push({ field, message: `${field} must be at least ${rules.minLength} characters` });
    }

    if (rules.maxLength !== undefined && value.length > rules.maxLength) {
      errors.push({ field, message: `${field} must be at most ${rules.maxLength} characters` });
    }

    if (rules.pattern !== undefined) {
      const regex = new RegExp(rules.pattern);
      if (!regex.test(value)) {
        errors.push({ field, message: `${field} must match pattern ${rules.pattern}` });
      }
    }

    return errors;
  }

  /**
   * @private
   */
  static _validateNumber(field, value, rules) {
    const errors = [];

    if (typeof value !== 'number' || Number.isNaN(value)) {
      errors.push({ field, message: `${field} must be a number` });
      return errors;
    }

    if (rules.integer && !Number.isInteger(value)) {
      errors.push({ field, message: `${field} must be an integer` });
    }

    if (rules.min !== undefined && value < rules.min) {
      errors.push({ field, message: `${field} must be at least ${rules.min}` });
    }

    if (rules.max !== undefined && value > rules.max) {
      errors.push({ field, message: `${field} must be at most ${rules.max}` });
    }

    return errors;
  }

  /**
   * @private
   */
  static _validateBoolean(field, value) {
    if (typeof value !== 'boolean') {
      return [{ field, message: `${field} must be a boolean` }];
    }
    return [];
  }

  /**
   * @private
   */
  static _validateEnum(field, value, rules) {
    if (!Array.isArray(rules.values)) {
      return [{ field, message: `${field} enum schema is missing a 'values' array` }];
    }

    if (!rules.values.includes(value)) {
      const allowed = rules.values.map(v => JSON.stringify(v)).join(', ');
      return [{ field, message: `${field} must be one of [${allowed}]` }];
    }

    return [];
  }

  /**
   * @private
   */
  static _validatePathField(field, value) {
    const result = InputValidator.validatePath(value);
    if (!result.valid) {
      return [{ field, message: result.error }];
    }
    return [];
  }

  /**
   * @private
   */
  static _validateArray(field, value, rules) {
    const errors = [];

    if (!Array.isArray(value)) {
      errors.push({ field, message: `${field} must be an array` });
      return errors;
    }

    if (rules.minItems !== undefined && value.length < rules.minItems) {
      errors.push({ field, message: `${field} must have at least ${rules.minItems} items` });
    }

    if (rules.maxItems !== undefined && value.length > rules.maxItems) {
      errors.push({ field, message: `${field} must have at most ${rules.maxItems} items` });
    }

    // Validate each item against itemSchema if provided
    if (rules.itemSchema) {
      for (let i = 0; i < value.length; i++) {
        const itemErrors = InputValidator._validateType(`${field}[${i}]`, value[i], rules.itemSchema);
        errors.push(...itemErrors);
      }
    }

    return errors;
  }

  /**
   * @private
   */
  static _validateObject(field, value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return [{ field, message: `${field} must be a plain object` }];
    }
    return [];
  }
}
