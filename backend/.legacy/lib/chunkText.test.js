import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkText } from './chunkText.js';

test('returns no chunks for blank input', () => assert.deepEqual(chunkText('  \n '), []));

test('chunks long text with overlap', () => {
  const text = Array.from({ length: 80 }, (_, i) => `Sentence ${i} contains useful enterprise information.`).join(' ');
  const chunks = chunkText(text, { size: 300, overlap: 40 });
  assert.ok(chunks.length > 2);
  assert.ok(chunks.every((chunk) => chunk.length <= 380));
});
