import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ExecutionController } from '../orchestrator/ExecutionController.js';
import { currentStep, isStepBudgetExhausted, canReplan } from '../orchestrator/AgentState.js';
import { getWorkspaceForUser } from '../services/workspaceService.js';
import { validateWorkspaceRoot } from '../services/workspacePaths.js';
import { config } from '../config.js';
import { db } from '../services/db.js';
import { CodingTaskRepository } from './CodingTaskRepository.js';
import { CodingToolEngine } from './CodingToolEngine.js';
import { CodingModelAdapter, discoverCodingModels } from './CodingModelAdapter.js';
import { WorkspaceFiles } from './WorkspaceFiles.js';
import { digest, fail, plain } from './contracts.js';

const terminal = new Set(['done', 'blocked', 'cancelled', 'error']);
export const requiredValidations = (task) => {
  const intent = task.replace(
    /\b(?:do not|don't|never|skip|without)\s+(?:(?:run(?:ning)?|execut(?:e|ing)|perform(?:ing)?)\s+)?(?:any\s+)?(?:commands?|tests?|builds?|validation)(?:\s*(?:,|and|or)\s*(?:commands?|tests?|builds?))*/gi,
    '',
  );
  const kinds = [];
  if (/\btests?\b/i.test(intent)) kinds.push('tests');
  if (
    /\b(?:(?:run|execute|check|verify|fix)\s+(?:the\s+)?build|build\s+(?:command|script|errors?|failures?|passes?|succeeds?)|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build)\b/i.test(
      intent,
    )
  )
    kinds.push('build');
  if (!kinds.length && /\b(?:verify|debug|fix|full[ -]stack|working application)\b/i.test(intent))
    kinds.push('tests');
  if (!kinds.length && /\brun\b/i.test(intent)) kinds.push('command');
  return kinds;
};
export class CodingAgentService {
  constructor({
    repository = new CodingTaskRepository(db),
    model = new CodingModelAdapter(),
    workspace = getWorkspaceForUser,
    filesFactory = (opts) => new WorkspaceFiles(opts),
    storage = path.join(config.appDataPath, 'storage', 'coding'),
    engine,
  } = {}) {
    Object.assign(this, { repository, model, workspace, filesFactory, storage });
    this.engine = engine || new CodingToolEngine({ repository });
    this.jobs = new Map();
    this.workspaceJobs = new Map();
    this.operatorJobs = new Map();
    repository.recoverInterrupted();
  }
  models() {
    return discoverCodingModels();
  }
  async context(userId, workspaceId, { taskId, signal, files } = {}) {
    const workspace = await this.workspace(userId, workspaceId);
    const root = (await validateWorkspaceRoot(workspace.root)).root;
    const stat = await fs.lstat(root);
    const binding = digest({ root, dev: String(stat.dev), ino: String(stat.ino) });
    const directory = path.join(this.storage, digest(userId), workspaceId);
    return {
      userId,
      workspaceId,
      taskId,
      root,
      binding,
      currentBinding: binding,
      signal,
      files:
        files ||
        this.filesFactory({
          root,
          checkpointDirectory: directory,
          protectedRoots: [path.join(config.appDataPath, 'storage'), this.storage],
          signal,
        }),
    };
  }
  async authorize(userId, workspaceId, write) {
    if (typeof write !== 'boolean')
      throw fail('INVALID_GRANT', 'Choose whether this workspace permits coding writes.');
    const context = await this.context(userId, workspaceId);
    this.repository.grant(userId, workspaceId, context.binding, write);
    this.repository.audit(userId, workspaceId, null, { stage: 'workspace_grant', write });
    if (!write)
      for (const job of this.jobs.values())
        if (job.task.workspaceId === workspaceId && job.userId === userId) {
          job.controller.abort();
          if (job.task.status === 'waiting_approval')
            this.finishError(job, fail('CANCELLED', 'Workspace authorization was revoked.'));
        }
    if (!write)
      for (const job of this.operatorJobs.values())
        if (job.workspaceId === workspaceId && job.userId === userId) job.controller.abort();
    return { workspaceId, writeAuthorized: write };
  }
  async tree(userId, workspaceId) {
    const context = await this.context(userId, workspaceId);
    return {
      ...(await context.files.list({ path: '' })),
      workspaceId,
      writeAuthorized: this.repository.writeAllowed(userId, workspaceId, context.binding),
    };
  }
  async read(userId, workspaceId, file) {
    return (await this.context(userId, workspaceId)).files.read({ path: file });
  }
  async tools(userId, workspaceId, request) {
    return this.operator(userId, workspaceId, (context) => this.engine.execute(request, context));
  }
  async approveTool(userId, workspaceId, approvalId, approved) {
    return this.operator(userId, workspaceId, (context) =>
      this.engine.approve(userId, workspaceId, approvalId, approved, context),
    );
  }
  async operator(userId, workspaceId, operation) {
    const controller = new AbortController();
    const context = await this.context(userId, workspaceId, { signal: controller.signal });
    if (this.workspaceJobs.has(context.binding) || this.operatorJobs.has(context.binding))
      throw fail(
        'WORKSPACE_BUSY',
        'Wait for or cancel the current coding operation before changing this workspace.',
        409,
      );
    this.operatorJobs.set(context.binding, { userId, workspaceId, controller });
    try {
      return await operation(context);
    } finally {
      this.operatorJobs.delete(context.binding);
    }
  }
  async start(userId, input) {
    if (
      !plain(input) ||
      Object.keys(input).some(
        (k) =>
          !['task', 'workspaceId', 'model', 'contextWindow', 'maxSteps', 'previousTaskId'].includes(
            k,
          ),
      ) ||
      typeof input.task !== 'string' ||
      !input.task.trim() ||
      input.task.length > 16000 ||
      typeof input.workspaceId !== 'string' ||
      typeof input.model !== 'string' ||
      !input.model
    )
      throw fail(
        'INVALID_CODING_TASK',
        'Select a workspace and installed coding model, and enter a task.',
      );
    const controller = new AbortController();
    const context = await this.context(userId, input.workspaceId, { signal: controller.signal });
    if (!this.repository.writeAllowed(userId, input.workspaceId, context.binding))
      throw fail('WRITE_GRANT_REQUIRED', 'Authorize this workspace for coding first.', 403);
    if (
      this.workspaceJobs.has(context.binding) ||
      this.operatorJobs.has(context.binding) ||
      this.jobs.size >= 4
    )
      throw fail('CODING_BUSY', 'A task is already using this workspace or coding is busy.', 409);
    if (
      input.maxSteps !== undefined &&
      (!Number.isInteger(input.maxSteps) || input.maxSteps < 1 || input.maxSteps > 50)
    )
      throw fail('INVALID_CODING_TASK', 'Use a step limit from 1 to 50.');
    const conversation = [];
    if (input.previousTaskId !== undefined) {
      if (typeof input.previousTaskId !== 'string' || input.previousTaskId.length > 100)
        throw fail('INVALID_CODING_TASK', 'Choose a valid previous coding task.');
      let previousId = input.previousTaskId;
      const seen = new Set();
      while (previousId && conversation.length < 6 && !seen.has(previousId)) {
        seen.add(previousId);
        const previous = this.repository.get(userId, previousId);
        if (previous.workspaceId !== input.workspaceId)
          throw fail(
            'TASK_WORKSPACE_MISMATCH',
            'Continue a task only in its original workspace.',
            409,
          );
        if (!terminal.has(previous.status))
          throw fail('CODING_BUSY', 'Wait for the previous task to finish before continuing.', 409);
        conversation.unshift({
          goal: previous.goal.slice(0, 4000),
          summary: previous.summary.slice(0, 2000),
          status: previous.status,
          changedFiles: previous.changes.slice(0, 30).map(({ path }) => path),
        });
        previousId = previous.previousTaskId;
      }
    }
    const task = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      model: input.model,
      goal: input.task.trim(),
      previousTaskId: input.previousTaskId || null,
      conversation,
      binding: context.binding,
      contextWindow: input.contextWindow || 8192,
      status: 'running',
      phase: 'plan',
      plan: [],
      events: [],
      changes: [],
      validation: [],
      approvals: [],
      checkpoints: [],
      metrics: [],
      summary: '',
      createdAt: new Date().toISOString(),
    };
    const execution = new ExecutionController(task.goal, {
      ownerId: userId,
      sessionId: task.id,
      taskType: 'coding',
      mode: 'coding',
      maxSteps: input.maxSteps || 30,
      maxRetries: 2,
      save: (saved) => {
        task.state = saved;
        task.phase = saved.state.phase;
        this.repository.save(userId, task);
      },
      onEvent: (event) => {
        task.events.push({ ...event, at: new Date().toISOString() });
        task.events = task.events.slice(-150);
        this.repository.save(userId, task);
      },
    });
    const job = {
      userId,
      task,
      context: { ...context, taskId: task.id },
      controller,
      execution,
      failures: new Map(),
    };
    this.jobs.set(task.id, job);
    this.workspaceJobs.set(context.binding, task.id);
    this.drive(job).catch((error) => this.finishError(job, error));
    return structuredClone(task);
  }
  async dispatch(job, step, approvedId) {
    const fresh = await this.context(job.userId, job.task.workspaceId, {
      taskId: job.task.id,
      signal: job.controller.signal,
      files: job.context.files,
    });
    const context = { ...fresh, binding: job.task.binding };
    const request = { tool: `${step.tool}.${step.action}`, params: step.params };
    const result = approvedId
      ? await this.engine.approve(job.userId, job.task.workspaceId, approvedId, true, context)
      : await this.engine.execute(request, context);
    if (result.needsConfirmation)
      job.task.approvals = [
        {
          approvalId: result.approvalId,
          tool: request.tool,
          params: request.params,
          preview: result.preview,
          message: result.message,
        },
      ];
    if (result.success && result.data) {
      const data = result.data;
      if (data.changed && data.path) {
        job.task.changes = job.task.changes.filter((c) => c.path !== data.path);
        job.task.changes.push({
          path: data.path,
          version: data.version || null,
          deleted: request.tool === 'fs.delete',
          diff: data.diff || null,
        });
      }
      if (request.tool === 'checkpoint.create') job.task.checkpoints.push(data);
    }
    if (['tests.run', 'exec.run'].includes(request.tool) && !result.needsConfirmation) {
      const data = result.data || {};
      const kind =
        request.tool === 'tests.run'
          ? 'tests'
          : request.params.args.some((a) => /^(?:build|--build)$/i.test(a))
            ? 'build'
            : 'command';
      job.task.validation.push({
        kind,
        tool: request.tool,
        ...request.params,
        exitCode: data.exitCode ?? null,
        durationMs: data.durationMs ?? null,
        stdout: data.stdout || '',
        stderr: data.stderr || '',
        status:
          result.success && data.exitCode === 0
            ? 'passed'
            : result.error?.code === 'ISOLATION_UNAVAILABLE'
              ? 'blocked'
              : 'failed',
        code: result.error?.code,
        message: result.error?.message,
      });
    }
    return result;
  }
  async perform(job, request) {
    const [tool, action] = request.tool.split('.');
    job.execution.plan([{ tool, action, params: request.params, description: request.tool }]);
    const result = await job.execution.execute((step) => this.dispatch(job, step), {
      signal: job.controller.signal,
    });
    return this.settle(job, request, result);
  }
  settle(job, request, result) {
    if (job.execution.state.phase === 'waiting_confirmation') {
      job.task.status = 'waiting_approval';
      this.repository.save(job.userId, job.task);
      return false;
    }
    if (job.controller.signal.aborted) {
      this.finishError(job, fail('CANCELLED', 'Coding task cancelled.'));
      return false;
    }
    if (result?.success === true) {
      job.execution.advance();
      return true;
    }
    const code = result?.error?.code || result?.raw?.error?.code || 'TOOL_FAILED';
    const key = digest({ request, code });
    const count = (job.failures.get(key) || 0) + 1;
    job.failures.set(key, count);
    if (
      [
        'ISOLATION_UNAVAILABLE',
        'WRITE_GRANT_REQUIRED',
        'WORKSPACE_CHANGED',
        'TOOL_DENIED',
        'PROTECTED_FILE',
        'WORKSPACE_PATH_DENIED',
        'COMMAND_DENIED',
        'DEPENDENCY_INSTALL_BLOCKED',
      ].includes(code) ||
      count >= 2 ||
      !canReplan(job.execution.state)
    ) {
      this.finishError(
        job,
        fail(
          code,
          result?.error?.message || 'Coding action was blocked or repeated without progress.',
        ),
      );
      return false;
    }
    job.execution.recover();
    return true;
  }
  async drive(job) {
    const { task, execution } = job;
    if (execution.state.phase === 'idle') {
      execution.move('plan');
      if (!(await this.perform(job, { tool: 'workspace.inspect', params: {} }))) return;
      if (!(await this.perform(job, { tool: 'checkpoint.create', params: {} }))) return;
    }
    while (!terminal.has(task.status) && task.status !== 'waiting_approval') {
      job.controller.signal.throwIfAborted();
      if (isStepBudgetExhausted(execution.state))
        throw fail('STEP_LIMIT', 'The coding task reached its bounded action limit.');
      task.phase = 'plan';
      this.repository.save(job.userId, task);
      const history = execution.state.attempts
        .filter((a) => a.observation)
        .slice(-8)
        .map((a) => ({
          tool: `${a.request.tool}.${a.request.action}`,
          success: a.observation.success,
          data: a.observation.data,
          error: a.observation.error,
        }));
      if (task.conversation?.length) history.unshift({ previousConversation: task.conversation });
      history.push({
        authority: 'server-observed-task-state',
        changedFiles: task.changes.map((c) => ({
          path: c.path,
          version: c.version,
          deleted: c.deleted,
        })),
        requiredValidations: requiredValidations(task.goal),
        validation: task.validation.map(({ kind, status, exitCode }) => ({
          kind,
          status,
          exitCode,
        })),
      });
      const result = await this.model.next({
        model: task.model,
        task: task.goal,
        history,
        tools: this.engine.definitions(),
        contextWindow: task.contextWindow,
        signal: job.controller.signal,
      });
      const proposal = result.proposal || result;
      if (result.metrics) task.metrics.push(result.metrics);
      if (proposal.plan) task.plan = proposal.plan;
      if (proposal.kind === 'finish') {
        await this.verify(job);
        return;
      }
      if (proposal.kind !== 'tool')
        throw fail('MODEL_OUTPUT_INVALID', 'The local model returned no validated action.');
      if (!(await this.perform(job, { tool: proposal.tool, params: proposal.params }))) return;
    }
  }
  async verify(job) {
    const context = await this.context(job.userId, job.task.workspaceId, {
      signal: job.controller.signal,
      files: job.context.files,
    });
    if (context.binding !== job.task.binding)
      throw fail('WORKSPACE_CHANGED', 'The workspace changed before final verification.', 409);
    job.controller.signal.throwIfAborted();
    for (const changed of job.task.changes) {
      try {
        const current = await job.context.files.read({
          path: changed.path,
          signal: job.controller.signal,
        });
        if (changed.deleted || current.version !== changed.version)
          throw fail(
            'VERIFICATION_CONFLICT',
            'A changed file no longer matches the recorded result.',
            409,
          );
      } catch (error) {
        if (!(changed.deleted && ['ENOENT', 'FILE_NOT_FOUND'].includes(error.code))) throw error;
      }
    }
    for (const kind of requiredValidations(job.task.goal)) {
      const latest = new Map();
      for (const validation of job.task.validation.filter((v) => v.kind === kind))
        latest.set(
          digest({ executable: validation.executable, args: validation.args }),
          validation,
        );
      if (!latest.size || [...latest.values()].some((v) => v.status !== 'passed'))
        throw fail(
          'VALIDATION_NOT_RUN',
          `Required ${kind} validation has not executed and passed, or has an unresolved failure. No project success is claimed.`,
          409,
        );
    }
    if (job.execution.state.phase === 'replan')
      throw fail(
        'UNRESOLVED_FAILURE',
        'A failed operation must be resolved before completion.',
        409,
      );
    const changedCount = job.task.changes.length;
    if (
      !changedCount &&
      /\b(?:create|build|develop|scaffold|implement|modify|edit|change|patch|fix|refactor|add|remove|delete)\b/i.test(
        job.task.goal,
      )
    )
      throw fail(
        'NO_VERIFIED_CHANGES',
        'No executed file changes were recorded for this task.',
        409,
      );
    const passed = job.task.validation.filter((v) => v.status === 'passed').length;
    const summary = `${changedCount} recorded file change${changedCount === 1 ? '' : 's'} verified against current contents. ${passed ? `${passed} validation command${passed === 1 ? '' : 's'} passed.` : 'No project test or build command has run.'}`;
    job.execution.finish({
      success: true,
      summary,
    });
    job.task.status = 'done';
    job.task.summary = job.execution.state.verdict.summary;
    this.repository.save(job.userId, job.task);
    this.release(job);
  }
  get(userId, id) {
    return this.repository.get(userId, id);
  }
  async approve(userId, id, approvalId, approved) {
    const saved = this.repository.get(userId, id);
    const job = this.jobs.get(id);
    if (
      !job ||
      job.userId !== userId ||
      saved.status !== 'waiting_approval' ||
      job.task.approvals[0]?.approvalId !== approvalId ||
      typeof approved !== 'boolean'
    )
      throw fail(
        'APPROVAL_INVALID',
        'This task has no matching live approval. Start a new task after an application restart.',
        409,
      );
    if (!approved) {
      this.repository.takeApproval(userId, saved.workspaceId, approvalId);
      this.finishError(
        job,
        fail('APPROVAL_DENIED', 'The action was rejected; pending changes were not executed.'),
      );
      return this.get(userId, id);
    }
    job.task.approvals = [];
    job.task.status = 'running';
    const result = await job.execution.execute((step) => this.dispatch(job, step, approvalId), {
      signal: job.controller.signal,
      confirmationId: approvalId,
    });
    const step = currentStep(job.execution.state);
    if (this.settle(job, { tool: `${step.tool}.${step.action}`, params: step.params }, result))
      this.drive(job).catch((e) => this.finishError(job, e));
    return this.get(userId, id);
  }
  cancel(userId, id) {
    const task = this.repository.get(userId, id);
    const job = this.jobs.get(id);
    if (job && job.userId === userId) {
      job.controller.abort();
      if (task.status === 'waiting_approval')
        this.finishError(job, fail('CANCELLED', 'Coding task cancelled.'));
    } else if (!terminal.has(task.status)) {
      task.status = 'cancelled';
      task.summary = 'Interrupted task cancelled; no operation was replayed.';
      this.repository.save(userId, task);
    }
    return this.get(userId, id);
  }
  finishError(job, error) {
    if (terminal.has(job.task.status)) return;
    const cancelled = job.controller.signal.aborted || error.code === 'CANCELLED';
    const timedOut = error.name === 'TimeoutError';
    const code = cancelled
      ? 'CANCELLED'
      : timedOut
        ? 'MODEL_TIMEOUT'
        : error.code || 'CODING_ERROR';
    const message = cancelled
      ? 'Coding task cancelled. Recorded changes are available for review.'
      : timedOut
        ? 'The local model took too long to respond. Retry with a smaller request or another installed model.'
        : error.status
          ? error.message
          : 'The coding task encountered an internal error. Retry the task; details were saved in the application log.';
    if (!cancelled && !timedOut && !error.status)
      console.error(`[coding] Task ${job.task.id} failed:`, error);
    try {
      job.execution.stop(cancelled ? 'cancelled' : 'error', code);
    } catch {
      /* Saved state remains reviewable. */
    }
    job.task.status = cancelled ? 'cancelled' : error.code ? 'blocked' : 'error';
    job.task.reason = code;
    job.task.error = { code, message };
    job.task.summary = message;
    job.task.events.push({ type: 'coding_error', code, message, at: new Date().toISOString() });
    job.task.approvals = [];
    this.repository.clearTaskApprovals(job.userId, job.task.workspaceId, job.task.id);
    this.repository.save(job.userId, job.task);
    this.release(job);
  }
  release(job) {
    this.jobs.delete(job.task.id);
    if (this.workspaceJobs.get(job.task.binding) === job.task.id)
      this.workspaceJobs.delete(job.task.binding);
  }
}
