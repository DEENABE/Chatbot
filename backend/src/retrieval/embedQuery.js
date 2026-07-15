import { embedText } from '../llm/ollamaClient.js';

export async function embedQuery(question) {
  return embedText(question);
}
