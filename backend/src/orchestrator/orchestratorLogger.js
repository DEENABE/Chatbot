/**
 * @module orchestrator/orchestratorLogger
 * @description Writes a structured JSONL trace for every orchestrator session.
 *
 * Each line is a self-contained JSON event with:
 *   { ts, sessionId, task, event, payload }
 *
 * Stored in backend/storage/orchestrator-traces/<sessionId>.jsonl
 * One file per session; safe to tail -f for live debugging.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve storage dir regardless of where the process is launched from.
const STORAGE_DIR = path.resolve(__dirname, '../../storage/orchestrator-traces');

let dirReady = false;

function ensureDir() {
  if (dirReady) return;
  try {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
    dirReady = true;
  } catch {
    // Non-fatal: if we can't write traces, we just won't log.
  }
}

/**
 * Create a logger bound to a specific orchestrator session.
 *
 * @param {string} sessionId
 * @param {string} task
 * @returns {{ log: (event: string, payload?: Object) => void, flush: () => void }}
 */
export function createSessionLogger(sessionId, task) {
  ensureDir();
  const filePath = path.join(STORAGE_DIR, `${sessionId}.jsonl`);
  const lines = [];

  function log(event, payload = {}) {
    const record = JSON.stringify({
      ts: new Date().toISOString(),
      sessionId,
      task: task.slice(0, 200),
      event,
      payload,
    });
    lines.push(record);

    // Best-effort async append — don't block the orchestrator loop.
    fs.appendFile(filePath, record + '\n', () => {});
  }

  function flush() {
    // No-op — writes are streamed as they arrive. Exposed in case callers
    // want a consistent interface with loggers that do buffer.
  }

  return { log, flush };
}

/**
 * Read back a session trace.
 *
 * @param {string} sessionId
 * @returns {Object[]} Parsed log entries, or [] if the file doesn't exist.
 */
export function readSessionTrace(sessionId) {
  const filePath = path.join(STORAGE_DIR, `${sessionId}.jsonl`);
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * List all session trace files (newest first).
 *
 * @param {number} [limit=50]
 * @returns {Array<{ sessionId: string, size: number, mtime: Date }>}
 */
export function listSessionTraces(limit = 50) {
  ensureDir();
  try {
    return fs
      .readdirSync(STORAGE_DIR)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const stat = fs.statSync(path.join(STORAGE_DIR, f));
        return {
          sessionId: f.replace('.jsonl', ''),
          size: stat.size,
          mtime: stat.mtime,
        };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit);
  } catch {
    return [];
  }
}
