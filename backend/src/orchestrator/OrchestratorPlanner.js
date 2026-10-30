import { browserSchemas } from './BrowserTask.js';
import { genericDesktopTask } from './GenericDesktopTask.js';
/**
 * @module orchestrator/OrchestratorPlanner
 * @description Generates a structured, ordered plan for a user task as a list
 * of ToolEngine actions. Each plan step is a validated { tool, action, params }
 * triple from the Milestone 1 allowed tool manifest.
 *
 * The LLM proposes the plan; this module validates every step against the
 * static manifest before accepting it so the LLM cannot hallucinate unknown
 * tool/action names or inject unexpected parameters.
 */

import { computerTask, compoundAppTask } from './ComputerTaskPolicy.js';
import { validateCapability } from './CapabilityContracts.js';
import { completeJSON, DEFAULT_MODEL } from '../ai/llmClient.js';

// ---------------------------------------------------------------------------
// Milestone 1 allowed tool manifest
// This is the single source of truth for what the Orchestrator may call.
// Only expand this list as new milestones are approved.
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} AllowedAction
 * @property {string} tool
 * @property {string} action
 * @property {string} description
 * @property {Object} defaultParams   - Safe defaults applied when LLM omits optional params.
 * @property {string[]} requiredParams - Params the plan MUST supply.
 */

