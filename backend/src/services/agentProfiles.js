/**
 * Logical agents and what each one needs from a local model.
 *
 * A profile never names a model tag. It lists
 *   - `routes`: which security route it may run on ("general" = no computer tools, "windows" = approved tools);
 *   - `requires`: capabilities Ollama must DECLARE for a model to be eligible (never guessed from a name);
 *   - `hints`: model-family words used only to ORDER models that are already eligible. A hint can never make an
 *     incompatible or missing model eligible, and a hint that matches nothing changes nothing.
 *
 * Nothing here downloads, removes or replaces a model. `recommended` is what the owner of this app listed as
 * good candidates; it is shown in Settings so the person can decide to `ollama pull` one themselves.
 *
 * AGENT_MODEL_HINTS=off turns the ordering by hints off (every agent then ranks models exactly like the original
 * General / Windows routes did).
 */
export const AGENT_PROFILES = Object.freeze({
  'general-chat': Object.freeze({
    id: 'general-chat',
    label: 'General chat',
    role: 'Everyday questions and conversation',
    routes: Object.freeze(['general']),
    requires: Object.freeze(['completion']),
    hints: Object.freeze(['qwen']),
    recommended: 'Qwen family',
  }),
  'document-intelligence': Object.freeze({
    id: 'document-intelligence',
    label: 'Document Intelligence',
    role: 'Summarise and answer from your documents and attached images',
    routes: Object.freeze(['general']),
    requires: Object.freeze(['completion']),
    hints: Object.freeze(['gemma']),
    recommended: 'Gemma 4 E2B',
  }),
  'windows-repair': Object.freeze({
    id: 'windows-repair',
    label: 'Windows Repair',
    role: 'Diagnose Windows problems and explain the fix (changes still go through verified, approved tools)',
    routes: Object.freeze(['general', 'windows']),
    requires: Object.freeze(['completion']),
    hints: Object.freeze(['phi']),
    recommended: 'Phi-4 Mini 3.8B',
  }),
  'os-control': Object.freeze({
    id: 'os-control',
    label: 'Windows OS Control',
    role: 'Plan and call approved Windows tools (settings, apps, files)',
    routes: Object.freeze(['windows']),
    requires: Object.freeze(['completion', 'tools']),
    hints: Object.freeze(['qwen']),
    recommended: 'Qwen3.5 4B / 9B',
  }),
  'app-automation': Object.freeze({
    id: 'app-automation',
    label: 'Application Automation',
    role: "Read an application's UI and choose one approved action at a time",
    routes: Object.freeze(['windows']),
    requires: Object.freeze(['completion', 'tools']),
    hints: Object.freeze(['ministral', 'mistral']),
    recommended: 'Ministral 3 3B',
  }),
  'software-install': Object.freeze({
    id: 'software-install',
    label: 'Software Installation',
    role: 'Resolve a package and plan an approved installation',
    routes: Object.freeze(['windows']),
    requires: Object.freeze(['completion', 'tools']),
    hints: Object.freeze(['qwen']),
    recommended: 'Qwen family',
  }),
});

/**
 * Document search uses an embedding model, not a chat model. It is deliberately NOT auto-assigned: the vector size
 * of the existing index is tied to `config.embeddingModel`, so switching means re-indexing every document.
 */
export const EMBEDDING_CANDIDATE = Object.freeze({
  recommended: 'EmbeddingGemma 300M',
  note: 'Not switched automatically: changing the embedding model changes the vector size, so documents must be re-indexed.',
});

export const agentProfile = (agentId) =>
  Object.hasOwn(AGENT_PROFILES, agentId) ? AGENT_PROFILES[agentId] : null;

export const hintsEnabled = () =>
  String(process.env.AGENT_MODEL_HINTS || '').toLowerCase() !== 'off';

/** Position of the first hint that matches the model's family or tag; Infinity when none does. */
export function hintRank(profile, model) {
  if (!profile || !hintsEnabled()) return Infinity;
  const haystack = `${model.family || ''} ${model.id || ''}`.toLowerCase();
  const index = profile.hints.findIndex((hint) => haystack.includes(hint));
  return index === -1 ? Infinity : index;
}
