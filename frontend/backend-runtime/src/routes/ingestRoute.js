import { Router } from 'express';
import { loadFromSourceDb, countSourceRows } from '../ingest/loadSources.js';
import { embedAndStoreRecord } from '../ingest/embedAndStore.js';

const router = Router();

// NOTE: for a large DB this can take a while - consider running the
// CLI script (npm run ingest) or a background job queue instead of
// calling this synchronously from a request in production.
router.post('/ingest/run', async (req, res) => {
  const { batchSize = 200, offset = 0 } = req.body;

  try {
    const total = await countSourceRows();
    const records = await loadFromSourceDb({ batchSize, offset });

    let inserted = 0;
    let skipped = 0;

    for (const record of records) {
      const result = await embedAndStoreRecord(record);
      inserted += result.inserted;
      skipped += result.skipped;
    }

    res.json({
      processed: records.length,
      nextOffset: offset + records.length,
      totalSourceRows: total,
      inserted,
      skipped,
      done: offset + records.length >= total
    });
  } catch (err) {
    console.error('ingest route failed:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
