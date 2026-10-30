// Hybrid retrieval for chat:
//   1. exact row lookup (FTS5/BM25) over every spreadsheet row   → "Ravi details"
//   2. computed answer via the query planner over ALL rows         → "how many in Chennai"
//   3. whole small tables when they fit in context
//   4. text chunks: vector (LanceDB) + keyword (FTS5) merged with RRF
// Returns sources in the same shape chat.js already used
// ({ filename, chunkIndex, text, _distance }) plus a human `label`.
import { config } from '../config.js';
import { searchChunks } from '../services/vectorService.js';
import {
  getTableRows,
  keywordTokens,
  listTables,
  rowToText,
  searchRows,
  searchTextChunks,
  getDocumentChunks,
} from './structuredStore.js';
import { knowledgeDocumentIds } from '../services/documentsStore.js';
import { answerWithPlanner, isAnalyticalQuestion } from './queryPlanner.js';

const CONTEXT_BUDGET = Number(process.env.DOCQA_CONTEXT_CHARS || 7_000);
const SMALL_TABLE_CHARS = 5_000;
const MAX_ROWS_PER_TABLE_HIT = 15;

function mdTable(allColumns, rows) {
  const esc = (v) =>
    String(v ?? '')
      .replace(/\|/g, '/')
      .slice(0, 120);
  // Hide columns that are blank in every shown row.
  const keep = allColumns
    .map((_, i) => i)
    .filter((i) => rows.some(({ data }) => String(data[i] ?? '') !== ''));
  const columns = (keep.length ? keep : allColumns.map((_, i) => i)).map((i) => ({
    i,
    name: allColumns[i],
  }));
  return [
    `| # | ${columns.map((c) => esc(c.name)).join(' | ')} |`,
    `| --- | ${columns.map(() => '---').join(' | ')} |`,
    ...rows.map(
      ({ index, data }) => `| ${index + 1} | ${columns.map((c) => esc(data[c.i])).join(' | ')} |`,
    ),
  ].join('\n');
}

function lastUserMessage(history) {
  if (!Array.isArray(history)) return '';
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i];
    if (item?.role === 'user' && typeof item.content === 'string') return item.content;
  }
  return '';
}

function chunkLabel(text, chunkIndex) {
  const page = String(text).match(/^\[Page (\d+)\]/);
  if (page) return `page ${page[1]}`;
  const rows = String(text).match(/\nRow (\d+) \|[\s\S]*\nRow (\d+) \|/);
  if (rows) return `rows ${rows[1]}–${rows[2]}`;
  const row = String(text).match(/\nRow (\d+) \|/);
  if (row) return `row ${row[1]}`;
  return `chunk ${chunkIndex + 1}`;
}

function tableBlock(table, rows, rowIndexes) {
  const lines = rowIndexes.map((i) => `Row ${i + 1} | ${rowToText(table.columns, rows[i])}`);
  return `File: ${table.filename} › Sheet: ${table.sheet} (${table.rowCount} rows total)\nColumns: ${table.columns.join(', ')}\n${lines.join('\n')}`;
}

/**
 * @param {{message:string, history?:any[], userId:string, model:string, signal?:AbortSignal, onStatus?:(s:string)=>void}} args
 */
