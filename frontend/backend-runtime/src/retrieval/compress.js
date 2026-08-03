import { estimateTokens } from '../llm/tokenCount.js';
import { config } from '../config/index.js';

/**
 * Keeps only the sentences within a chunk that are most relevant to
 * the question, instead of sending the whole chunk. This is the main
 * "remove unwanted tokens" step at query time.
 */
export function pruneToRelevantSentences(question, chunkText, maxSentences = 4) {
  const qWords = new Set(question.toLowerCase().split(/\W+/).filter(Boolean));
  const sentences = chunkText.split(/(?<=[.!?])\s+/).filter(Boolean);

  if (sentences.length <= maxSentences) return chunkText;

  return sentences
    .map(s => ({
      s,
      score: s.toLowerCase().split(/\W+/).filter(w => qWords.has(w)).length
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxSentences)
    // restore original order so the pruned text still reads naturally
    .sort((a, b) => sentences.indexOf(a.s) - sentences.indexOf(b.s))
    .map(x => x.s)
    .join(' ');
}

/**
 * Cuts a list of chunks down to fit within a total token budget,
 * keeping highest-ranked chunks first (assumes input is pre-sorted
 * by relevance, e.g. from rerank()).
 */
export function trimToTokenBudget(chunks, maxTokens = config.contextTokenBudget) {
  let used = 0;
  const kept = [];

  for (const chunk of chunks) {
    const t = estimateTokens(chunk.text);
    if (used + t > maxTokens) continue; // skip, but keep checking smaller ones after
    kept.push(chunk);
    used += t;
  }

  return kept;
}

/**
 * Full compression step: prune sentences per chunk, then fit to budget.
 */
export function compressContext(question, rankedChunks, {
  maxSentencesPerChunk = 4,
  maxTokens = config.contextTokenBudget
} = {}) {
  const pruned = rankedChunks.map(c => ({
    ...c,
    text: pruneToRelevantSentences(question, c.text, maxSentencesPerChunk)
  }));

  return trimToTokenBudget(pruned, maxTokens);
}
