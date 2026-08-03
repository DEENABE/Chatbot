/**
 * Builds the final chat messages array sent to the LLM, given the
 * user's question and the (already retrieved, reranked, trimmed)
 * context chunks.
 */
export function buildRagPrompt(question, contextChunks, history = []) {
  const contextBlock = contextChunks
    .map((c, i) => `[${i + 1}] (source: ${c.source}) ${c.text}`)
    .join('\n\n');

  const systemPrompt = `You are a helpful assistant answering questions using the user's own database.
Answer ONLY using the context provided below. Cite sources inline like [1], [2].
If the answer is not contained in the context, say clearly that you don't have that information - do not guess.

Context:
${contextBlock}`;

  return [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: question }
  ];
}
