/**
 * @module agent/agentBrain
 * @description The reasoning core of the autonomous Windows-fix agent.
 * Uses a ReAct-style JSON protocol: each turn the model receives the goal
 * plus every command it has already run (and their output), and returns a
 * single JSON decision — either the next PowerShell command to run, or a
 * final answer / recommendation.
 *
 * A strict JSON contract (via Ollama `format: "json"`) is used instead of
 * native tool-calling so the loop works reliably across models.
 */

import { config } from '../config.js';

/**
 * Model used for agent reasoning. Overridable per request or via AGENT_MODEL.
 * Defaults to qwen3 (already installed, strong at JSON/tool reasoning).
 * qwen2.5 also works — `ollama pull qwen2.5` then set AGENT_MODEL=qwen2.5.
 */
export const AGENT_DEFAULT_MODEL = process.env.AGENT_MODEL || 'qwen3';

const SYSTEM_PROMPT = `You are Chanakya-Fix, an autonomous Windows troubleshooting agent running locally on the user's PC. You diagnose and fix Windows problems by running PowerShell commands one at a time.

You have exactly ONE tool: a Windows PowerShell terminal.

STRICT OUTPUT CONTRACT — every turn you reply with ONE JSON object and nothing else:
{
  "thought": "<short reasoning about the current situation and your next move>",
  "command": "<a single PowerShell command to run, or null>",
  "done": <true or false>,
  "answer": "<final explanation + recommendation for the user, or null>"
}

RULES:
- Work in small steps. First DIAGNOSE with read-only commands (Get-*, Test-*, ipconfig, etc.), understand the root cause, THEN apply a fix.
- Put exactly one PowerShell command in "command". No markdown, no backticks, no comments — just the command text.
- When "done" is false, "command" must be a non-null command and "answer" must be null.
- When you have solved the problem OR you have exhausted safe options, set "done" true, "command" null, and write a clear "answer".
- If a command's output shows the problem is fixed, verify it, then finish.
- The system may report a command as BLOCKED (too destructive to auto-run). If so, do NOT retry it — find a safer alternative, or finish with "done" true and recommend the manual step in "answer".
- Never assume; base every conclusion on real command output.
- Keep commands non-interactive (they run with -NonInteractive). Avoid commands that prompt or hang.
- Prefer built-in Windows diagnostics: Get-NetAdapter, Test-NetConnection, Get-Service, Get-WinEvent, Get-PnpDevice, Get-Volume, sfc, DISM, ipconfig, etc.

COMMON FIX RECIPES (use the right one for the problem):
- Bluetooth / Wi-Fi radio turned OFF: this is a software radio toggle, NOT a disabled device. Use the Windows Radios API, e.g.:
  [Windows.Devices.Radios.Radio,Windows.System.Devices,ContentType=WindowsRuntime] | Out-Null; $r=(Await ([Windows.Devices.Radios.Radio]::GetRadiosAsync()) ...); then SetStateAsync('On'). If the async WinRT call is impractical non-interactively, enable the related service (bthserv for Bluetooth) with Set-Service/Start-Service and report that the radio may need a manual toggle in Settings.
- Disabled hardware device: Get-PnpDevice shows Status 'Error'/'Disabled' -> Enable-PnpDevice -InstanceId <id> -Confirm:$false (needs admin).
- Network adapter issues: Restart-NetAdapter -Name <n>; ipconfig /release; ipconfig /renew; ipconfig /flushdns; Clear-DnsClientCache.
- Stopped service: Start-Service / Restart-Service <name>.
- ADMIN RIGHTS: if a command fails with 'Access is denied' or 'requires elevation', do NOT keep retrying it. Finish and recommend the user run Chanakya (or the specific command) as Administrator, quoting the exact command.`;

function buildPrompt(goal, steps) {
  const transcript = steps.length
    ? steps
        .map((step, i) => {
          if (step.blocked) {
            return `STEP ${i + 1}\nCommand: ${step.command}\nResult: BLOCKED — ${step.reason} (not executed)`;
          }
          const out = [step.stdout, step.stderr && `STDERR: ${step.stderr}`]
            .filter(Boolean)
            .join('\n') || '(no output)';
          return `STEP ${i + 1}\nCommand: ${step.command}\nExit code: ${step.exitCode}${step.timedOut ? ' (TIMED OUT)' : ''}\nOutput:\n${out}`;
        })
        .join('\n\n')
    : '(no commands run yet)';

  return `USER PROBLEM:\n${goal}\n\nWORK SO FAR:\n${transcript}\n\nReply with your next JSON decision.`;
}

/**
 * Ask the model for its next decision.
 *
 * @param {Object} args
 * @param {string} args.goal - The user's problem statement.
 * @param {Array} args.steps - Prior steps: { command, stdout, stderr, exitCode, timedOut } or { command, blocked, reason }.
 * @param {string} [args.model] - Ollama model id.
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<{ thought: string, command: string|null, done: boolean, answer: string|null }>}
 */
export async function decideNextStep({ goal, steps = [], model = AGENT_DEFAULT_MODEL, systemPrompt = SYSTEM_PROMPT, signal }) {
  let response;
  try {
    response = await fetch(`${config.ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        model,
        system: systemPrompt,
        prompt: buildPrompt(goal, steps),
        format: 'json',
        stream: false,
        keep_alive: config.ollamaKeepAlive,
        options: { temperature: 0.1, num_ctx: 8192 },
      }),
    });
  } catch (error) {
    throw new Error(`Cannot reach Ollama at ${config.ollamaUrl}. Is it running? (${error.message})`);
  }

  if (!response.ok) {
    const detail = await response.text();
    if (response.status === 404) {
      throw new Error(`Model '${model}' not found. Run: ollama pull ${model}`);
    }
    throw new Error(`Ollama ${response.status}: ${detail || response.statusText}`);
  }

  const data = await response.json();
  const raw = (data.response || '').trim();

  let decision;
  try {
    decision = JSON.parse(raw);
  } catch {
    // Salvage the first JSON object if the model wrapped it in prose.
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error(`Agent model returned non-JSON output: ${raw.slice(0, 200)}`);
    }
    decision = JSON.parse(match[0]);
  }

  return {
    thought: typeof decision.thought === 'string' ? decision.thought : '',
    command: decision.command ? String(decision.command) : null,
    done: Boolean(decision.done),
    answer: decision.answer ? String(decision.answer) : null,
  };
}

export default decideNextStep;
