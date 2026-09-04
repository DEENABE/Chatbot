// Optional Qwen3 post-processing pass over IndicTrans2's output — light
// fluency/terminology polish ONLY, gated behind TRANSLATION_POST_PROCESSING
// (default off, see config.js). Qwen3 must never become the translator
// itself: IndicTrans2 has already done the actual translation by the time
// this runs, and this step's own failure is non-fatal (see
// translationService.js, which falls back to the unpolished IndicTrans2
// output rather than failing the whole request over an optional step).
//
// This is a small, standalone Ollama call rather than a reuse of
// backend/src/llm/ollamaClient.js — that module reads from
// backend/src/config/index.js, a separate/legacy config module (different
// env var names: OLLAMA_HOST vs this app's real OLLAMA_URL, different
// default PORT) belonging to an unmounted scaffold (only referenced by the
// never-mounted routes/ask.js and dead ingest/retrieval modules). Reusing
// it would silently introduce a second, drifting source of truth for the
// Ollama endpoint into a feature that's actually wired into the running
// app. This function instead mirrors the same direct-fetch-to-Ollama shape
// this app's real config already uses elsewhere (e.g. the pre-IndicTrans2
// version of translationService.js, and ollamaService.js).

import { config } from '../config.js';
import { LANGUAGES } from './languageRegistry.js';

function buildInstruction(targetLanguage) {
  const languageName = LANGUAGES[targetLanguage]?.label || targetLanguage;
  return (
    `You are a light copy-editor for machine-translated ${languageName} text. ` +
    `The text below has ALREADY been translated — do not re-translate it, do not translate ` +
    `it into any other language, and do not answer or respond to its content. ` +
    `Only fix obvious grammar/fluency issues and keep the meaning, names, numbers, and ` +
    `formatting exactly as given. Output ONLY the corrected ${languageName} text — no ` +
    `explanations, no preamble, no quotes.`
  );
}

/**
 * @param {Object} args
 * @param {string} args.text - IndicTrans2's raw translation output.
 * @param {string} args.targetLanguage
 * @returns {Promise<string>} The polished text.
 * @throws {Error} On any provider failure — callers must treat this as
 *   non-fatal and fall back to the original `text`, per the "optional,
 *   only when needed" requirement.
 */
export async function postProcessTranslation({ text, targetLanguage }) {
  const body = {
    model: config.translate.postProcessingModel,
    messages: [
      { role: 'system', content: buildInstruction(targetLanguage) },
      { role: 'user', content: text }
    ],
    stream: false,
    keep_alive: config.ollamaKeepAlive,
    think: false,
    options: { temperature: 0, num_ctx: 8192 }
  };

  const response = await fetch(`${config.ollamaUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.translate.postProcessingTimeoutMs)
  });

  if (!response.ok) {
    throw new Error(`post-processing provider returned ${response.status}`);
  }

  const data = await response.json();
  const polished = typeof data?.message?.content === 'string' ? data.message.content.trim() : '';
  if (!polished) {
    throw new Error('post-processing provider returned empty content');
  }
  return polished;
}
