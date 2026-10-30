/** Admission identifies execution intent. It never grants workspace or tool access. */
const ACTION =
  /\b(?:implement|scaffold|refactor|debug|fix|build|develop|create|generate|write|add|modify|edit|update|patch|run|execute|test)\b/i;
const ENGINEERING =
  /\b(?:codebase|repository|repo|source code|software|coding agent|unit tests?|integration tests?|test suite|full[ -]stack|backend|frontend|api endpoint|authentication|component|module|function|class|bug|compiler|build errors?|type[ -]?check|lint|database migration|project|workspace)\b/i;
const FILE_TARGET =
  /\b(?:file|files|folders?|directories|directory)\b|(?:^|\s)[\w./\\-]+\.(?:[a-z0-9]{1,12})(?:\s|$|[,;:])/i;
const EXECUTION_CONTEXT =
  /\b(?:in|inside|within|into|for|to|on)\s+(?:(?:my|our|this|the|an?|existing|selected|authorized|current)\s+)*(?:project|repository|repo|workspace|codebase|source files?)\b|\b(?:create|build|scaffold|develop|implement)\b.{0,100}\b(?:application|app|software|full[ -]stack|website|backend|frontend|project)\b|\b(?:run|execute|fix|debug)\b.{0,80}\b(?:tests?|test suite|build|compiler|lint|type[ -]?check)\b/i;
const ANSWER_ONLY =
  /\b(?:explain|describe|what is|what are|how does|how do i|teach me|show (?:me )?an? example|sample code|code snippet|answer only|do not (?:execute|run|edit)|don't (?:execute|run|edit))\b/i;
const NON_ENGINEERING = /\b(?:poem|poetry|song|story|essay|email|letter|recipe)\b/i;

export function codingTask(task, { workspaceId, explicit = false } = {}) {
  if (typeof task !== 'string' || !task.trim() || task.length > 20000) return null;
  const text = task.trim();
  if (ANSWER_ONLY.test(text) || NON_ENGINEERING.test(text)) return null;
  if (!ACTION.test(text)) return null;
  if (!explicit && !ENGINEERING.test(text)) return null;
  if (!explicit && !workspaceId && !EXECUTION_CONTEXT.test(text)) return null;
  // A request for an answer containing SQL is not authority to modify a project.
  if (
    /\b(?:write|generate|create)\s+(?:an?\s+)?(?:sql\s+)?query\b/i.test(text) &&
    !workspaceId &&
    !FILE_TARGET.test(text)
  )
    return null;
  return {
    mode: 'agentic',
    taskType: 'coding',
    confidence: 1,
    via: 'keyword',
    requiresWorkspace: !workspaceId,
  };
}

export const isCodingTask = (task, options) => codingTask(task, options) !== null;
