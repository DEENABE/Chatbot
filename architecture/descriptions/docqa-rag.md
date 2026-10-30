Turns uploaded or workspace files into searchable knowledge — parsed text chunks, structured spreadsheet rows and vector embeddings — and assembles a bounded, cited context for each question using hybrid keyword + vector retrieval and an exact-arithmetic table planner.

**Status:** Implemented. Reranking is **rank fusion only** (Reciprocal Rank Fusion, k = 60); there is no cross-encoder/LLM reranker. Scanned/image-only PDFs are rejected (no OCR at ingest).

## Responsibilities
- Ingest (`services/documentIngestionService.js` → `indexDocumentFiles`, `ingestWorkspaceFile`): bounded concurrency (`acquire`), sanitize name, accept PDF / DOCX / TXT / MD / CSV / XLSX (images only as chat attachments when a vision model is installed), validate MIME vs extension
- Parse (`docqa/ingest.js` → `prepareDocument`): PDF per page via pdf-parse (`[Page N]` prefixes), DOCX text + tables via mammoth, spreadsheets via `tableParser.js`; text split by `lib/chunkText.js` (900 chars, 140 overlap, max 2000 chunks)
- Store structure (`docqa/structuredStore.js` → `saveDocumentStructure`): `doc_tables`, `doc_rows` (+FTS5), `doc_chunks` (+FTS5) in SQLite
- Embed (`services/vectorService.js` → `indexChunks`) into per-user LanceDB; if Ollama embedding fails the document is saved as `keyword-ready` instead of `ready`
- Retrieve (`docqa/retrieve.js` → `retrieveDocumentContext`): scope to knowledge/attachment/workspace document ids, then (1) exact spreadsheet row hits, (2) `queryPlanner.answerWithPlanner` for analytical questions (model writes a plan, JavaScript computes the numbers), (3) vector + FTS keyword search fused with RRF, (4) small touched tables inlined in full — all within a 7,000-char budget (`DOCQA_CONTEXT_CHARS`)
- Tamil/Tanglish-aware stop-word list for keyword search

## Document upload → retrieval flow

```mermaid
flowchart TD
  A[POST /api/upload multipart] --> B[multer → storage/uploads]
  B --> C{indexDocumentFiles}
  C -->|image + attachment| I[document_images + vision-model check]
  C -->|PDF/DOCX/TXT/MD| D[prepareDocument: extract text → chunkText 900/140]
  C -->|XLSX/CSV| T[parseSpreadsheet → tableToChunks]
  D --> S[saveDocumentStructure → doc_chunks + FTS5]
  T --> S2[doc_tables + doc_rows + FTS5]
  S --> E[indexChunks: Ollama /api/embed → LanceDB]
  S2 --> E
  E -->|embed failed| K[status keyword-ready]
  E --> R[documents row status ready]
  Q[Chat question] --> X[retrieveDocumentContext]
  X --> X1[row hits from doc_rows_fts]
  X --> X2[queryPlanner for analytical questions]
  X --> X3[vector search LanceDB]
  X --> X4[keyword search doc_chunks_fts]
  X3 --> F[RRF fusion k=60]
  X4 --> F
  X1 --> CTX[cited context ≤ 7000 chars]
  X2 --> CTX
  F --> CTX
  CTX --> LLM[Ollama chat with sources]
```

## Tech Stack
- pdf-parse, mammoth, read-excel-file, SQLite FTS5, @lancedb/lancedb, Ollama embeddings
