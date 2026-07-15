/**
 * Run with: npm run ingest
 *
 * Pulls records from your source DB in batches, cleans + chunks + embeds
 * them, and stores them in the local vector index. This is the "training"
 * step for RAG - it does not modify the LLM itself, it just builds the
 * searchable index the LLM will be given context from.
 *
 * Safe to re-run: already-indexed chunks are skipped via content hash,
 * so this doubles as your incremental update job (run on a schedule/cron
 * via scripts/reindex.sh whenever your source DB changes).
 */
import { loadFromSourceDb, countSourceRows } from './loadSources.js';
import { embedAndStoreRecord } from './embedAndStore.js';

const BATCH_SIZE = 200;

async function run() {
  const total = await countSourceRows();
  console.log(`Starting ingest. ~${total} source rows to process.`);

  let offset = 0;
  let totalInserted = 0;
  let totalSkipped = 0;
  const startedAt = Date.now();

  while (true) {
    const records = await loadFromSourceDb({ batchSize: BATCH_SIZE, offset });
    if (records.length === 0) break;

    for (const record of records) {
      try {
        const { inserted, skipped } = await embedAndStoreRecord(record);
        totalInserted += inserted;
        totalSkipped += skipped;
      } catch (err) {
        console.error(`Failed on source_row_id=${record.sourceRowId}:`, err.message);
      }
    }

    offset += records.length;
    console.log(`Processed ${offset}/${total} rows | +${totalInserted} chunks, ${totalSkipped} skipped`);
  }

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`Done in ${elapsedSec}s. New chunks: ${totalInserted}, skipped (unchanged): ${totalSkipped}`);
}

run().catch(err => {
  console.error('Ingest failed:', err);
  process.exit(1);
});
