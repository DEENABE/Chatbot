/**
 * @module ai/RepairLogger
 * @description Records every repair session so the system can learn from them.
 * Each session captures the problem, the domain, the plan, every command and
 * its output, the final verdict, and (later) the user's "did it work?" feedback.
 *
 * This log is the foundation for both:
 *   - few-shot memory (retrieve similar past fixes), and
 *   - fine-tuning (export as a training dataset via exportTrainingData()).
 *
 * Stored as a JSON array (easy to update feedback) at storage/repair-sessions.json.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';

const storageDir = path.dirname(config.dbFile);
const LOG_FILE = path.join(storageDir, 'repair-sessions.json');

function readAll() {
  try {
    return JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function writeAll(sessions) {
  try {
    fs.mkdirSync(storageDir, { recursive: true });
    fs.writeFileSync(LOG_FILE, JSON.stringify(sessions, null, 2), 'utf8');
  } catch (err) {
    console.error('[RepairLogger] Failed to write log:', err.message);
  }
}

/**
 * Persist a completed repair session.
 *
 * @param {Object} session
 * @param {string} session.goal
 * @param {string} session.domain
 * @param {string[]} [session.plan]
 * @param {Array} session.steps - Executed steps { command, stdout, stderr, exitCode } or { command, blocked, reason }.
 * @param {boolean} session.resolved
 * @param {string} [session.summary]
 * @param {string} [session.recommendation]
 * @returns {string} The new session id.
 */
export function logSession(session) {
  const sessions = readAll();
  const id = crypto.randomUUID();
  sessions.push({
    id,
    createdAt: new Date().toISOString(),
    goal: session.goal,
    domain: session.domain,
    plan: session.plan || [],
    steps: (session.steps || []).map((s) => ({
      command: s.command,
      blocked: s.blocked || false,
      exitCode: s.exitCode ?? null,
      stdout: (s.stdout || '').slice(0, 1500),
      stderr: (s.stderr || '').slice(0, 800),
      reason: s.reason || null
    })),
    resolved: Boolean(session.resolved),
    summary: session.summary || '',
    recommendation: session.recommendation || '',
    feedback: null // { worked: bool, note: string, at: iso } — filled in later
  });
  writeAll(sessions);
  return id;
}

/**
 * Attach the user's feedback to a session.
 * @param {string} id
 * @param {boolean} worked
 * @param {string} [note]
 * @returns {boolean} true if the session was found and updated.
 */
export function addFeedback(id, worked, note = '') {
  const sessions = readAll();
  const session = sessions.find((s) => s.id === id);
  if (!session) return false;
  session.feedback = { worked: Boolean(worked), note, at: new Date().toISOString() };
  writeAll(sessions);
  return true;
}

/** Return all logged sessions (newest first). */
export function getSessions() {
  return readAll().slice().reverse();
}

/**
 * Export sessions as a fine-tuning-ready dataset (chat format, JSONL-friendly).
 * Only includes sessions the user confirmed worked (or that resolved cleanly
 * when no feedback was given) — these are the "good trajectories" worth learning.
 *
 * @returns {Array<{ messages: Array<{role: string, content: string}> }>}
 */
export function exportTrainingData() {
  const sessions = readAll();
  const good = sessions.filter((s) =>
    (s.feedback && s.feedback.worked) || (!s.feedback && s.resolved)
  );

  return good.map((s) => {
    const commands = s.steps
      .filter((step) => !step.blocked && step.command)
      .map((step) => step.command);
    const assistant = [
      s.summary || 'Here is how I resolved it.',
      commands.length ? `\nCommands used:\n${commands.map((c) => `- ${c}`).join('\n')}` : '',
      s.recommendation ? `\nRecommendation: ${s.recommendation}` : ''
    ].join('');

    return {
      messages: [
        { role: 'system', content: `You are a Windows repair expert specializing in ${s.domain} problems. Diagnose with read-only commands first, then apply safe fixes.` },
        { role: 'user', content: s.goal },
        { role: 'assistant', content: assistant.trim() }
      ]
    };
  });
}
