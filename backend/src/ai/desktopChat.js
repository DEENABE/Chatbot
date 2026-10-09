import { config } from '../config.js';
import { DEFAULT_MODEL } from './llmClient.js';
import { modelRuntime, routedModelOr } from '../services/modelRuntime.js';
import {
  desktopToolsForSnapshot,
  compactDesktopTool,
  desktopToolParameters,
  DESKTOP_TOOL_SYSTEM,
} from '../orchestrator/DesktopPrimitiveTools.js';
const error = (message, code = 'INVALID_MODEL_TOOL_CALL') =>
  Object.assign(new Error(message), { code });
/** One Ollama /api/chat decision. Execution and recursive turns remain in the
 * existing bounded controller; a model response can never execute a batch. */
export async function nextDesktopTool({
  prompt,
  history = [],
  snapshot,
  model = routedModelOr(DEFAULT_MODEL),
  signal,
  fetchImpl = fetch,
  timeoutMs = Number(process.env.DESKTOP_MODEL_TIMEOUT_MS) || 240000,
  compact = !!snapshot && process.env.DESKTOP_TOOL_PROTOCOL !== 'individual',
}) {
  // Callers (e.g. GenericAppPlanner) may pass an empty default: follow the model this request was routed to.
  model = model || routedModelOr(DEFAULT_MODEL);
  if (!model) throw error('No local model is selected. No action was executed.', 'MODEL_NOT_FOUND');
  const catalog = desktopToolsForSnapshot(snapshot),
    offered = new Set(catalog.map((t) => t.function.name)),
    tools = compact ? [compactDesktopTool(catalog)] : catalog;
  const deadline = AbortSignal.timeout(Math.max(1000, Math.min(timeoutMs, 600000)));
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const messages = [{ role: 'system', content: DESKTOP_TOOL_SYSTEM }];
  let previous;
  for (const h of history) {
    const snapshot = h.data?.snapshot || (h.data?.status === 'UI_OBSERVED' ? h.data : null);
    if (
      !h.toolName?.startsWith('desktop_') ||
      !Object.hasOwn(desktopToolParameters, h.toolName.slice(8))
    ) {
      previous = snapshot || previous;
      continue;
    }
    // Replay bounded protocol history, stripping UI text and field values from
    // older results. The current snapshot is supplied in full below.
    const shape = desktopToolParameters[h.toolName.slice(8)],
      args = Object.fromEntries(
        Object.entries(h.toolArguments || {}).filter(([k]) => Object.hasOwn(shape.properties, k)),
      );
    if (args.elementId && previous) {
      const index = previous.elements?.findIndex((e) => e.elementId === args.elementId);
      if (index >= 0) args.elementId = `e${index}`;
    }
    previous = snapshot || previous;
    if (history.indexOf(h) < history.length - 3) continue;
    messages.push({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          function: {
            name: compact ? 'desktop_action' : h.toolName,
            arguments: compact ? { action: h.toolName.slice(8), ...args } : args,
          },
        },
      ],
    });
    messages.push({
      role: 'tool',
      tool_name: compact ? 'desktop_action' : h.toolName,
      content: JSON.stringify({
        success: h.success,
        status: h.data?.status,
        error: h.error?.code,
        verification: h.data?.verification,
        operation: h.data?.operation,
        targetLabel: h.data?.targetLabel,
      }),
    });
  }
  // The tool schemas already describe keys. Avoid repeating the legacy key
  // guide and previous results in both protocol history and the current UI.
  let current = prompt;
  try {
    const p = JSON.parse(prompt);
    if (p.UNTRUSTED_UI_DATA?.input) delete p.UNTRUSTED_UI_DATA.input.keyGuide;
    delete p.recentAttempts;
    current = JSON.stringify(p);
  } catch {}
  messages.push({ role: 'user', content: current });
  // Do not silently truncate the system/task when an application exposes a
  // large UI. Grow context conservatively or reject before proposing an action.
  const estimatedTokens =
    Math.ceil(Buffer.byteLength(JSON.stringify({ messages, tools }), 'utf8') / 2) + 512;
  const configuredContext = modelRuntime.getStore()?.options?.num_ctx || 32768;
  if (estimatedTokens > Math.min(32768, configuredContext))
    throw error(
      'The observed UI exceeds the local decision context budget. Narrow the view before continuing.',
      'MODEL_CONTEXT_TOO_LARGE',
    );
  const numCtx =
    estimatedTokens <= 4096
      ? 4096
      : estimatedTokens <= 8192
        ? 8192
        : estimatedTokens <= 16384
          ? 16384
          : 32768;
  let response;
  const started = Date.now();
  try {
    response = await fetchImpl(`${config.ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: combined,
      body: JSON.stringify({
        model,
        messages,
        tools,
        stream: false,
        think: false,
        keep_alive: modelRuntime.getStore()?.keepAlive ?? config.ollamaKeepAlive,
        options: {
          temperature: 0,
          num_ctx: Math.min(numCtx, configuredContext),
          num_predict: 256,
        },
      }),
    });
  } catch (e) {
    if (signal?.aborted) throw signal.reason;
    if (deadline.aborted)
      throw error(
        'The local model exceeded its desktop decision deadline. No action was executed.',
        'MODEL_TIMEOUT',
      );
    throw error(
      'The local model could not be reached. No action was executed.',
      'MODEL_UNAVAILABLE',
    );
  }
  if (!response.ok)
    throw error(
      `Local Ollama returned ${response.status}.`,
      response.status === 404 ? 'MODEL_NOT_FOUND' : 'MODEL_UNAVAILABLE',
    );
  const body = await response.json(),
    calls = body.message?.tool_calls;
  if (process.env.CHANAKYA_DEBUG_MODEL === '1')
    console.warn(
      '[desktop model]',
      JSON.stringify({
        elapsedMs: Date.now() - started,
        tools: tools.length,
        promptTokens: body.prompt_eval_count,
        loadMs: body.load_duration / 1e6,
        promptMs: body.prompt_eval_duration / 1e6,
        outputTokens: body.eval_count,
        outputMs: body.eval_duration / 1e6,
      }),
    );
  if (!Array.isArray(calls) || calls.length !== 1)
    throw error('The model must choose exactly one tool.');
  const call = calls[0].function;
  let name = call?.name;
  let args = call?.arguments;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      throw error('Invalid tool arguments.');
    }
  }
  if (compact) {
    if (name !== 'desktop_action' || !args || typeof args.action !== 'string')
      throw error('The model must choose one fixed desktop action.');
    name = 'desktop_' + args.action;
    args = { ...args };
    delete args.action;
    // Qwen may supply a target for type even though type(text) is scoped to
    // the focused field. Accept that redundant target ONLY when it exactly
    // identifies the observed focused field. Never silently discard a target
    // for another field or any arbitrary/unknown argument.
    if (name === 'desktop_type' && Object.hasOwn(args, 'elementId')) {
      const target = /^e\d{1,4}$/.test(args.elementId)
        ? snapshot?.elements?.[Number(args.elementId.slice(1))]
        : null;
      const boundId = (snapshot?.input?.typeTarget || snapshot?.input?.focusedTextField)?.elementId;
      if (!target || typeof boundId !== 'string' || !boundId || target.elementId !== boundId)
        throw error('Typing target is not the current bound text field.');
      delete args.elementId;
    }
  }
  if (typeof name !== 'string' || !offered.has(name))
    throw error('The model chose an unavailable desktop tool.');
  const schema = desktopToolParameters[name.slice(8)];
  if (
    !args ||
    Array.isArray(args) ||
    typeof args !== 'object' ||
    Object.keys(args).some((k) => !Object.hasOwn(schema.properties, k)) ||
    schema.required.some((k) => !Object.hasOwn(args, k))
  )
    throw error(
      `Tool arguments for ${name.slice(8)} do not match the fixed tool (${args && typeof args === 'object' ? Object.keys(args).join(',') : 'invalid object'}).`,
    );
  return { kind: name.slice(8), ...args, primitive: true };
}
