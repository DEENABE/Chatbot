import path from 'node:path';
import fs from 'node:fs/promises';
import { config } from '../config.js';
import { ResultStore, JobRegistry } from './stores.js';
import { originals, keepOriginal, forgetOriginal as forgetOriginalCopy } from './originals.js';
import { createPdfOcr } from './ocr.js';
import { parseDocument } from './parser.js';
import { DocIntelError } from './errors.js';
import { getDocument } from '../services/documentsStore.js';
import { listTables, getTableRows, getAllDocumentChunks } from '../docqa/structuredStore.js';
import { joinChunks } from '../fileagent/extract.js';
import { extOf, formatOf } from './formats.js';
import { sectionsOf } from './parser.js';

/**
 * Process-wide Document Intelligence state, rooted in the app's storage folder:
 *   storage/docintel/originals/<documentId>/  read-only copy of each upload (retention: see OriginalStore)
 *   generated files go through the existing file-agent OutputStore (7 days, owner-scoped)
 */
export const docintelDir = path.join(config.appDataPath, 'storage', 'docintel');
export { originals };
export const results = new ResultStore();
export const jobs = new JobRegistry();
export const pdfOcr = createPdfOcr({ langDir: config.ocrDir });

/** Parsed documents cached by id + original mtime (a re-upload gets a new id anyway). */
const cache = new Map();
const CACHE_MAX = 12;

export { keepOriginal };

export async function forgetOriginal(userId, documentId) {
  cache.delete(documentId);
  await forgetOriginalCopy(userId, documentId);
}

/**
 * Index-only fallback for documents uploaded before originals were kept:
 * tables come from the docqa structured store (every row), text from the
 * stored chunks. Row references are record positions, not sheet rows.
 */
export function documentFromIndex(userId, meta) {
  const ext = extOf(meta.name);
  const kind = formatOf(meta.name)?.kind || 'text';
  const tables = listTables(userId, [meta.id])
    .reverse()
    .map((t) => {
      const columns = (Array.isArray(t.columns) ? t.columns : []).map((c) => String(c ?? ''));
      const rows = getTableRows(t.id, userId).map((values, i) => ({
        ref: i + 1,
        values: values.map((v) => (v === '' ? null : v)),
      }));
      return {
        name: String(t.sheet || meta.name),
        columns,
        rows,
        headerRow: null,
        source: { kind: 'sheet', sheet: String(t.sheet || meta.name) },
        refKind: 'record',
        merged: [],
        formulaCells: 0,
        warnings: [],
      };
    });
  const text = joinChunks(getAllDocumentChunks(meta.id, userId));
  const doc = {
    id: meta.id,
    name: meta.name,
    ext,
    kind,
    size: meta.size || 0,
    metadata: {},
    tables,
    text,
    fromIndex: true,
  };
  doc.warnings = [
    'The original file of this upload is not stored (it was uploaded before Document Intelligence was enabled), so this answer uses the indexed copy: row numbers are record positions, and conversions/edits that need the original are unavailable. Upload the file again for exact sheet rows.',
  ];
  if (kind === 'pdf') {
    const pages = [];
    const parts = text.split(/^--- Page (\d+) ---$/m).slice(1); // [n, text, n, text, …]
    for (let i = 0; i + 1 < parts.length; i += 2)
      pages.push({ number: Number(parts[i]), text: parts[i + 1].trim(), scanned: false });
    if (pages.length) doc.pages = pages;
    doc.metadata = { pages: pages.length || null };
  } else if (kind === 'word' || kind === 'text') {
    const blocks = text
      .split(/\n{2,}/)
      .map((t) => t.trim())
      .filter(Boolean)
      .map((t, i) => ({ type: 'paragraph', text: t, index: i + 1 }));
    doc.blocks = blocks;
    doc.sections = sectionsOf(blocks);
  }
  return doc;
}

/**
 * Loads and parses the documents a request refers to (owner-checked).
 * @returns {Promise<Array<object>>} parsed documents with `id`, plus `original` when stored
 */
export async function loadParsedDocuments(
  userId,
  documentIds,
  { signal, status, parse = parseDocument } = {},
) {
  const docs = [];
  for (const id of documentIds || []) {
    signal?.throwIfAborted?.();
    const meta = getDocument(id, userId);
    if (!meta || meta.kind === 'image' || !formatOf(meta.name)) continue;
    const original = await originals.get(userId, id);
    if (!original) {
      docs.push(documentFromIndex(userId, meta));
      continue;
    }
    const stat = await fs.stat(original.path);
    const key = `${id}:${stat.mtimeMs}`;
    const hit = cache.get(id);
    if (hit && hit.key === key && hit.userId === userId) {
      docs.push(hit.doc);
      continue;
    }
    status?.(`Reading ${meta.name}`);
    let doc;
    try {
      doc = await parse(original.path, meta.name, { ocr: pdfOcr, signal });
    } catch (error) {
      if (error instanceof DocIntelError) {
        docs.push({
          id,
          name: meta.name,
          ext: extOf(meta.name),
          kind: formatOf(meta.name).kind,
          failed: error,
          tables: [],
          text: '',
          warnings: [],
        });
        continue;
      }
      throw error;
    }
    doc.id = id;
    doc.original = { path: original.path };
    cache.set(id, { key, userId, doc });
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    docs.push(doc);
  }
  return docs;
}

/**
 * Dependencies for the agent. `routing` is the chat route's model routing; for
 * REST jobs it is resolved lazily (only summaries/explanations/new prose need the model).
 */
export async function docintelDeps({ routing, resolveRouting, signal, keepAlive } = {}) {
  const { fileAgentDeps, outputStore } = await import('../fileagent/runtime.js');
  let base = routing ? fileAgentDeps({ routing, signal, keepAlive }) : null;
  const lazy = async () => {
    if (base) return base;
    let r;
    try {
      r = await resolveRouting();
    } catch (error) {
      throw new DocIntelError(
        'MODEL_UNAVAILABLE',
        `The local model is not available: ${String(error.message || error).slice(0, 160)}`,
        { status: 503 },
      );
    }
    base = fileAgentDeps({ routing: r, signal, keepAlive });
    return base;
  };
  return {
    loadDocuments: loadParsedDocuments,
    outputs: outputStore,
    results,
    chat: async (messages, options) => (await lazy()).chat(messages, options),
    completeJSON: async (args) => (await lazy()).completeJSON(args),
  };
}
