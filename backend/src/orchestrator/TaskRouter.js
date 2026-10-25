/**
 * @module orchestrator/TaskRouter
 * @description Decides whether a user task should be handled by:
 *   - 'simple'  → chat mode adapter using the shared AgentState controller
 *   - 'agentic' → the Agent Orchestrator loop (multi-step planning)
 *
 * Also classifies which agentic task type it is (for Milestone 1):
 *   - 'open_application'
 *   - 'system_diagnostics'
 *   - 'wifi_diagnostics'
 *   - 'unknown_agentic'  (agentic but unclassified — reserved for future milestones)
 *
 * Strategy: fast keyword pass first; LLM fallback for ambiguous cases.
 * Mirrors the pattern in backend/src/ai/IntentClassifier.js.
 */

import { computerTask, compoundAppTask } from './ComputerTaskPolicy.js';
import { genericDesktopTask } from './GenericDesktopTask.js';
import { completeJSON, DEFAULT_MODEL } from '../ai/llmClient.js';
import { codingTask } from '../coding/CodingTaskRouter.js';

// ---------------------------------------------------------------------------
// Milestone 1 task definitions
// ---------------------------------------------------------------------------

/**
 * @typedef {'open_application'|'system_diagnostics'|'wifi_diagnostics'|'unknown_agentic'|'simple'} TaskType
 */

