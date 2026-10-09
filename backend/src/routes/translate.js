import { Router } from 'express';
import { config } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { translateLimiter } from '../middleware/rateLimiter.js';
import { requireEnum, requireString, ValidationError } from '../lib/validate.js';
import { LANGUAGE_CODES, AUTO } from '../services/languageRegistry.js';
import { detectLanguage } from '../services/languageDetect.js';
import { translateWithEngine, TranslationError } from '../services/translationService.js';

// sourceLanguage may additionally be 'auto'; targetLanguage never can be —
// there is no such thing as an auto-detected *destination*.
const SOURCE_LANGUAGE_CODES = [...LANGUAGE_CODES, AUTO];

/**
 * POST /api/translate
 *
 * Body:    { text, sourceLanguage, targetLanguage }
 * Success: { translation }
 *
 * Middleware order matters: requireAuth first (the same session middleware
 * every other protected route uses — no second auth system), then
 * translateLimiter, which keys its budget on the verified request.userId
 * that requireAuth just attached. Nothing identity- or role-related is ever
 * read from the request body.
 *
 * The response carries only the translated string — no provider metadata,
 * no model internals, and (it bears stating) no credentials: the actual
 * engine is IndicTrans2 in a local Python service, reached the same way
 * this app reaches Ollama, with nothing remote and nothing to leak.
 */
export const translateRouter = Router();

translateRouter.post('/', requireAuth, translateLimiter, async (request, response, next) => {
  const startedAt = Date.now();
  try {
    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ValidationError('Request body must be a JSON object.');
    }

    // Language codes are validated against the server-side allowlist before
    // anything else — an unsupported code is rejected here and can never
    // reach the provider or a prompt.
    const requestedSource = requireEnum(
      body.sourceLanguage,
      'sourceLanguage',
      SOURCE_LANGUAGE_CODES,
    );
    const targetLanguage = requireEnum(body.targetLanguage, 'targetLanguage', LANGUAGE_CODES);
    // requireString rejects non-strings, empty/whitespace-only text, and
    // oversized text (server-side cap — the UI's counter is cosmetic).
    const text = requireString(body.text, 'text', {
      min: 1,
      max: config.translate.maxChars,
    });

    // This route is the one place responsible for turning "auto" into a
    // concrete language — translateText() itself never has to know what
    // "auto" means, so a value that somehow slipped through unresolved
    // would just fail its own registry check (a safe failure), not be
    // silently misinterpreted deeper in the call chain.
    let sourceLanguage = requestedSource;
    if (requestedSource === AUTO) {
      const detected = detectLanguage(text);
      if (!detected.language) {
        throw new ValidationError(
          'Could not confidently detect the source language. Please select it manually.',
        );
      }
      sourceLanguage = detected.language;
    }

    // Same source and target: a no-op by definition. Answer directly rather
    // than paying for a provider round trip that can only echo or mangle.
    // Runs AFTER auto-resolution so "auto" resolving to the same language
    // as the target still short-circuits correctly.
    if (sourceLanguage === targetLanguage) {
      return response.json({ translation: text });
    }

    const { translation, engine } = await translateWithEngine({
      text,
      sourceLanguage,
      targetLanguage,
      userId: request.userId,
    });

    // Structured, operational logging only — source/target/size/timing/
    // engine, never the text or its translation. Matches this app's
    // existing no-content-logging convention (see e.g. authService.js's
    // PASSWORD_RESET_* markers).
    const durationMs = Date.now() - startedAt;
    console.log(
      `[${request.id || '-'}] [translate] source=${sourceLanguage} target=${targetLanguage} ` +
        `chars=${text.length} durationMs=${durationMs} engine=${engine}`,
    );

    return response.json({ translation });
  } catch (error) {
    if (error instanceof TranslationError) {
      // The safe, deliberately-authored message goes to the client; the raw
      // provider detail goes only to the server log, tagged with this
      // request's correlation id. The user's text is never logged.
      console.error(`[${request.id || '-'}] [translate] ${error.detail || error.message}`);
      return response.status(error.status).json({ error: error.message });
    }
    // ValidationError (400) and anything unexpected: the shared app-level
    // error handler already does the right thing for both.
    return next(error);
  }
});