/** @type {AllowedAction[]} */
export const ALLOWED_ACTIONS = [
  ...['providers', 'discover', 'discoverOnline', 'resolve', 'download', 'install', 'verify'].map(
    (action) => ({
      tool: 'software',
      action,
      description:
        'Use an owned software query or backend-issued candidate/plan handle. Installation and network actions require contextual user approval.',
      defaultParams: {},
      requiredParams:
        action === 'providers'
          ? []
          : ['discover', 'discoverOnline'].includes(action)
            ? ['query']
            : action === 'resolve'
              ? ['candidateId']
              : ['planId'],
    }),
  ),
  ...['open', 'observe', 'act', 'actConfirmed', 'input', 'inputConfirmed', 'verify', 'saveAs'].map(
    (action) => ({
      tool: 'desktop',
      action,
      description:
        'Generic observed UI control. Plan only one step, then re-observe. Never invent element IDs.',
      defaultParams: {},
      requiredParams: ['open', 'observe'].includes(action) ? ['query'] : ['snapshotId'],
    }),
  ),
  ...[
    'launch',
    'click',
    'doubleClick',
    'type',
    'press',
    'hotkey',
    'scroll',
    'select',
    'focus',
    'read',
    'waitFor',
    'find',
    'close',
  ].map((action) => ({
    tool: 'desktop',
    action,
    description:
      'Fixed application-neutral primitive; one grounded action per observation. Runtime risk can require human approval.',
    defaultParams: {},
    requiredParams: action === 'launch' ? ['app'] : ['snapshotId'],
  })),
  ...Object.entries(browserSchemas).map(([action, schema]) => ({
    tool: 'browser',
    action,
    description: `${action} through the managed browser DOM; inspect elements before using opaque IDs.`,
    defaultParams: {},
    requiredParams: Object.keys(schema).filter((k) => schema[k] === 'required'),
  })),
  ...[
    'findWindow',
    'waitForWindow',
    'isWindowOpen',
    'focusWindow',
    'listControls',
    'findControl',
    'waitForControl',
    'readText',
    'navigateControl',
  ].map((action) => ({
    tool: 'uiAutomation',
    action,
    description: `${action}: inspect accessibility controls; navigateControl selects tabs only. Use query and discovered automationId or controlName.`,
    defaultParams: {},
    requiredParams: ['query'],
  })),
  {
    tool: 'app',
    action: 'resolveTarget',
    description:
      'Resolve a target from an explicit user path or configured alias. Never invent paths.',
    defaultParams: {},
    requiredParams: ['query'],
  },
  {
    tool: 'app',
    action: 'openWithTarget',
    description:
      'Open a verified target in an app. Use targetFromStep to reference a preceding resolveTarget step id.',
    defaultParams: {},
    requiredParams: ['app'],
  },
  {
    tool: 'systemSettings',
    action: 'list',
    description:
      'List the Windows settings that can be changed (display, sound, power timeouts, pointer, Explorer, notifications, wifi, bluetooth) with current values.',
    defaultParams: {},
    requiredParams: [],
  },
  {
    tool: 'systemSettings',
    action: 'get',
    description: 'Read one Windows setting by id.',
    defaultParams: {},
    requiredParams: ['id'],
  },
  {
    tool: 'systemSettings',
    action: 'set',
    description:
      'Change a reversible setting from the list: enabled true/false for on/off settings, level (whole number within its listed range) for numeric settings, option for choices (power-mode, wake-timers, cooling-policy); power-plan settings also accept source battery, plugged-in or both. Applied and verified by read-back.',
    defaultParams: {},
    requiredParams: ['id'],
  },
  {
    tool: 'systemSettings',
    action: 'setConfirmed',
    description:
      'Turn wifi, bluetooth, airplane-mode, camera-access, microphone-access, location-access, sign-in-on-wake, firewall-private/public/domain (on only), hibernate, fast-startup, remote-desktop, long-paths or a feature-* (wsl, virtual-machine-platform, hyper-v, windows-sandbox) on/off (enabled true/false), set active-hours-start / active-hours-end (level 0-23), or set lid-close-action, power-button-action, mouse-primary-button, low-battery-action or critical-battery-action (option). Always requires human confirmation; settings with requiresAdmin also show a Windows UAC prompt.',
    defaultParams: {},
    requiredParams: ['id'],
  },
  {
    tool: 'winget',
    action: 'search',
    description:
      'Search the winget repository for an application that app.openApp reported as not installed. Read-only.',
    defaultParams: {},
    requiredParams: ['query'],
  },
  {
    tool: 'winget',
    action: 'install',
    description:
      'Install one exact winget package id returned by winget.search. Always requires human confirmation; never invent an id.',
    defaultParams: {},
    requiredParams: ['packageId'],
  },
  {
    tool: 'app',
    action: 'refreshAppRegistry',
    description: 'Refresh application discovery from the current Windows machine.',
    defaultParams: {},
    requiredParams: [],
  },
  {
    tool: 'uiAutomation',
    action: 'calculate',
    description:
      'Use Windows Calculator UI and read the result for a binary arithmetic expression.',
    defaultParams: {},
    requiredParams: ['expression'],
  },
  {
    tool: 'uiAutomation',
    action: 'typeInNotepad',
    description:
      'Enter text into an empty Notepad editor and verify it; preserve existing documents.',
    defaultParams: {},
    requiredParams: ['text'],
  },
  // ── Application launching ────────────────────────────────────────────────
  {
    tool: 'app',
    action: 'openApp',
    description:
      'Resolve and open an installed application by name. Never provide a path or launch arguments.',
    defaultParams: {},
    requiredParams: ['query'],
  },

  // ── System diagnostics ───────────────────────────────────────────────────
  {
    tool: 'hardware',
    action: 'systemInfo',
    description: 'Get hostname, OS version, CPU model, and memory totals.',
    defaultParams: {},
    requiredParams: [],
  },
  {
    tool: 'hardware',
    action: 'cpuUsage',
    description: 'Measure current CPU usage percentage.',
    defaultParams: {},
    requiredParams: [],
  },
  {
    tool: 'hardware',
    action: 'memoryUsage',
    description: 'Get current RAM usage and free memory.',
    defaultParams: {},
    requiredParams: [],
  },
  {
    tool: 'hardware',
    action: 'diskInfo',
    description: 'List disk drives with capacity and free space.',
    defaultParams: {},
    requiredParams: [],
  },
  {
    tool: 'process',
    action: 'list',
    description: 'List running processes, optionally sorted by CPU or memory.',
    defaultParams: { sortBy: 'cpu', limit: 10 },
    requiredParams: [],
  },

  // ── WiFi / network diagnostics ───────────────────────────────────────────
  {
    tool: 'network',
    action: 'ipConfig',
    description: 'Get IP configuration for all network adapters.',
    defaultParams: {},
    requiredParams: [],
  },
  {
    tool: 'network',
    action: 'ping',
    description: 'Ping a host and report round-trip statistics.',
    defaultParams: { host: '8.8.8.8', count: 4 },
    requiredParams: ['host'],
  },
  {
    tool: 'network',
    action: 'netstat',
    description: 'List current network connections.',
    defaultParams: { state: 'ESTABLISHED' },
    requiredParams: [],
  },
  {
    tool: 'hardware',
    action: 'networkAdapters',
    description: 'List active network adapters with connection status.',
    defaultParams: {},
    requiredParams: [],
  },
];

