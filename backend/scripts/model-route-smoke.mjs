import { discoverModels, selectModelRoute } from '../src/services/modelRouter.js';
import { streamChat, listLoadedModels } from '../src/services/ollamaService.js';
const models = await discoverModels({ refresh: true });
const preferences = { keepAlive: '0', contextWindow: 2048 };
for (const route of ['general', 'windows']) {
  const selected = selectModelRoute({
    models,
    preferences,
    ...(route === 'windows' ? { computerRequest: { requiresTools: true } } : {}),
  });
  const started = Date.now();
  let firstTokenMs = null;
  try {
    const result = await streamChat({
      model: selected.model,
      messages: [
        {
          role: 'system',
          content:
            route === 'general'
              ? 'Return exactly the requested text.'
              : 'You may propose the single offered inventory_probe tool. Propose it once with empty arguments. Do not execute anything or claim any application discovery.',
        },
        {
          role: 'user',
          content:
            route === 'general'
              ? 'Reply with exactly LOCAL GENERAL OK'
              : 'Propose inventory_probe with empty arguments.',
        },
      ],
      ...(route === 'windows'
        ? {
            tools: [
              {
                type: 'function',
                function: {
                  name: 'inventory_probe',
                  description: 'A test-only proposal; it will not execute any operation.',
                  parameters: {
                    type: 'object',
                    properties: {},
                    additionalProperties: false,
                  },
                },
              },
            ],
          }
        : {}),
      ...(selected.capabilities.includes('thinking') ? { think: false } : {}),
      keepAlive: '0',
      options: { num_ctx: 2048, num_predict: 96, temperature: 0 },
      signal: AbortSignal.timeout(90_000),
      onToken: () => {
        firstTokenMs ??= Date.now() - started;
      },
    });
    const valid =
      route === 'general'
        ? result.text.includes('LOCAL GENERAL OK') && result.toolCalls.length === 0
        : result.toolCalls.some((call) => call.function?.name === 'inventory_probe');
    console.log(
      JSON.stringify({
        route,
        model: selected.model,
        passed: valid,
        text: result.text.slice(0, 160),
        proposedTools: result.toolCalls.map((call) => call.function?.name),
        executedTools: 0,
        elapsedMs: Date.now() - started,
        firstTokenMs,
        metrics: result.metrics,
      }),
    );
    if (!valid) process.exitCode = 1;
  } catch (error) {
    console.log(
      JSON.stringify({
        route,
        model: selected.model,
        passed: false,
        error: error.message,
        elapsedMs: Date.now() - started,
        executedTools: 0,
      }),
    );
    process.exitCode = 1;
  }
}
console.log(
  JSON.stringify({
    loadedAfter: (await listLoadedModels()).map((item) => item.name),
  }),
);