export async function retrieveDocumentContext({
  message,
  history,
  userId,
  model,
  signal,
  onStatus,
  skipPlanner = false,
  documentIds,
  numCtx,
  keepAlive,
}) {
  const question = String(message || '').trim();
  if (!question) return [];
  const sources = [];
  let budget = CONTEXT_BUDGET;
  const push = (source) => {
    if (budget <= 0) return false;
    const text = source.text.length > budget ? source.text.slice(0, budget) + '\n…' : source.text;
    budget -= text.length;
    sources.push({ ...source, text });
    return true;
  };

  const scopedIds = documentIds ?? knowledgeDocumentIds(userId);
  if (!scopedIds.length) return [];
  const tables = listTables(userId, scopedIds);
  const coveredDocs = new Set();

  // Follow-ups like "avaru epa join panaru?" carry no name — fall back to the
  // previous user turn's keywords when the current turn finds nothing.
  let rowHits = tables.length ? searchRows(question, userId, 40, scopedIds) : [];
  if (!rowHits.length && tables.length && keywordTokens(question).length < 3) {
    const previous = lastUserMessage(history);
    if (previous && previous !== question)
      rowHits = searchRows(`${previous} ${question}`, userId, 40, scopedIds);
  }

  // Precision: keep only the rows that cover the most question keywords.
  // "Kavya Selvam details" → both Kavya Selvam rows (2 keywords) win over
  // every other "Kavya ..." row (1 keyword). "Ravi and Priya" → both kept.
  const tokens = keywordTokens(question);
  if (rowHits.length && tokens.length > 1) {
    const scored = rowHits.map((hit) => {
      const haystack = `${hit.sheet} ${hit.data.join(' ')}`.toLowerCase();
      return { hit, coverage: tokens.filter((t) => haystack.includes(t)).length };
    });
    const best = Math.max(...scored.map((s) => s.coverage));
    if (best > 0) rowHits = scored.filter((s) => s.coverage === best).map((s) => s.hit);
  }

  // 1) Planner for analytical questions (count / list / filter / sum ...). The rules in
  //    questionCompiler.js answer most of them instantly; the model is only asked when
  //    the rules cannot explain every word of the question.
  if (!skipPlanner && tables.length) {
    if (isAnalyticalQuestion(question)) onStatus?.('Analysing spreadsheet rows…');
    try {
      // Tables with keyword hits first, then most recent.
      const hitTableIds = [...new Set(rowHits.map((h) => h.tableId))];
      const ordered = [
        ...hitTableIds.map((id) => tables.find((t) => t.id === id)).filter(Boolean),
        ...tables.filter((t) => !hitTableIds.includes(t.id)),
      ];
      const plannerStart = Date.now();
      const planned = await answerWithPlanner({
        question,
        tables: ordered,
        loadRows: (id) => getTableRows(id, userId),
        model,
        signal,
        numCtx,
        keepAlive,
      });
      console.log(
        `[docqa] planner ${Date.now() - plannerStart}ms → ${planned ? `computed by ${planned.source}` : 'no plan'}` +
          (planned?.changes?.length ? ` · repaired: ${planned.changes.join('; ')}` : ''),
      );
      if (planned) console.log(`[docqa] plan ${JSON.stringify(planned.plan)}`);
      if (planned) {
        push({
          filename: planned.table.filename,
          chunkIndex: 0,
          label: `computed · ${planned.table.sheet}`,
          text: planned.text,
          computed: true,
          answer: planned.answer,
          _distance: 0,
          documentId: planned.table.documentId,
        });
        coveredDocs.add(planned.table.documentId);
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      console.error('[docqa] planner failed, falling back to retrieval:', error.message);
    }
  }

  // 2) Exact row hits, grouped per table
  const byTable = new Map();
  for (const hit of rowHits) {
    if (!byTable.has(hit.tableId)) byTable.set(hit.tableId, []);
    const list = byTable.get(hit.tableId);
    if (list.length < MAX_ROWS_PER_TABLE_HIT) list.push(hit);
  }
  for (const [tableId, hits] of [...byTable.entries()].slice(0, 3)) {
    const first = hits[0];
    const table = {
      id: tableId,
      filename: first.filename,
      sheet: first.sheet,
      columns: first.columns,
      rowCount: first.rowCount,
    };
    const rowsByIndex = new Map(hits.map((h) => [h.rowIndex, h.data]));
    const indexes = hits.map((h) => h.rowIndex).sort((a, b) => a - b);
    const lines = indexes.map(
      (i) => `Row ${i + 1} | ${rowToText(table.columns, rowsByIndex.get(i))}`,
    );
    push({
      filename: table.filename,
      chunkIndex: indexes[0],
      label: `${table.sheet} · ${indexes.length} matching row${indexes.length > 1 ? 's' : ''}`,
      text: `File: ${table.filename} › Sheet: ${table.sheet} (${table.rowCount} rows total)\nColumns: ${table.columns.join(', ')}\nRows matching the question keywords:\n${lines.join('\n')}`,
      _distance: 0.05,
      documentId: first.documentId,
      // Shown to the user immediately by chat.js, before the LLM answers.
      lookup: !sources.some((x) => x.lookup),
      rowsAnswer: `**${table.filename} › ${table.sheet}**\n\n**${indexes.length} matching row${indexes.length > 1 ? 's' : ''}**\n\n${mdTable(
        table.columns.slice(0, 12),
        indexes.slice(0, 8).map((i) => ({ index: i, data: rowsByIndex.get(i) })),
      )}${indexes.length > 8 ? `\n\n(${indexes.length - 8} more matching rows not shown)` : ''}`,
    });
    coveredDocs.add(first.documentId);
  }

  // 3) Text chunks: vector + keyword, fused with Reciprocal Rank Fusion
  const [vectorHits, keywordHits] = await Promise.all([
    searchChunks(question, Math.max(config.ragTopK, 6) + 2, userId, {
      documentIds: scopedIds,
      signal,
    }).catch((error) => {
      if (signal?.aborted) throw error;
      console.error('[docqa] vector search failed:', error.message);
      return [];
    }),
    Promise.resolve(searchTextChunks(question, userId, 8, scopedIds)),
  ]);
  const fused = new Map();
  const add = (list, weight) =>
    list.forEach((hit, rank) => {
      const key = `${hit.documentId}:${hit.chunkIndex}`;
      const entry = fused.get(key) || { hit, score: 0 };
      entry.score += weight / (60 + rank);
      fused.set(key, entry);
    });
  add(vectorHits, 1);
  add(keywordHits, 1);
  if (!fused.size && documentIds) add(getDocumentChunks(scopedIds, userId, 6), 0.5);
  const ranked = [...fused.values()]
    .sort((a, b) => b.score - a.score)
    // A table doc already answered by exact rows / computed result needs no fuzzy row chunks.
    .filter(({ hit }) => !coveredDocs.has(hit.documentId));

  // 4) Small tables in full (when the question touches them and they fit)
  const touchedDocs = new Set(ranked.slice(0, 3).map(({ hit }) => hit.documentId));
  for (const table of tables) {
    if (coveredDocs.has(table.documentId) || !touchedDocs.has(table.documentId)) continue;
    const rows = getTableRows(table.id, userId);
    const block = tableBlock(
      table,
      rows,
      rows.map((_, i) => i),
    );
    if (block.length > SMALL_TABLE_CHARS) continue;
    push({
      filename: table.filename,
      chunkIndex: 0,
      label: `${table.sheet} · full table`,
      text: block,
      _distance: 0.1,
      documentId: table.documentId,
    });
    coveredDocs.add(table.documentId);
  }

  let added = 0;
  for (const { hit } of ranked) {
    if (added >= Math.max(config.ragTopK, 5)) break;
    if (coveredDocs.has(hit.documentId)) continue;
    if (
      !push({
        filename: hit.filename,
        chunkIndex: hit.chunkIndex,
        label: chunkLabel(hit.text, hit.chunkIndex),
        text: hit.text,
        _distance: hit._distance ?? 0.5,
        documentId: hit.documentId,
      })
    )
      break;
    added++;
  }
  return sources;
}