// Build a fast lookup map: "tool.action" → AllowedAction
const ACTION_LOOKUP = new Map(ALLOWED_ACTIONS.map((a) => [`${a.tool}.${a.action}`, a]));

// ---------------------------------------------------------------------------
// LLM plan generation
// ---------------------------------------------------------------------------

function buildManifestText() {
  return ALLOWED_ACTIONS.map(
    (a, i) =>
      `${i + 1}. tool="${a.tool}" action="${a.action}" — ${a.description}` +
      (a.requiredParams.length ? ` [required params: ${a.requiredParams.join(', ')}]` : ''),
  ).join('\n');
}

const PLANNER_SYSTEM = `You are a planning agent for a Windows AI assistant. Given a user task, produce a SHORT ordered plan (1-5 steps) using ONLY the available tool actions listed below.

AVAILABLE ACTIONS:
${buildManifestText()}

RULES:
- Use only the exact tool/action names listed above. Do not invent new ones.
- Keep the plan minimal: use the fewest steps that fully address the task.
- For a simple launch alone use app.openApp. Never invent executable paths.
- For compound desktop goals execute ALL requested verbs. Resolve file/folder/media with app.resolveTarget (query copied from user input), then app.openWithTarget with app and targetFromStep referencing the resolver step id. Include an id on every step.
- Never answer a desktop task from knowledge or tell the user to enter values manually. Tools must execute and verify the complete goal.
- Unknown target names must be resolved by configured aliases; never guess filesystem paths.
- For "system diagnostics": use hardware.systemInfo + hardware.cpuUsage + hardware.memoryUsage (3 steps).
- For "wifi diagnostics": use hardware.networkAdapters + network.ipConfig + network.ping (3 steps, ping host="8.8.8.8").

Reply with JSON only:
{
  "summary": "<one-sentence goal>",
  "steps": [
    {
      "description": "<what this step does>",
      "tool": "<tool name>",
      "action": "<action name>",
      "params": { <params object> }
    }
  ]
}`;

/**
 * Generate a validated plan for the given task.
 *
 * @param {Object} args
 * @param {string} args.task
 * @param {string} args.taskType
 * @param {string} [args.model]
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<{ summary: string, steps: import('./AgentState.js').PlanStep[] }>}
 */
