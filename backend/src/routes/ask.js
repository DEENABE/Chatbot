import { Router } from 'express';
import { getDb } from '../db/connection.js';
import { embedQuery } from '../retrieval/embedQuery.js';
import { vectorSearch } from '../retrieval/vectorSearch.js';
import { rerank } from '../retrieval/rerank.js';
import { compressContext } from '../retrieval/compress.js';
import { buildRagPrompt } from '../llm/promptBuilder.js';
import { chatCompletionStream } from '../llm/ollamaClient.js';
import { assertWithinContextLimit } from '../llm/tokenCount.js';
import { config } from '../config/index.js';

const router = Router();

router.post('/ask', async (req, res) => {
  const { question, userId = 'anonymous', model = config.chatModel, sourceFilter } = req.body;

  if (!question || typeof question !== 'string') {
    return res.status(400).json({ error: 'question (string) is required' });
  }

  const startedAt = Date.now();

  try {
    // 1. retrieve
    const queryEmbedding = await embedQuery(question);
    const candidates = vectorSearch(queryEmbedding, config.vectorTopK, sourceFilter ? { source: sourceFilter } : {});

    if (candidates.length === 0) {
      return res.json({
        answer: "I don't have any indexed data relevant to that question yet.",
        sources: []
      });
    }

    // 2. rerank
    const ranked = rerank(question, candidates, config.rerankTopK);

    // 3. compress / remove unwanted tokens
    const finalContext = compressContext(question, ranked);

    // 4. build prompt + guard context window
    const messages = buildRagPrompt(question, finalContext);
    const promptText = messages.map(m => m.content).join('\n');
    assertWithinContextLimit(model, promptText);

    // 5. stream generation back to client via SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    let fullAnswer = '';
    const usage = await chatCompletionStream(messages, (token) => {
      fullAnswer += token;
      res.write(`data: ${JSON.stringify({ token })}\n\n`);
    }, model);

    // 6. log usage
    const db = getDb();
    db.prepare(`
      INSERT INTO usage_log (user_id, model, prompt_tokens, completion_tokens, total_tokens, latency_ms, question)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      userId, model, usage.promptTokens, usage.completionTokens, usage.totalTokens,
      Date.now() - startedAt, question
    );

    res.write(`data: ${JSON.stringify({
      done: true,
      usage,
      sources: finalContext.map(c => ({ source: c.source, id: c.id }))
    })}\n\n`);
    res.end();

  } catch (err) {
    console.error('ask route failed:', err);
    if (!res.headersSent) {
      res.status(err.status || 500).json({ error: err.message });
    } else {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    }
  }
});

export default router;
