import { tools, catalog } from './catalog.mjs';
import { errorResult, canonical } from './executor.mjs';
import { SYSTEM_PROMPT } from './prompt.mjs';

export async function ollamaChat(config, messages, signal) {
  const response = await fetch(`${config.ollamaUrl}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.model, stream: false, think: config.think === true, messages, tools, options: { temperature: 0, num_ctx: 16384, num_predict: 1024 } }),
    signal: AbortSignal.any([AbortSignal.timeout(config.ollamaTimeout), ...(signal ? [signal] : [])])
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Ollama returned HTTP ${response.status}`); }
  const reader = response.body.getReader();
  let bytes = 0;
  const chunks = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 1024 * 1024) { await reader.cancel(); throw new Error('Ollama response exceeded 1 MiB'); }
    chunks.push(Buffer.from(value));
  }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (body.error || body.message?.role !== 'assistant') throw new Error(body.error || 'Invalid Ollama response');
  return body.message;
}
export async function runAgent({ session, message, allowChanges, signal, executor, config, chat = ollamaChat }) {
  const history = [{ role: 'system', content: SYSTEM_PROMPT }, ...session.messages, { role: 'user', content: message }];
  const events = [];
  const seenWrites = new Set();
  const commit = answer => {
    // Persist only user/final assistant turns, never dangling tool calls or instructions supplied by a client.
    session.messages.push({ role: 'user', content: message }, { role: 'assistant', content: answer });
    while (session.messages.length > 12 || JSON.stringify(session.messages).length > 24000) session.messages.splice(0, 2);
    return { sessionId: session.id, answer, events };
  };
  for (let step = 0; step < config.maxSteps; step++) {
    if (signal?.aborted) throw new Error('Request cancelled');
    if (JSON.stringify(history).length > 70000) return commit('The tool context limit was reached. Inspect the returned results before continuing.');
    const assistant = await chat(config, history, signal);
    history.push(assistant); // Preserve thinking and tool_calls exactly as Ollama supplied them.
    const calls = assistant.tool_calls;
    if (!calls?.length) return commit(assistant.content || 'No further action was requested.');
    if (!Array.isArray(calls) || calls.length > 8) return commit('The model exceeded the per-step tool budget; no calls in this batch were executed.');
    for (const call of calls) {
      const name = call.function?.name;
      let result;
      try {
        const args = typeof call.function?.arguments === 'string' ? JSON.parse(call.function.arguments) : call.function?.arguments;
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be an object');
        if (name === 'list_capabilities') {
          if (Object.keys(args).some(k => k !== 'category') || (args.category !== undefined && (typeof args.category !== 'string' || args.category.length > 40))) throw new Error('Invalid category arguments');
          result = { ok: true, data: Object.values(catalog).filter(c => !args.category || c.id.startsWith(args.category + '.')), policy: await executor.policyInfo(args.category) };
        } else if (name === 'run_operation') {
          if (Object.keys(args).some(k => !['operation', 'parameters'].includes(k))) throw new Error('Unknown tool argument');
          const key = canonical(args);
          if (seenWrites.has(key)) result = errorResult('DUPLICATE_WRITE', 'This exact write was already requested in this turn; query state instead');
          else {
            result = await executor.invoke(args.operation, args.parameters, { sessionId: session.id, allowChanges, signal });
            if (catalog[args.operation]?.risk !== 'read') seenWrites.add(key);
          }
        } else result = errorResult('UNKNOWN_TOOL', 'Only list_capabilities and run_operation are available');
      } catch (err) { result = errorResult('INVALID_TOOL_CALL', err.message); }
      events.push({ tool: name, arguments: call.function?.arguments, result });
      history.push({ role: 'tool', tool_name: name || 'unknown', content: JSON.stringify(result) });
      if (result.status === 'approval_required') return commit(`Approval is required for ${result.plan.operation}: ${result.plan.description} Review the plan in the response before approving it. No change has been made by this plan.`);
      if (result.error?.outcomeUnknown) return commit(`The operation outcome is uncertain: ${result.error.message} Inspect the current state before retrying.`);
    }
  }
  return commit('The execution-step limit was reached. Review the returned results; no further actions were taken.');
}
