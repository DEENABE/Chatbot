/**
 * @module knowledge
 * @description Loads domain repair guides from knowledge/repair-guides. These
 * act as lightweight RAG context injected into a specialized agent's prompt.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const guidesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'repair-guides');
const cache = new Map();

/**
 * Load the repair guide text for a domain (cached). Returns '' if none exists.
 * @param {string} domain
 * @returns {string}
 */
export function loadGuide(domain) {
  if (cache.has(domain)) return cache.get(domain);
  const file = path.join(guidesDir, `${domain}.md`);
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    text = '';
  }
  cache.set(domain, text);
  return text;
}