export async function createOrchestratorPlan({ task, taskType, model = DEFAULT_MODEL, signal }) {
  // Fast-path: for milestone 1 task types, build the plan deterministically
  // without an LLM call. This is faster and avoids hallucination entirely.
  const compound = computerTask(task)?.compound;
  if (compound)
    return {
      summary: task,
      steps: [
        normalisePlanStep(
          {
            id: 'resolve-target',
            tool: 'app',
            action: 'resolveTarget',
            params: {
              query: compound.query,
              type: /^https?:/i.test(compound.query) ? 'URL' : 'UNKNOWN',
            },
          },
          0,
        ),
        normalisePlanStep(
          {
            id: 'open-target',
            tool: 'app',
            action: 'openWithTarget',
            params: { app: compound.app, targetFromStep: 'resolve-target' },
          },
          1,
        ),
      ],
    };
  const desktop = computerTask(task);
  if (desktop?.software) {
    if (
      desktop.software.needsClarification ||
      desktop.software.highRisk ||
      desktop.software.blocked
    )
      return { summary: desktop.software.message, steps: [] };
    return {
      summary:
        'Discover verified software sources; the typed software runner owns installation and independent verification.',
      steps: [
        normalisePlanStep(
          {
            tool: 'software',
            action: 'discover',
            params: { query: desktop.software.query },
            description: task,
          },
          0,
        ),
      ],
    };
  }
  // Multi-step app tasks start by opening the app; the Astra runner decides every later step from the results.
  if (desktop?.astra)
    return {
      summary: task,
      steps: [
        normalisePlanStep(
          {
            tool: 'desktop',
            action: 'open',
            params: { query: desktop.astra.app || 'notepad' },
            description: task,
          },
          0,
        ),
      ],
    };
  if (desktop?.call)
    return {
      summary: task,
      steps: [normalisePlanStep({ ...desktop.call, description: task }, 0)],
    };
  const generic = genericDesktopTask(task);
  if (generic)
    return {
      summary: task,
      steps: [
        normalisePlanStep(
          {
            tool: 'desktop',
            action: generic.closeOnly ? 'observe' : 'open',
            params: { query: generic.query },
          },
          0,
        ),
      ],
    };
  const fastPlan = buildFastPlan(task, taskType);
  if (fastPlan) return fastPlan;

  // General LLM-based planning for unknown_agentic tasks.
  try {
    const result = await completeJSON({
      system: PLANNER_SYSTEM,
      prompt: `TASK TYPE: ${taskType}\n\nUSER TASK:\n${task}\n\nProduce the plan.`,
      model,
      signal,
    });

    const rawSteps = Array.isArray(result.steps) ? result.steps : [];
    const validated = validateAndNormaliseSteps(rawSteps, 0, [], task);

    if (validated.length === 0) {
      throw new Error('LLM produced no valid steps after validation.');
    }

    return {
      summary: result.summary || `Execute: ${task}`,
      steps: validated,
    };
  } catch (err) {
    // Non-fatal: fall back to an empty plan — the orchestrator will treat it
    // as a single no-op step and emit a clear error verdict.
    console.error('[OrchestratorPlanner] Planning failed:', err.message);
    return { summary: `Execute: ${task}`, steps: [] };
  }
}

/**
 * Build a deterministic plan for known Milestone 1 task types.
 * Returns null for unknown types (caller falls through to LLM planning).
 *
 * @param {string} task
 * @param {string} taskType
 * @returns {{ summary: string, steps: import('./AgentState.js').PlanStep[] }|null}
 */
function buildFastPlan(task, taskType) {
  switch (taskType) {
    case 'open_application': {
      if (/\b(and|then)\b/i.test(task)) return null;
      const target = extractAppTarget(task);
      return {
        summary: `Open ${target}`,
        steps: [
          normalisePlanStep(
            {
              description: `Launch ${target}`,
              tool: 'app',
              action: 'openApp',
              params: { query: target },
            },
            0,
          ),
        ],
      };
    }

    case 'system_diagnostics':
      return {
        summary: 'Collect system hardware and performance diagnostics.',
        steps: [
          normalisePlanStep(
            {
              description: 'Get system information (OS, CPU model, memory)',
              tool: 'hardware',
              action: 'systemInfo',
              params: {},
            },
            0,
          ),
          normalisePlanStep(
            {
              description: 'Measure current CPU usage',
              tool: 'hardware',
              action: 'cpuUsage',
              params: {},
            },
            1,
          ),
          normalisePlanStep(
            {
              description: 'Get RAM usage and free memory',
              tool: 'hardware',
              action: 'memoryUsage',
              params: {},
            },
            2,
          ),
          normalisePlanStep(
            {
              description: 'List top processes by CPU usage',
              tool: 'process',
              action: 'list',
              params: { sortBy: 'cpu', limit: 10 },
            },
            3,
          ),
        ],
      };

    case 'wifi_diagnostics':
      return {
        summary: 'Diagnose WiFi adapter status and internet connectivity.',
        steps: [
          normalisePlanStep(
            {
              description: 'List network adapters and their connection status',
              tool: 'hardware',
              action: 'networkAdapters',
              params: {},
            },
            0,
          ),
          normalisePlanStep(
            {
              description: 'Get IP configuration for all adapters',
              tool: 'network',
              action: 'ipConfig',
              params: {},
            },
            1,
          ),
          normalisePlanStep(
            {
              description: 'Ping Google DNS (8.8.8.8) to test internet reachability',
              tool: 'network',
              action: 'ping',
              params: { host: '8.8.8.8', count: 4 },
            },
            2,
          ),
        ],
      };

    default:
      return null;
  }
}

