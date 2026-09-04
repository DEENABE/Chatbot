import test from 'node:test';
import assert from 'node:assert/strict';
import { applyGlossary } from './glossary.js';

test('glossary: replaces a known whole-word term', () => {
  const result = applyGlossary('The bearing should be replaced.', 'eng_Latn', 'tam_Taml');
  assert.equal(result, 'The தாங்கி should be replaced.');
});

test('glossary: does not match inside a longer word (plural)', () => {
  const result = applyGlossary('The bearings are worn out.', 'eng_Latn', 'tam_Taml');
  assert.equal(result, 'The bearings are worn out.');
});

test('glossary: does not match inside a compound word', () => {
  const result = applyGlossary('His forbearing attitude helped.', 'eng_Latn', 'tam_Taml');
  assert.equal(result, 'His forbearing attitude helped.');
});

test('glossary: replaces multiple distinct terms in one text', () => {
  const result = applyGlossary('Check the shaft and bearing.', 'eng_Latn', 'tam_Taml');
  assert.equal(result, 'Check the தண்டு and தாங்கி.');
});

test('glossary: case-insensitive matching', () => {
  const result = applyGlossary('bearing Bearing BEARING', 'eng_Latn', 'tam_Taml');
  assert.equal(result, 'தாங்கி தாங்கி தாங்கி');
});

test('glossary: term at the very start and end of the string', () => {
  const result = applyGlossary('bearing', 'eng_Latn', 'tam_Taml');
  assert.equal(result, 'தாங்கி');
});

test('glossary: term adjacent to punctuation still matches (boundary is punctuation, not just whitespace)', () => {
  const result = applyGlossary('Replace the bearing, then reassemble.', 'eng_Latn', 'tam_Taml');
  assert.equal(result, 'Replace the தாங்கி, then reassemble.');
});

test('glossary: no-op when source language is not English', () => {
  const result = applyGlossary('bearing', 'tam_Taml', 'eng_Latn');
  assert.equal(result, 'bearing');
});

test('glossary: no-op when the target language has no entry for a known term', () => {
  const result = applyGlossary('bearing', 'eng_Latn', 'hin_Deva');
  assert.equal(result, 'bearing');
});

test('glossary: no-op on text with no glossary terms at all', () => {
  const result = applyGlossary('Hello, how are you?', 'eng_Latn', 'tam_Taml');
  assert.equal(result, 'Hello, how are you?');
});

test('glossary: empty string input is handled without throwing', () => {
  assert.equal(applyGlossary('', 'eng_Latn', 'tam_Taml'), '');
});
