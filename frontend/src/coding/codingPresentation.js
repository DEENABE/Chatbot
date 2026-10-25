const hints = {
  CODING_ERROR:
    'An internal task error occurred. Retry to start a fresh task with the current project files.',
  CODING_CONTEXT_TOO_LARGE:
    'Open project settings and increase the context size, or use a shorter request.',
  OLLAMA_UNAVAILABLE: 'Start or restart Ollama, then refresh the installed models.',
  CODING_MODEL_UNAVAILABLE:
    'Refresh the model list and select an installed model with tool support.',
  MODEL_PROPOSAL_INVALID:
    'The model could not produce a valid coding action. Retry or choose another installed model.',
  MODEL_TIMEOUT:
    'The local model timed out. Retry with a smaller request or choose another installed model.',
  ISOLATION_UNAVAILABLE:
    'Files can be edited here. Run project build and test commands in your own terminal; command execution is unavailable in this runtime.',
  VALIDATION_NOT_RUN:
    'Review the generated files and run the required project checks in your terminal.',
  INTERRUPTED:
    'The application restarted. Review the existing changes, then retry to continue with the current files.',
  WRITE_GRANT_REQUIRED: 'Open project settings and authorize changes to the selected folder.',
};

export function taskDiagnostic(task) {
  if (!task || !['error', 'failed', 'blocked'].includes(task.status)) return null;
  const code = task.error?.code || task.reason || 'CODING_ERROR';
  return {
    code,
    message: task.error?.message || task.summary,
    hint: hints[code] || 'Review the activity and recorded changes, then retry the task.',
  };
}

export function taskActivity(task) {
  // Actual controller attempts carry tool results; transition events alone do not.
  return (task?.state?.state?.attempts || []).map((attempt) => ({
    id: attempt.attemptId,
    tool: `${attempt.request.tool}.${attempt.request.action}`,
    path: attempt.request.params?.path || '',
    status: attempt.observation?.needsConfirmation
      ? 'approval'
      : !attempt.observation
        ? 'running'
        : attempt.observation.success
          ? 'done'
          : 'failed',
    error: attempt.observation?.error?.message,
    data: attempt.observation?.data,
  }));
}

export function conversationTurns(history, current) {
  const tasks = new Map(history.map((task) => [task.id, task]));
  if (current) tasks.set(current.id, current);
  return [...tasks.values()].sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
}
