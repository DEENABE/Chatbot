const hints = {
  CHECKPOINT_CONFLICT:
    'A previous backup contains a different file version. Start a fresh task; current edits are backed up separately and old restores keep their conflict checks.',
  INVALID_FILE_TYPE:
    'The requested entry has the wrong type. File and directory searches are supported in the updated app; retry the task.',
  EXECUTION_GRANT_REQUIRED: 'Open Run & packages and enable project commands for this workspace.',
  DOWNLOAD_GRANT_REQUIRED: 'Open Run & packages and enable package downloads, then retry.',
  RUNTIME_MISSING:
    'Open Run & packages. Install Python when needed, or refresh the available runtimes.',
  COMMAND_FAILED:
    'Review the terminal output. The agent can use the real error to fix the project and run the check again.',
  COMMAND_TIMEOUT:
    'The command exceeded its time limit. Review the terminal output before retrying.',
  CODING_ERROR:
    'An internal task error occurred. Retry to start a fresh task with the current project files.',
  CODING_CONTEXT_TOO_LARGE:
    'Open project settings and increase the context size, or use a shorter request.',
  OLLAMA_UNAVAILABLE: 'Start or restart Ollama, then refresh the installed models.',
  CODING_MODEL_UNAVAILABLE:
    'Refresh the model list and select an installed model with tool support.',
  NO_PROGRESS:
    'The model kept re-listing files instead of creating them. Retry with a more specific request, for example name the files to create.',
  MODEL_PROPOSAL_INVALID:
    'The model could not produce a valid coding action. Retry or choose another installed model.',
  MODEL_TIMEOUT:
    'The local model timed out. Retry with a smaller request or choose another installed model.',
  ISOLATION_UNAVAILABLE:
    'Files can be edited here. Run project build and test commands in your own terminal; command execution is unavailable in this runtime.',
  VALIDATION_NOT_RUN:
    'Open Run & packages and complete the required check. Plain HTML uses Preview HTML; npm projects need a declared dev/start script. Retry after reviewing the actual command output.',
  NPM_SCRIPT_MISSING:
    'This package has no requested npm script. Use Preview HTML for an HTML file, or choose an existing dev/start script from package.json.',
  PREVIEW_HTTP_FAILED:
    'The preview could not read its HTML entry. Review the selected file and retry.',
  INTERRUPTED:
    'The application restarted. Review the existing changes, then retry to continue with the current files.',
  WRITE_GRANT_REQUIRED: 'Open project settings and authorize changes to the selected folder.',
  WORKSPACE_PATH_DENIED:
    'The agent requested an invalid project path. Retry with the updated app; paths inside the selected folder are handled automatically.',
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
