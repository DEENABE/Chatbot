import { evaluateMemory, validateLongTerm } from './MemoryPolicy.js';
import { memoryError, text } from './validation.js';
export class LongTermMemoryService {
  constructor(repository) {
    this.r = repository;
  }
  saveLongTermMemory(userId, input, { explicit = false, origin = 'user', ...scope } = {}) {
    this.r.user(userId);
    const candidate = validateLongTerm(input),
      existing = this.r.longRows(userId).find((r) => r.key === candidate.key),
      decision = evaluateMemory(candidate, existing, { explicit, origin });
    if (!['SAVE', 'UPDATE_EXISTING'].includes(decision)) return { decision, memory: null };
    return { decision, memory: this.r.putLong(userId, candidate, scope) };
  }
  getLongTermMemories(userId) {
    return this.r.longRows(userId);
  }
  searchLongTermMemory(userId, query) {
    const q = text(query, 200).toLowerCase();
    return this.r.longRows(userId).filter((r) => `${r.key} ${r.value}`.toLowerCase().includes(q));
  }
  updateLongTermMemory(userId, id, input, scope = {}) {
    const old = this.r.longById(userId, id);
    if (input.key !== undefined && input.key !== old.key)
      throw memoryError('A saved memory key cannot be changed.');
    return this.saveLongTermMemory(
      userId,
      {
        key: old.key,
        value: input.value ?? old.value,
        category: input.category ?? old.category,
      },
      { ...scope, explicit: true, origin: 'user' },
    );
  }
  deleteLongTermMemory(userId, id, scope) {
    this.r.deleteLong(userId, id, scope);
    return { decision: 'DELETE' };
  }
}
