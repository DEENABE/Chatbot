import { config } from '../config/index.js';

function keywordOverlapScore(question, chunkText) {
  const qWords = new Set(question.toLowerCase().split(/\W+/).filter(Boolean));
  const cWords = chunkText.toLowerCase().split(/\W+/).filter(Boolean);
  if (cWords.length === 0) return 0;
  const overlap = cWords.filter(w => qWords.has(w)).length;
  return overlap / cWords.length;
}

/**
 * Cheap "poor man's rerank": combines vector similarity with keyword
 * overlap. Good enough for most cases without running a second model.
 * Swap this out for a real cross-encoder (e.g. bge-reranker) if you
 * need higher precision.
 */
export function rerank(question, candidates, topK = config.rerankTopK) {
  return candidates
    .map(c => ({
      ...c,
      score: (1 - c.distance) * 0.7 + keywordOverlapScore(question, c.text) * 0.3
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
