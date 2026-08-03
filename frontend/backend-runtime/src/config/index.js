import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT || 3000),

  ollamaHost: process.env.OLLAMA_HOST || 'http://localhost:11434',
  chatModel: process.env.CHAT_MODEL || 'qwen2.5:7b',
  embedModel: process.env.EMBED_MODEL || 'nomic-embed-text',

  dbPath: process.env.DB_PATH || './data/assistant.db',
  embeddingDim: Number(process.env.EMBEDDING_DIM || 768),

  vectorTopK: Number(process.env.VECTOR_TOPK || 20),
  rerankTopK: Number(process.env.RERANK_TOPK || 6),
  contextTokenBudget: Number(process.env.CONTEXT_TOKEN_BUDGET || 1500),

  chunkSizeTokens: Number(process.env.CHUNK_SIZE_TOKENS || 400),
  chunkOverlapTokens: Number(process.env.CHUNK_OVERLAP_TOKENS || 50),

  // context window per model family (in tokens) - used to guard against overflow
  contextLimits: {
    'llama3.1:8b': 128000,
    'llama3.1:70b': 128000,
    'qwen2.5:7b': 32768,
    'qwen2.5:14b': 32768,
    'mistral:7b': 32768,
    'gemma2:9b': 8192,
    'gemma2:27b': 8192
  }
};
