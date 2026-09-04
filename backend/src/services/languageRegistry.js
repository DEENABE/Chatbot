// FLORES-200-style language identifiers this app's translator supports.
// Mirrors indictrans-service/app/languages.py — the two lists must be kept
// in sync when a language is added. Adding a language: add one entry
// here (and the matching Python-side entry), confirm the IndicTrans2
// checkpoint actually covers it, and add its native-script display data
// to the frontend's LANGUAGES array. No other code needs to change —
// routes/translate.js, translationService.js, and the rate limiter all
// read from this registry rather than hardcoding a language list.

export const ENGLISH = 'eng_Latn';

export const LANGUAGES = Object.freeze({
  eng_Latn: { label: 'English', native: 'English', script: 'Latin' },
  hin_Deva: { label: 'Hindi', native: 'हिन्दी', script: 'Devanagari' },
  tam_Taml: { label: 'Tamil', native: 'தமிழ்', script: 'Tamil' },
  kan_Knda: { label: 'Kannada', native: 'ಕನ್ನಡ', script: 'Kannada' },
  tel_Telu: { label: 'Telugu', native: 'తెలుగు', script: 'Telugu' },
  mal_Mlym: { label: 'Malayalam', native: 'മലയാളം', script: 'Malayalam' }
});

export const LANGUAGE_CODES = Object.freeze(Object.keys(LANGUAGES));

// The value a client may send for sourceLanguage to request auto-detection.
// Never valid for targetLanguage — routes/translate.js enforces that.
export const AUTO = 'auto';

export function isKnownLanguage(code) {
  return Object.prototype.hasOwnProperty.call(LANGUAGES, code);
}

// EN<->Indic or Indic<->Indic, both known, not identical. Mirrors the
// Python service's resolve_direction() — kept as a boolean check on the
// Node side (Node doesn't need to know which of the three directional
// models handles it, only whether the pair is legitimate at all; the
// Python service owns the actual routing).
export function isSupportedPair(source, target) {
  return isKnownLanguage(source) && isKnownLanguage(target) && source !== target;
}
