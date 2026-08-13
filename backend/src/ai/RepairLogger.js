/**
 * @module ai/RepairLogger
 * @description Records every repair AND automation session so the system can
 * learn from them. Each session captures the problem, the domain, the plan,
 * every command and its output, the final verdict, and (later) the user's
 * "did it work?" feedback.
 *
 * Repair (the 6 canonical domains) and automation sessions are stored in
 * SEPARATE files — storage/repair-sessions.json and
 * storage/automation-sessions.json — so the two datasets can be inspected,
 * cleaned, and balanced independently before fine-tuning:
 *
 *   logSession()  -> routes to the right file by domain
 *   getSessions() -> "Unified Session DB": a merged, sorted read of both
 *   exportTrainingData() -> flat combined array (kept for API back-compat —
 *     GET /api/repair/dataset). For the real 3-way "Data Cleaner" split used
 *     by fine-tuning, see scripts/export-training-data.mjs.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { domainLabel, normalizeSubdomain } from '../knowledge/subdomains.js';

const storageDir = path.dirname(config.dbFile);
const REPAIR_LOG_FILE = path.join(storageDir, 'repair-sessions.json');
const AUTOMATION_LOG_FILE = path.join(storageDir, 'automation-sessions.json');
// Curated, hand-written examples (tool calling, tool-result interpretation,
// clarification, safety refusals, verification, plain conversation) — not
// "sessions" in the repair/automation sense (no domain/steps/PowerShell), so
// they're kept as a plain chat-format JSONL seed rather than forced into the
// session log shape. Nothing currently appends to this file at runtime.
const GENERAL_EXAMPLES_FILE = path.join(storageDir, 'general-examples.jsonl');

function fileForDomain(domain) {
  return domain === 'automation' ? AUTOMATION_LOG_FILE : REPAIR_LOG_FILE;
}

function readAll(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

function writeAll(file, sessions) {
  try {
    fs.mkdirSync(storageDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(sessions, null, 2) + '\n', 'utf8');
  } catch (err) {
    console.error('[RepairLogger] Failed to write log:', err.message);
  }
}

/**
 * Persist a completed repair or automation session. Written to
 * repair-sessions.json unless domain is 'automation'.
 *
 * @param {Object} session
 * @param {string} session.goal
 * @param {string} session.domain - One of the six canonical domains, or 'automation'.
 * @param {string} [session.subdomain] - Granular label inside the domain.
 * @param {string[]} [session.plan]
 * @param {Array} session.steps - Executed steps { command, stdout, stderr, exitCode } or { command, blocked, reason }.
 * @param {boolean} session.resolved
 * @param {string} [session.summary]
 * @param {string} [session.recommendation]
 * @returns {string} The new session id.
 */
export function logSession(session) {
  const file = fileForDomain(session.domain);
  const sessions = readAll(file);
  const id = crypto.randomUUID();
  sessions.push({
    id,
    createdAt: new Date().toISOString(),
    goal: session.goal,
    domain: session.domain,
    // Granular label inside the domain (e.g. "audio" under "windows"). Kept
    // only when it is a known subdomain, so the training prompt never carries
    // a stray value.
    subdomain: normalizeSubdomain(session.domain, session.subdomain),
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
  writeAll(file, sessions);
  return id;
}

/**
 * Attach the user's feedback to a session. Searches both logs since the
 * caller doesn't know which domain the session belongs to.
 * @param {string} id
 * @param {boolean} worked
 * @param {string} [note]
 * @returns {boolean} true if the session was found and updated.
 */
export function addFeedback(id, worked, note = '') {
  for (const file of [REPAIR_LOG_FILE, AUTOMATION_LOG_FILE]) {
    const sessions = readAll(file);
    const session = sessions.find((s) => s.id === id);
    if (session) {
      session.feedback = { worked: Boolean(worked), note, at: new Date().toISOString() };
      writeAll(file, sessions);
      return true;
    }
  }
  return false;
}

/**
 * "Unified Session DB" — a merged, newest-first read across both logs.
 * Used by GET /api/repair/sessions so the UI shows one combined list
 * regardless of which file a session actually lives in.
 */
export function getSessions() {
  const all = [...readAll(REPAIR_LOG_FILE), ...readAll(AUTOMATION_LOG_FILE)];
  return all.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/** A session counts as a good training example if confirmed working, or resolved with no feedback yet. */
function isGoodSession(s) {
  return (s.feedback && s.feedback.worked) || (!s.feedback && s.resolved);
}

/** Build one chat-format training example from a session. */
function buildExample(s) {
  const commands = s.steps
    .filter((step) => !step.blocked && step.command)
    .map((step) => step.command);
  const assistant = [
    s.summary || 'Here is how I resolved it.',
    commands.length ? `\nCommands used:\n${commands.map((c) => `- ${c}`).join('\n')}` : '',
    s.recommendation ? `\nRecommendation: ${s.recommendation}` : ''
  ].join('');

  const label = domainLabel(s.domain, s.subdomain);
  const persona = s.domain === 'automation'
    ? `You are Chanakya, a Windows automation agent specializing in ${label}. Extract intent and parameters, ask about anything missing, and confirm before anything that creates, modifies, or deletes system state.`
    : `You are a Windows repair expert specializing in ${label} problems. Diagnose with read-only commands first, then apply safe fixes.`;

  return {
    messages: [
      { role: 'system', content: persona },
      { role: 'user', content: s.goal },
      { role: 'assistant', content: assistant.trim() }
    ]
  };
}

/**
 * Export ALL good sessions (repair + automation combined) as a flat array.
 * Kept for GET /api/repair/dataset backward compatibility. For the real
 * 3-way split + balancing used by fine-tuning, use
 * scripts/export-training-data.mjs instead.
 *
 * @returns {Array<{ messages: Array<{role: string, content: string}> }>}
 */
export function exportTrainingData() {
  return [
    ...readAll(REPAIR_LOG_FILE).filter(isGoodSession).map(buildExample),
    ...readAll(AUTOMATION_LOG_FILE).filter(isGoodSession).map(buildExample)
  ];
}

/** Read the curated general-examples seed (already in {messages:[...]} chat format — no session-log cleaning needed). */
function readGeneralExamples() {
  try {
    return fs.readFileSync(GENERAL_EXAMPLES_FILE, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

/**
 * "Data Cleaner" step: the same good-session filter, kept separate by
 * domain bucket. 'general' comes from a hand-curated seed file (tool
 * calling, tool-result interpretation, clarification, safety, verification,
 * plain conversation) rather than a live session log — nothing in the app
 * currently logs general conversation sessions.
 *
 * @returns {{ repair: Array, automation: Array, general: Array }}
 */
export function exportTrainingDataSplit() {
  return {
    repair: readAll(REPAIR_LOG_FILE).filter(isGoodSession).map(buildExample),
    automation: readAll(AUTOMATION_LOG_FILE).filter(isGoodSession).map(buildExample),
    general: readGeneralExamples()
  };
}

export { REPAIR_LOG_FILE, AUTOMATION_LOG_FILE };
