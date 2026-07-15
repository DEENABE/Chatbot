import { Router } from 'express';
import { getDb } from '../db/connection.js';

const router = Router();

router.get('/usage/:userId', (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT model, prompt_tokens, completion_tokens, total_tokens, latency_ms, question, created_at
    FROM usage_log WHERE user_id = ? ORDER BY created_at DESC LIMIT 200
  `).all(req.params.userId);

  const totalTokens = rows.reduce((sum, r) => sum + r.total_tokens, 0);

  res.json({
    userId: req.params.userId,
    requestCount: rows.length,
    totalTokens,
    entries: rows
  });
});

export default router;
