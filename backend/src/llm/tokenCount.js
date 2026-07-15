import { config } from '../config/index.js';

/**
 * Rough token estimate without loading a real tokenizer.
 * ~4 characters per token is a reasonable heuristic for English text
 * across Llama/Qwen/Mistral/Gemma tokenizers. Good enough for budgeting
 * context before a request; exact counts come back from Ollama after
 * the call (see ollamaClient.chatCompletion).
 */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Throws if a prompt is likely to exceed the model's context window,
 * accounting for how many tokens you want to leave free for the
 * model's completion.
 */
export function assertWithinContextLimit(model, promptText, maxCompletionTokens = 512) {
  const estimated = estimateTokens(promptText);
  const limit = config.contextLimits[model] ?? 8192;

  if (estimated + maxCompletionTokens > limit) {
    const err = new Error(
      `Prompt too long for ${model}: ~${estimated} tokens + ${maxCompletionTokens} reserved > ${limit} limit`
    );
    err.status = 413;
    throw err;
  }
  return estimated;
}
