// Lightweight source-language detection for the translator's `auto` mode.
// Deliberately NOT a general-purpose language-ID library and NOT an LLM
// call (per explicit requirement: don't rely on Qwen3 for this) — this
// app's supported language set has one crucial property that makes a
// trivial approach reliable: five of the six languages each occupy a
// distinct, non-overlapping Unicode script block (Devanagari/Tamil/
// Telugu/Kannada/Malayalam), and the sixth (English) is Latin script.
// Counting which block dominates the input's letters is enough — no
// tokenization, no model, no npm dependency.

import { ENGLISH } from './languageRegistry.js';

// [language code, regex matching one character of that script]
const SCRIPT_RANGES = [
  ['hin_Deva', /[ऀ-ॿ]/],
  ['tam_Taml', /[஀-௿]/],
  ['tel_Telu', /[ఀ-౿]/],
  ['kan_Knda', /[ಀ-೿]/],
  ['mal_Mlym', /[ഀ-ൿ]/],
  [ENGLISH, /[A-Za-z]/]
];

// Below this fraction of "winning script's letters / all recognized
// letters", the input is ambiguous enough that guessing would be worse
// than asking the user to pick — matches the explicit requirement to
// return a clear validation response rather than a possibly-wrong
// translation.
const MIN_CONFIDENCE = 0.6;

/**
 * @param {string} text
 * @returns {{ language: string, confidence: number } | { language: null, confidence: number }}
 */
export function detectLanguage(text) {
  const counts = new Map();
  let totalRecognized = 0;

  for (const char of text) {
    for (const [language, pattern] of SCRIPT_RANGES) {
      if (pattern.test(char)) {
        counts.set(language, (counts.get(language) || 0) + 1);
        totalRecognized += 1;
        break; // each character belongs to at most one script bucket
      }
    }
  }

  if (totalRecognized === 0) {
    return { language: null, confidence: 0 };
  }

  let winner = null;
  let winnerCount = 0;
  for (const [language, count] of counts) {
    if (count > winnerCount) {
      winner = language;
      winnerCount = count;
    }
  }

  const confidence = winnerCount / totalRecognized;
  if (!winner || confidence < MIN_CONFIDENCE) {
    return { language: null, confidence };
  }
  return { language: winner, confidence };
}
