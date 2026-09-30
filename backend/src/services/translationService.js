import { config } from '../config.js';
import { isSupportedPair } from './languageRegistry.js';
import { applyGlossary } from './glossary.js';
import { postProcessTranslation } from './translationPostProcess.js';

/**
 * @module services/translationService
 * @description Translation orchestration: validate -> glossary -> call the
 * IndicTrans2 microservice -> optional Qwen post-processing -> return.
 *
 * The actual translation engine is AI4Bharat's IndicTrans2, running in a
 * separate local Python process (indictrans-service/ at the repo root),
 * reached over loopback HTTP — the same pattern this app already uses for
 * Ollama. Qwen is NOT the translator; it is only ever an optional,
 * disabled-by-default polish pass over IndicTrans2's own output (see
 * translationPostProcess.js and config.js's translate.postProcessingEnabled).
 *
 * Re-exported here for routes/translate.js's convenience; the registry
 * itself lives in languageRegistry.js since the Python service needs the
 * equivalent list independently (see indictrans-service/app/languages.py)
 * and Node's copy shouldn't be nested inside this file's concerns.
 */
export { LANGUAGES, LANGUAGE_CODES, ENGLISH, AUTO, isSupportedPair } from './languageRegistry.js';

/**
 * A translation failure whose `message` was authored here specifically to be
 * safe to show a client. The raw provider detail goes in `detail`, which the
 * route logs server-side (with the request correlation id) and never returns.
 * Deliberately NOT a 4xx `.status` — app.js's generic error handler echoes
 * 4xx messages, and these are 5xx-class failures the route handles itself.
 */
export class TranslationError extends Error {
  constructor(status, message, detail) {
    super(message);
    this.name = 'TranslationError';
    this.status = status;
    this.detail = detail;
  }
}

/**
 * Translate `text` between two supported languages via the IndicTrans2
 * microservice, with optional glossary substitution and optional Qwen
 * post-processing.
 *
 * Callers are expected to have validated inputs already (routes/translate.js
 * does, including resolving `auto` to a concrete language before calling
 * this); this re-checks the language codes as a defense-in-depth guard,
 * matching the same style already used elsewhere (e.g.
 * middleware/auth.js's UUID re-check).
 *
 * @param {Object} args
 * @param {string} args.text - Untrusted user text to translate.
 * @param {string} args.sourceLanguage - A concrete language code (never 'auto').
 * @param {string} args.targetLanguage
 * @returns {Promise<string>} The translated text.
 * @throws {TranslationError} With a client-safe message on any failure.
 */
export async function translateText({ text, sourceLanguage, targetLanguage }) {
  if (!isSupportedPair(sourceLanguage, targetLanguage)) {
    // Unreachable via the route under normal use (requireEnum + the
    // same-language short-circuit run first) — kept as defense-in-depth.
    throw new TranslationError(400, 'Unsupported language pair.', 'language pair escaped route validation');
  }

  const glossaryApplied = applyGlossary(text, sourceLanguage, targetLanguage);

  const rawTranslation = await callIndicTrans2({
    text: glossaryApplied,
    sourceLanguage,
    targetLanguage
  });

  if (!config.translate.postProcessingEnabled) {
    return rawTranslation;
  }

  try {
    return await postProcessTranslation({ text: rawTranslation, targetLanguage });
  } catch (error) {
    // Post-processing is explicitly optional ("ONLY when needed") — its
    // failure must never fail a translation that already succeeded.
    console.error('[translate] post-processing failed, returning unpolished translation:', error.message);
    return rawTranslation;
  }
}

async function callIndicTrans2({ text, sourceLanguage, targetLanguage }) {
  let response;
  try {
    response = await fetch(`${config.translate.serviceUrl}/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source_lang: sourceLanguage, target_lang: targetLanguage, text }),
      // Never let one translation hang a request slot forever.
      signal: AbortSignal.timeout(config.translate.serviceTimeoutMs)
    });
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      throw new TranslationError(
        504,
        'Translation timed out. Try a shorter text, or try again.',
        `IndicTrans2 service call exceeded ${config.translate.serviceTimeoutMs}ms`
      );
    }
    throw new TranslationError(
      503,
      'Translation service is unavailable. Make sure the local translation engine is running.',
      `IndicTrans2 service unreachable at ${config.translate.serviceUrl}: ${error.message}`
    );
  }

  if (!response.ok) {
    // Structured {error_code, detail} from indictrans-service/app/main.py.
    // The raw `detail` (which can include a filesystem path or library
    // internals) is logged server-side only, never echoed to the client —
    // same split every other provider-failure path in this app already uses.
    const body = await response.json().catch(() => null);
    const errorCode = body?.error_code;
    const detail = body?.detail || `HTTP ${response.status}`;

    if (errorCode === 'MODEL_NOT_LOADED') {
      throw new TranslationError(
        503,
        'The translation model is not installed or not loaded. See indictrans-service/README.md for setup.',
        detail
      );
    }
    if (errorCode === 'UNSUPPORTED_PAIR') {
      throw new TranslationError(400, 'That language pair is not supported.', detail);
    }
    if (errorCode === 'EMPTY_OUTPUT') {
      throw new TranslationError(502, 'Translation failed. Try again.', detail);
    }
    throw new TranslationError(502, 'Translation failed. Try again.', `IndicTrans2 service ${response.status}: ${detail}`);
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new TranslationError(502, 'Translation failed. Try again.', 'IndicTrans2 service returned a non-JSON body');
  }

  const translation = typeof data?.translation === 'string' ? data.translation.trim() : '';
  if (!translation) {
    throw new TranslationError(502, 'Translation failed. Try again.', 'IndicTrans2 service returned no translation');
  }
  return translation;
}
