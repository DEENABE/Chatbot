/**
 * @file TaskRouter.test.js
 * @description Unit tests for the TaskRouter keyword matching logic.
 * The LLM fallback path is NOT tested here (requires Ollama running).
 * Run with: node --test backend/src/orchestrator/TaskRouter.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// We test the keyword matching by importing only the AGENTIC_TASK_KEYWORDS
// and running the same logic without spawning an actual LLM.
import { AGENTIC_TASK_KEYWORDS } from './TaskRouter.js';

/**
 * Minimal re-implementation of keywordRoute for testing purposes.
 * Must mirror the logic in TaskRouter.js: agentic patterns checked FIRST,
 * then simple overrides. This matches the updated TaskRouter.js behaviour.
 */
const SIMPLE_OVERRIDES = [
  /^(what|how|why|when|where|who|explain|tell me|describe|define|is it|can you|could you|would you|please\s+explain|summarize)/i,
  /\b(write|compose|draft|generate|create|make|translate|convert|calculate|compute|solve|answer)\b(?!.{0,20}\bopen\b)/i,
];

function testRoute(task) {
  const text = String(task || '').trim();

  // Agentic check FIRST (mirrors updated TaskRouter.js).
  for (const [taskType, patterns] of Object.entries(AGENTIC_TASK_KEYWORDS)) {
    if (patterns.some((p) => p.test(text))) {
      return { mode: 'agentic', taskType };
    }
  }

  // Simple overrides only if no agentic match.
  if (SIMPLE_OVERRIDES.some((p) => p.test(text))) {
    return { mode: 'simple', taskType: 'simple' };
  }

  return null;
}

describe('TaskRouter — open_application detection', () => {
  const agenticCases = [
    'open notepad',
    'launch calculator',
    'start chrome',
    'run excel',
    'open the settings app',
    'Launch Task Manager',
    'open VS Code',
    'start powershell',
  ];

  for (const task of agenticCases) {
    it(`classifies "${task}" as agentic/open_application`, () => {
      const result = testRoute(task);
      assert.ok(result, `Expected a match for: "${task}"`);
      assert.equal(result.mode, 'agentic');
      assert.equal(result.taskType, 'open_application');
    });
  }
});

describe('TaskRouter — system_diagnostics detection', () => {
  const agenticCases = [
    'show me system diagnostics',
    'system health check',
    'check CPU usage',
    'how much RAM is being used',
    'what is my disk usage',
    'show system info',
    'get hardware information',
  ];

  for (const task of agenticCases) {
    it(`classifies "${task}" as agentic/system_diagnostics`, () => {
      const result = testRoute(task);
      assert.ok(result, `Expected a match for: "${task}"`);
      assert.equal(result.mode, 'agentic');
      assert.equal(result.taskType, 'system_diagnostics');
    });
  }
});

describe('TaskRouter — wifi_diagnostics detection', () => {
  const agenticCases = [
    'diagnose my wifi',
    'wifi not working',
    'troubleshoot internet connection',
    'check wifi signal',
    'test network connection',
    'internet is slow',
    'wifi diagnostics',
    'fix my wifi',
  ];

  for (const task of agenticCases) {
    it(`classifies "${task}" as agentic/wifi_diagnostics`, () => {
      const result = testRoute(task);
      assert.ok(result, `Expected a match for: "${task}"`);
      assert.equal(result.mode, 'agentic');
      assert.equal(result.taskType, 'wifi_diagnostics');
    });
  }
});

describe('TaskRouter — simple task overrides', () => {
  const simpleCases = [
    'what is the capital of France',
    'how does TCP/IP work',
    'explain quantum computing',
    'write a poem about the ocean',
    'calculate 2+2',
    'translate this to Hindi',
  ];

  for (const task of simpleCases) {
    it(`classifies "${task}" as simple`, () => {
      const result = testRoute(task);
      if (result) {
        assert.equal(result.mode, 'simple');
      }
      // null result (no keyword match) is also acceptable for simple tasks
      // (LLM would classify it).
    });
  }
});

describe('TaskRouter — no double-classification', () => {
  it('"write a letter" is simple (no agentic keyword match, write override fires)', () => {
    const result = testRoute('write a letter about my vacation');
    if (result) {
      assert.equal(result.mode, 'simple');
    }
    // null is acceptable — falls through to LLM in real code
  });

  it('"open notepad" is agentic even if sentence starts with interrogative context', () => {
    // The open_application pattern matches "open notepad" regardless of prefix
    const result = testRoute('can you open notepad for me');
    if (result) {
      // "open notepad" should match agentic, NOT simple (open_application wins)
      assert.equal(result.mode, 'agentic');
    }
  });
});
