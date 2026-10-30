import path from 'node:path';
import { config } from '../config.js';
import { listTables, getTableRows, getAllDocumentChunks } from '../docqa/structuredStore.js';
import { getDocument } from '../services/documentsStore.js';
import { getWorkspaceForUser } from '../services/workspaceService.js';
import { validateWorkspaceRoot } from '../services/workspacePaths.js';
import { streamChat } from '../services/ollamaService.js';
import { completeJSON } from '../ai/llmClient.js';
import { OutputStore } from './outputs.js';
import { PlanStore } from './organize.js';
import { joinChunks } from './extract.js';

/** Wires the file agent to the app's real storage, documents and local model. */

export const fileAgentDir = path.join(config.appDataPath, 'storage', 'file-agent');
export const outputStore = new OutputStore(path.join(fileAgentDir, 'outputs'));
export const planStore = new PlanStore(path.join(fileAgentDir, 'plans'));

const MAX_ROWS = 200_000;

export async function loadDocuments(userId, documentIds) {
  const docs = [];
  let rowBudget = MAX_ROWS;
  for (const id of documentIds || []) {
    const meta = getDocument(id, userId);
    if (!meta || meta.kind === 'image') continue;
    const ext = path.extname(meta.name || '').toLowerCase();
    const base = path.basename(meta.name, ext);
    const tables = [];
    for (const t of listTables(userId, [id]).reverse()) {
      if (rowBudget <= 0) break;
      const rows = getTableRows(t.id, userId).slice(0, rowBudget);
      rowBudget -= rows.length;
      const sheet = String(t.sheet || '').trim();
      tables.push({
        name: documentIds.length > 1 || !sheet ? `${base}${sheet && sheet !== base ? ` - ${sheet}` : ''}` : sheet,
        columns: Array.isArray(t.columns) ? t.columns.map((c) => String(c ?? '')) : [],
        rows,
        source: meta.name,
      });
    }
    const chunks = getAllDocumentChunks(id, userId);
    docs.push({ id, name: meta.name, ext, tables, text: chunks.length ? joinChunks(chunks) : '' });
  }
  return docs;
}

/**
 * @param {object} routing the chat route's model routing (model, options, capabilities, keepAlive)
 */
export function fileAgentDeps({ routing, signal, keepAlive }) {
  const thinking = Array.isArray(routing?.capabilities) && routing.capabilities.includes('thinking');
  return {
    model: routing.model,
    loadDocuments,
    outputs: outputStore,
    plans: planStore,
    protectedRoots: [config.appDataPath],
    validateRoot: validateWorkspaceRoot,
    workspaceRoot: async (userId, workspaceId) => {
      try {
        return getWorkspaceForUser(userId, workspaceId)?.root || null;
      } catch {
        return null;
      }
    },
    completeJSON: (args) => completeJSON({ ...args, model: routing.model }),
    chat: async (messages, { onToken } = {}) => {
      const result = await streamChat({
        model: routing.model,
        messages,
        signal,
        keepAlive: keepAlive || routing.keepAlive,
        options: { ...(routing.options || {}), temperature: 0.2 },
        ...(thinking ? { think: false } : {}),
        onToken: onToken || (() => {}),
      });
      return result?.text || '';
    },
  };
}
