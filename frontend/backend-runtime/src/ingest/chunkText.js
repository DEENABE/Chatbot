import { config } from '../config/index.js';

// rough heuristic: ~4 characters per token for English text.
// Good enough for chunk sizing; exact counts aren't needed at ingest time.
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

/**
 * Splits text into overlapping chunks sized in tokens (approx).
 * Splits on sentence boundaries so chunks don't cut mid-sentence.
 */
export function chunkText(
  text,
  {
    chunkSizeTokens = config.chunkSizeTokens,
    overlapTokens = config.chunkOverlapTokens
  } = {}
) {
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  const chunks = [];

  let current = [];
  let currentTokens = 0;

  for (const sentence of sentences) {
    const sTokens = estimateTokens(sentence);

    if (currentTokens + sTokens > chunkSizeTokens && current.length > 0) {
      chunks.push(current.join(' '));

      // build overlap: keep trailing sentences worth ~overlapTokens
      let overlapText = [];
      let overlapCount = 0;
      for (let i = current.length - 1; i >= 0; i--) {
        overlapCount += estimateTokens(current[i]);
        overlapText.unshift(current[i]);
        if (overlapCount >= overlapTokens) break;
      }
      current = overlapText;
      currentTokens = overlapCount;
    }

    current.push(sentence);
    currentTokens += sTokens;
  }

  if (current.length > 0) chunks.push(current.join(' '));

  return chunks;
}
