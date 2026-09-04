// Minimal terminology/glossary mechanism — an extension point, not a
// terminology database. Deliberately small: a handful of example entries
// prove the substitution is safe and useful; growing the dictionary (or
// swapping this static object for a file/DB-backed source) is future work
// that doesn't require touching translationService.js's call site.
//
// Applied as a pre-processing step on English source text, before it
// reaches the translator: a known domain term is swapped for its
// pre-approved target-language rendering so the engine translates the
// surrounding sentence around a term that's already correct, rather than
// guessing a generic translation for a technical word. This only makes
// sense when translating FROM English (the glossary keys are English
// terms) — Indic-to-Indic and Indic-to-English glossary lookup would need
// reverse/multi-key matching, out of scope for this minimal version.
//
// Example shape (matches the spec this was requested against):
//   { "bearing": { "tam_Taml": "தாங்கி" }, "shaft": { "tam_Taml": "தண்டு" } }

const GLOSSARY = Object.freeze({
  bearing: { tam_Taml: 'தாங்கி' },
  shaft: { tam_Taml: 'தண்டு' }
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replaces known glossary terms in `text` with their pre-approved
 * translation for `targetLanguage`, matching whole words only
 * (case-insensitive) so "bearing" never matches inside "bearings" or
 * "forbearing" and corrupts the surrounding word. Only applies when
 * `sourceLanguage` is English — a no-op otherwise.
 *
 * @param {string} text
 * @param {string} sourceLanguage
 * @param {string} targetLanguage
 * @returns {string}
 */
export function applyGlossary(text, sourceLanguage, targetLanguage) {
  if (sourceLanguage !== 'eng_Latn' || !text) return text;

  let result = text;
  for (const [term, translations] of Object.entries(GLOSSARY)) {
    const replacement = translations[targetLanguage];
    if (!replacement) continue;
    // \b uses a word-character boundary, which correctly excludes a plural
    // ("bearings") or a compound ("forbearing") from matching "bearing" —
    // both have a word character immediately adjacent, so no boundary
    // exists there.
    const pattern = new RegExp(`\\b${escapeRegExp(term)}\\b`, 'gi');
    result = result.replace(pattern, replacement);
  }
  return result;
}
