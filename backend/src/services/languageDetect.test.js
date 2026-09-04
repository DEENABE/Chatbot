import test from 'node:test';
import assert from 'node:assert/strict';
import { detectLanguage } from './languageDetect.js';

test('detectLanguage: pure English text', () => {
  const result = detectLanguage('How are you doing today?');
  assert.equal(result.language, 'eng_Latn');
  assert.ok(result.confidence >= 0.6);
});

test('detectLanguage: pure Tamil text', () => {
  const result = detectLanguage('வணக்கம், நீங்கள் எப்படி இருக்கிறீர்கள்?');
  assert.equal(result.language, 'tam_Taml');
  assert.ok(result.confidence >= 0.6);
});

test('detectLanguage: pure Hindi (Devanagari) text', () => {
  const result = detectLanguage('नमस्ते, आप कैसे हैं?');
  assert.equal(result.language, 'hin_Deva');
  assert.ok(result.confidence >= 0.6);
});

test('detectLanguage: pure Kannada text', () => {
  const result = detectLanguage('ನಮಸ್ಕಾರ, ನೀವು ಹೇಗಿದ್ದೀರಿ?');
  assert.equal(result.language, 'kan_Knda');
});

test('detectLanguage: pure Telugu text', () => {
  const result = detectLanguage('నమస్కారం, మీరు ఎలా ఉన్నారు?');
  assert.equal(result.language, 'tel_Telu');
});

test('detectLanguage: pure Malayalam text', () => {
  const result = detectLanguage('നമസ്കാരം, സുഖമാണോ?');
  assert.equal(result.language, 'mal_Mlym');
});

test('detectLanguage: numbers/punctuation only -> null, not a guess', () => {
  const result = detectLanguage('123 456 !!! ...');
  assert.equal(result.language, null);
  assert.equal(result.confidence, 0);
});

test('detectLanguage: empty string -> null', () => {
  const result = detectLanguage('');
  assert.equal(result.language, null);
});

test('detectLanguage: heavily mixed-script text is either null or the genuinely dominant script, never a coin-flip guess', () => {
  // Roughly balanced Tamil/Devanagari — whichever wins (if either clears
  // the confidence bar) must be a real majority, not an arbitrary tiebreak.
  const result = detectLanguage('வணக்கம் नमस्ते');
  if (result.language !== null) {
    assert.ok(result.confidence >= 0.6, `a returned language must still clear the confidence bar, got ${result.confidence}`);
  }
});

test('detectLanguage: majority-script text with a short foreign fragment still detects the majority', () => {
  const result = detectLanguage('Hi வணக்கம் நண்பா எப்படி இருக்கிறீர்கள் இன்று');
  assert.equal(result.language, 'tam_Taml');
});
