import { MemoryRepository } from './MemoryRepository.js';
import { ShortTermMemoryService } from './ShortTermMemoryService.js';
import { TaskMemoryService } from './TaskMemoryService.js';
import { SystemMemoryService } from './SystemMemoryService.js';
import { LongTermMemoryService } from './LongTermMemoryService.js';
import { MemoryRetriever } from './MemoryRetriever.js';
import { extractMemoryCandidates } from './MemoryCandidateExtractor.js';
import { publicText } from './validation.js';
import { createHash } from 'node:crypto';
export class MemoryManager {
  constructor(db, options = {}) {
    this.repository = new MemoryRepository(db, options);
    this.shortTerm = new ShortTermMemoryService(this.repository, options.shortTerm);
    this.task = new TaskMemoryService(this.repository);
    this.system = new SystemMemoryService(this.repository, options.system);
    this.longTerm = new LongTermMemoryService(this.repository);
    this.retriever = new MemoryRetriever(this, options.retrieval);
  }
  observeConversation({ userId, conversationId, messageId, role, content, requestId }) {
    const clean = publicText(content, 3500);
    if (!clean || !['user', 'assistant', 'tool'].includes(role)) return;
    this.shortTerm.addShortTermMemory(
      userId,
      conversationId,
      {
        key: messageId,
        value: `${role}: ${clean}`,
        source: role === 'tool' ? 'tool_observation' : 'conversation',
      },
      { requestId },
    );
  }
  processUserMessage({ userId, message, requestId, conversationId }) {
    const outcomes = [];
    for (const candidate of extractMemoryCandidates(message)) {
      const { explicit, ...input } = candidate;
      try {
        outcomes.push(
          this.longTerm.saveLongTermMemory(userId, input, {
            explicit,
            origin: 'user',
            requestId,
            conversationId,
          }),
        );
      } catch (e) {
        if (e.status !== 400) throw e;
        outcomes.push({ decision: 'DO_NOT_SAVE', memory: null });
      }
    }
    return outcomes;
  }
  observeReportedTools({ userId, conversationId, history, requestId }) {
    for (const item of history.filter((h) => h?.role === 'tool').slice(-6)) {
      const value = publicText(item.content, 1500);
      if (!value) continue;
      const key =
        'tool.' +
        createHash('sha256')
          .update(String(item.tool_call_id || '') + value)
          .digest('hex')
          .slice(0, 24);
      this.shortTerm.addShortTermMemory(
        userId,
        conversationId,
        {
          key,
          value: 'Reported tool observation (cached context only): ' + value,
          source: 'tool_observation',
        },
        { requestId },
      );
    }
  }
}