/**
 * Normalise a raw plan step into the canonical PlanStep shape.
 *
 * @param {{ description: string, tool: string, action: string, params: Object }} raw
 * @param {number} index
 * @returns {import('./AgentState.js').PlanStep}
 */
function normalisePlanStep(raw, index) {
  const allowed = ACTION_LOOKUP.get(`${raw.tool}.${raw.action}`);
  const mergedParams = {
    ...(allowed?.defaultParams || {}),
    ...(raw.params || {}),
  };

  return {
    index,
    ...(raw.toolCallId != null || raw.id != null ? { toolCallId: raw.toolCallId ?? raw.id } : {}),
    description: String(raw.description || `${raw.tool}.${raw.action}`),
    tool: raw.tool,
    action: raw.action,
    params: mergedParams,
    status: 'pending',
    observation: null,
  };
}

/**
 * Validate LLM-generated steps against the allowed manifest.
 * Invalid mandatory steps invalidate the complete plan.
 * Exported so Replanner can reuse the same validation logic.
 *
 * @param {Array} rawSteps
 * @param {number} [startIndex=0] - Index offset for replanned steps.
 * @returns {import('./AgentState.js').PlanStep[]}
 */
export function validateAndNormaliseLLMSteps(rawSteps, startIndex = 0, completedSteps = [], task) {
  return validateAndNormaliseSteps(rawSteps, startIndex, completedSteps, task);
}

function validateAndNormaliseSteps(rawSteps, startIndex = 0, completedSteps = [], task) {
  const valid = [];
  if (!Array.isArray(rawSteps) || rawSteps.length > 5) return [];
  for (const raw of rawSteps.slice(0, 5)) {
    if (typeof raw !== 'object' || !raw) return [];
    const key = `${raw.tool}.${raw.action}`;
    if (!ACTION_LOOKUP.has(key)) {
      console.warn(`[OrchestratorPlanner] Dropping unknown step: ${key}`);
      return [];
    }
    const allowed = ACTION_LOOKUP.get(key);

    if (
      Object.hasOwn(raw, 'params') &&
      (!raw.params || typeof raw.params !== 'object' || Array.isArray(raw.params))
    )
      return [];
    const params = { ...allowed.defaultParams, ...(raw.params ?? {}) };
    if (validateCapability(raw.tool, raw.action, params)) return [];
    if (
      raw.tool === 'app' &&
      raw.action === 'resolveTarget' &&
      task &&
      !task.toLowerCase().includes(params.query.toLowerCase())
    )
      return [];
    if (
      params.targetFromStep &&
      ![...completedSteps.filter((s) => s.status === 'done'), ...valid].some(
        (s) =>
          s.toolCallId === params.targetFromStep &&
          s.tool === 'app' &&
          s.action === 'resolveTarget',
      )
    )
      return [];

    if (raw.tool === 'app' && raw.action === 'openWithTarget' && !params.targetFromStep) return [];
    valid.push(normalisePlanStep(raw, startIndex + valid.length));
  }
  return valid;
}

/**
 * Extract the application name/path from a user task string.
 * Falls back to 'notepad' if nothing recognisable is found.
 *
 * @param {string} task
 * @returns {string}
 */
function extractAppTarget(task) {
  return task
    .replace(/^.*?\b(?:open|launch|start|run)\s+/i, '')
    .replace(/\s+please[.!]?$/i, '')
    .trim();
}