const AGENTIC_TASK_KEYWORDS = {
  open_application: [
    /^(?:(?:can|could|would) you\s+)?(?:please\s+)?(?:open|launch|start|run)\s+(?!https?:|(?:a |the )?(?:file|folder|website|document|service|script|command)\b).{1,200}$/i,
  ],
  system_diagnostics: [
    /\b(system|pc|computer).{0,30}(diagnostics?|health|status|info|information|report|check)\b/i,
    /\b(show|get|check).{0,30}(cpu|memory|ram|disk|hardware|performance|resource)\b/i,
    /\b(how much|what is|what's).{0,20}(cpu|memory|ram|disk).{0,20}(usage|used|free|available)\b/i,
    /\bsystem (info|information|summary|overview|report)\b/i,
    /\b(diagnose|analyse|analyze|check|inspect).{0,30}(system|pc|computer|performance)\b/i,
    // "how much RAM/disk" style — these start with interrogatives that SIMPLE_OVERRIDES would catch,
    // so this pattern must be checked before the simple override gate.
    /\bhow much\b.{0,20}\b(ram|memory|disk|cpu)\b/i,
    /\bwhat is.{0,10}(my |the )?(ram|memory|disk|cpu|storage).{0,20}(usage|used|status|info)/i,
  ],
  wifi_diagnostics: [
    /\b(wifi|wi-fi|wireless).{0,30}(diagnos|check|test|problem|issue|slow|not working|disconnect|troubleshoot)\b/i,
    /\b(diagnos|troubleshoot|check|fix|test).{0,30}(wifi|wi-fi|wireless|internet|network|connection)\b/i,
    /\b(internet|network).{0,30}(not working|slow|down|disconnected|issue|problem)\b/i,
    /\bwifi.{0,20}(signal|speed|adapter|status|diagnostics?)\b/i,
    /\bwifi diagnostics?\b/i,
  ],
};

// Phrases that always mean "simple chat" regardless of other matches.
const SIMPLE_OVERRIDES = [
  /^(what|how|why|when|where|who|explain|tell me|describe|define|is it|can you|could you|would you|please\s+explain|summarize)/i,
  /\b(write|compose|draft|generate|create|make|translate|convert|calculate|compute|solve|answer)\b(?!.{0,20}\bopen\b)/i,
];

/**
 * @param {string} task
 * @returns {{ mode: 'simple'|'agentic', taskType: TaskType, confidence: number, via: 'keyword'|'llm' }}
 */
function keywordRoute(task, { workspaceId } = {}) {
  const text = String(task || '').trim();
  const coding = codingTask(text, { workspaceId });
  if (coding) return coding;
  if (computerTask(text)?.software)
    return { mode: 'agentic', taskType: 'software_management', confidence: 1, via: 'keyword' };
  if (computerTask(text)?.call?.tool === 'app')
    return {
      mode: 'agentic',
      taskType: 'open_application',
      confidence: 1,
      via: 'keyword',
    };
  if (computerTask(text)?.genericDesktop)
    return {
      mode: 'agentic',
      taskType: 'generic_desktop',
      confidence: 1,
      via: 'keyword',
    };
  if (computerTask(text)?.requiresBrowser)
    return {
      mode: 'agentic',
      taskType: 'browser_interaction',
      confidence: 1,
      via: 'keyword',
    };
  if (compoundAppTask(text))
    return {
      mode: 'agentic',
      taskType: 'compound_application',
      confidence: 1,
      via: 'keyword',
    };
  if (computerTask(text)?.call?.tool === 'uiAutomation')
    return {
      mode: 'agentic',
      taskType: 'desktop_interaction',
      confidence: 1,
      via: 'keyword',
    };

  // Check agentic task keywords FIRST — a query like "how much RAM is used"
  // starts with "how" which also matches SIMPLE_OVERRIDES, but it's clearly
  // an agentic system-diagnostics request. Agentic wins when there's a match.
  for (const [taskType, patterns] of Object.entries(AGENTIC_TASK_KEYWORDS)) {
    if (patterns.some((p) => p.test(text))) {
      return { mode: 'agentic', taskType, confidence: 0.9, via: 'keyword' };
    }
  }

  // Now apply simple overrides — only reached if no agentic keyword matched.
  if (SIMPLE_OVERRIDES.some((p) => p.test(text))) {
    return {
      mode: 'simple',
      taskType: 'simple',
      confidence: 0.85,
      via: 'keyword',
    };
  }

  return null; // No keyword match — fall through to LLM.
}

const ROUTER_SYSTEM = `You are a task router for an AI assistant. Decide if a user task is "simple" (one-shot answer or one tool call) or "agentic" (requires multiple steps with a plan).

For agentic tasks, also classify the task type:
- open_application: user wants to open/launch a specific app or program
- system_diagnostics: user wants CPU/RAM/disk/hardware info or a system health check
- wifi_diagnostics: user wants to check, test, or troubleshoot WiFi/internet

Reply with JSON only: {"mode": "simple"|"agentic", "taskType": "open_application"|"system_diagnostics"|"wifi_diagnostics"|"unknown_agentic"|"simple", "confidence": 0.0-1.0, "reason": "<short>"}`;

/**
 * Route a task to the appropriate execution mode.
 *
 * @param {string} task
 * @param {Object} [opts]
 * @param {string} [opts.model]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ mode: 'simple'|'agentic', taskType: TaskType, confidence: number, via: 'keyword'|'llm' }>}
 */
export async function routeTask(task, { model = DEFAULT_MODEL, signal, workspaceId } = {}) {
  // Fast keyword pass.
  const quick = keywordRoute(task, { workspaceId });
  if (quick) return quick;

  // LLM fallback for ambiguous tasks.
  try {
    const result = await completeJSON({
      system: ROUTER_SYSTEM,
      prompt: `USER TASK:\n${task}\n\nRoute it.`,
      model,
      signal,
    });

    const mode = result.mode === 'agentic' ? 'agentic' : 'simple';
    const validTypes = [
      'open_application',
      'system_diagnostics',
      'wifi_diagnostics',
      'unknown_agentic',
      'simple',
    ];
    const taskType = validTypes.includes(result.taskType)
      ? result.taskType
      : mode === 'agentic'
        ? 'unknown_agentic'
        : 'simple';

    return {
      mode,
      taskType,
      confidence: typeof result.confidence === 'number' ? result.confidence : 0.5,
      via: 'llm',
    };
  } catch {
    // Degrade gracefully: unknown → simple (safer default).
    return {
      mode: 'simple',
      taskType: 'simple',
      confidence: 0.3,
      via: 'keyword',
    };
  }
}

export { AGENTIC_TASK_KEYWORDS };
