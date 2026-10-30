Embedded per-user vector store holding embeddings of every indexed document chunk, used for the semantic half of hybrid document retrieval.

**Status:** Implemented

## Responsibilities
- One LanceDB directory per user at `<storage>/users/<userId>/lancedb`, table `document_chunks` (`backend/src/services/vectorService.js`)
- `indexChunks()` embeds chunks in batches via Ollama `/api/embed` and appends rows `{id, documentId, filename, chunkIndex, text, vector}`
- `searchChunks()` embeds the question and runs `vectorSearch`; document scoping is done by selecting ids first (`scopedVectorSearch`) because of a camelCase filter issue in this `@lancedb/lancedb` version
- `deleteChunks()` removes a document's rows by id list when a document is deleted

## Tech Stack
- @lancedb/lancedb 0.18 (embedded, no server), embeddings from Ollama (default `nomic-embed-text`)
- Note: `config.vectorDir` (`storage/lancedb`) is defined but the service derives its own per-user path from `dirname(config.dbFile)`
