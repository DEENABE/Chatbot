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
import { codingGuidance } from './CodingGuidance.js';
import { RepeatGuard } from './RepeatGuard.js';
import { planReactViteScaffold, wantsReactVite, SCAFFOLD_NOTE } from './ProjectScaffold.js';

const launchOnly = (goal) =>
  /^\s*(?:please\s+)?(?:run|start|launch|open|preview)\s+(?:that file|this file|the file|it|(?:the |this |my )?(?:app|website|project)|[\w./\\-]+\.(?:html?|py|[cm]?js))\s*[.!?]*\s*$/i.test(
    goal,
  ) ||
  // Free wording such as "upto now okay, now start and run the code" / "run panni kaatu".
  (goal.length <= 120 &&
    /\b(?:run|start|launch|preview)\b/i.test(goal) &&
    /\b(?:it|app|application|code|project|website|site|server|this|that)\b/i.test(goal) &&
    !/\b(?:create|build|make|add|fix|change|edit|update|modify|implement|write|generate|install|test|tests|compile|check|debug|refactor|delete|remove|rename|deploy)\b|\.(?:html?|py|[cm]?js)\b/i.test(
      goal,
    ));

/**
 * A dev server never exits, so `exec.run npm run dev` (which waits for the exit code) can
 * only time out and be recorded as a failure even though the server started. Long-running
 * servers belong to exec.start, which returns once the process is up.
 */
export function asServerLaunch(call) {
  if (call?.tool !== 'exec.run' || !Array.isArray(call.params?.args)) return null;
  const { executable, args } = call.params;
  const exe = String(executable || '')
    .toLowerCase()
    .replace(/\.(?:cmd|exe)$/, '');
  const script = args[0] === 'run' ? args[1] : args[0];
  const npmServer =
    ['npm', 'pnpm', 'yarn', 'bun'].includes(exe) && ['dev', 'serve', 'preview'].includes(script);
  const viteServer =
    (exe === 'npx' && args[0] === 'vite' && !['build', 'optimize'].includes(args[1])) ||
    (exe === 'vite' && !['build', 'optimize'].includes(args[0]));
  if (!npmServer && !viteServer) return null;
  const { timeoutMs, ...rest } = call.params;
  const vite = viteServer || script === 'dev' || script === 'preview';
  const extra = [];
  if (vite && !args.includes('--port')) {
    if (npmServer && exe === 'npm' && !args.includes('--')) extra.push('--');
    extra.push('--host', '127.0.0.1', '--port', '5175', '--strictPort');
  }
  return {
    tool: 'exec.start',
    params: {
      ...rest,
      args: [...args, ...extra],
      ...(vite && !rest.port ? { port: 5175 } : {}),
    },
  };
}

const terminal = new Set(['done', 'blocked', 'cancelled', 'error']);
// Mistakes a small model makes and can fix from the message: allow more attempts before giving up.
const SOFT_FAILURES = new Set([
  'WRONG_LOCATION',
  'FILE_EXISTS',
  'FILE_CONFLICT',
  'PACKAGE_JSON_REQUIRED',
  'NPM_SCRIPT_MISSING',
]);
// Project-state fingerprint: a read-only call is only repeatable once something changed.
const progressState = (task) =>
  digest({
    changes: task.changes.map(({ path, version }) => ({ path, version })),
    directories: task.directories || [],
  });
export const requiredValidations = (task) => {
  const intent = task.replace(
    /\b(?:do not|don't|never|skip|without)\s+(?:(?:run(?:ning)?|execut(?:e|ing)|perform(?:ing)?)\s+)?(?:any\s+)?(?:commands?|tests?|builds?|validation)(?:\s*(?:,|and|or)\s*(?:commands?|tests?|builds?))*/gi,
    '',
  );
  const kinds = [];
  if (/\bpy_compile\b|\bsyntax\s+(?:check|validation)\b|\bnode\s+--check\b/i.test(intent))
    kinds.push('syntax');
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
    starterProjects = true,
  } = {}) {
    Object.assign(this, { repository, model, workspace, filesFactory, storage, starterProjects });
    this.engine = engine || new CodingToolEngine({ repository });
    this.jobs = new Map();
    this.workspaceJobs = new Map();
    this.operatorJobs = new Map();
    repository.recoverInterrupted();
  }
  async models() {
    const result = await discoverCodingModels();
    return { ...result, defaultModel: config.codingModel };
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
      executionPolicy: this.repository.executionPolicy(userId, workspaceId, binding),
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
    if (!write) {
      this.repository.setExecutionPolicy(userId, workspaceId, context.binding, {
        commands: false,
        downloads: false,
      });
    }
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
    if (!write) await this.engine.runtime.stopWorkspace(context);
    return { workspaceId, writeAuthorized: write };
  }
  async tree(userId, workspaceId) {
    const context = await this.context(userId, workspaceId);
    return {
      ...(await context.files.list({ path: '' })),
      workspaceId,
      writeAuthorized: this.repository.writeAllowed(userId, workspaceId, context.binding),
      executionPolicy: context.executionPolicy,
    };
  }
  async read(userId, workspaceId, file) {
    return (await this.context(userId, workspaceId)).files.read({ path: file });
  }
  async runtime(userId, workspaceId) {
    return this.engine.runtime.inspect(await this.context(userId, workspaceId));
  }
  async setExecutionPolicy(userId, workspaceId, policy) {
    if (
      !plain(policy) ||
      Object.keys(policy).some((key) => !['commands', 'downloads'].includes(key))
    )
      throw fail(
        'INVALID_EXECUTION_POLICY',
        'Choose project command and package download permissions.',
      );
    const context = await this.context(userId, workspaceId);
    if (!this.repository.writeAllowed(userId, workspaceId, context.binding))
      throw fail('WRITE_GRANT_REQUIRED', 'Enable project changes before project execution.', 403);
    const saved = this.repository.setExecutionPolicy(userId, workspaceId, context.binding, policy);
    if (!saved.commands) {
      for (const job of this.jobs.values())
        if (job.userId === userId && job.task.workspaceId === workspaceId) {
          job.controller.abort();
          if (job.task.status === 'waiting_approval')
            this.finishError(job, fail('CANCELLED', 'Project command permission was revoked.'));
        }
      for (const job of this.operatorJobs.values())
        if (job.workspaceId === workspaceId && job.userId === userId) job.controller.abort();
      await this.engine.runtime.stopWorkspace(context);
    }
    return saved;
  }
  async stopProcess(userId, workspaceId, jobId) {
    await this.workspace(userId, workspaceId);
    return this.engine.runtime.stop({ userId, workspaceId }, jobId);
  }
  async openPreview(userId, workspaceId, jobId) {
    await this.workspace(userId, workspaceId);
    return this.engine.runtime.openPreview({ userId, workspaceId }, jobId);
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
      directories: [],
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
      maxSteps: input.maxSteps || 40,
      maxRetries: 4,
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
      finishRepairs: 0,
      repeat: new RepeatGuard(),
      progressFeedback: null,
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
    const request = { tool: `${step.tool}.${step.action}`, params: step.params };
    // Starter files are fixed application content, not model output: no per-file prompt.
    const serverOwned = !approvedId && job.serverWrites?.has(digest(request));
    const context = {
      ...fresh,
      binding: job.task.binding,
      ...(serverOwned ? { approved: true } : {}),
    };
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
    if (result.data && !result.needsConfirmation) {
      const data = result.data;
      if (request.tool === 'fs.write' && Array.isArray(data.createdDirectories))
        job.task.directories = [
          ...new Set([...(job.task.directories || []), ...data.createdDirectories]),
        ];
      if (data.changed && data.path && request.tool === 'fs.mkdir') {
        job.task.directories = [...new Set([...(job.task.directories || []), data.path])];
      } else if (data.changed && data.path) {
        job.task.changes = job.task.changes.filter((c) => c.path !== data.path);
        job.task.changes.push({
          path: data.path,
          version: data.version || null,
          deleted: request.tool === 'fs.delete',
          diff: data.diff || null,
        });
      }
      if (request.tool === 'checkpoint.create') job.task.checkpoints.push(data);
      for (const change of data.changes || []) {
        job.task.changes = job.task.changes.filter((item) => item.path !== change.path);
        job.task.changes.push(change);
      }
      if (['exec.start', 'preview.start'].includes(request.tool) && data.jobId) {
        job.task.launches = [...(job.task.launches || []), data];
      }
    }
    if (['tests.run', 'exec.run'].includes(request.tool) && !result.needsConfirmation) {
      const data = result.data || {};
      const kind =
        request.params.args.includes('py_compile') ||
        (request.params.executable === 'node' && request.params.args.includes('--check'))
          ? 'syntax'
          : request.params.args.some((a) => /^(?:build|--build)$/i.test(a))
            ? 'build'
            : request.tool === 'tests.run' ||
                request.params.args.some((a) => /^(?:unittest|pytest|vitest|test|--test)$/i.test(a))
              ? 'tests'
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
        changeRevision: digest(job.task.changes.map(({ path, version }) => ({ path, version }))),
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
    const key = digest({
      request,
      code,
      changedVersions: job.task.changes.map(({ path, version }) => ({ path, version })),
    });
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
        'EXECUTION_GRANT_REQUIRED',
        'DOWNLOAD_GRANT_REQUIRED',
      ].includes(code) ||
      count >= (SOFT_FAILURES.has(code) ? 4 : 2) ||
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
      if (!(await this.perform(job, { tool: 'fs.list', params: { path: '' } }))) return;
      if (
        this.repository.executionPolicy(job.userId, task.workspaceId, task.binding).commands &&
        !(await this.perform(job, { tool: 'runtime.inspect', params: {} }))
      )
        return;
      // The model sees these results already; repeating them is a wasted step.
      for (const seed of [
        { tool: 'workspace.inspect', params: {} },
        { tool: 'fs.list', params: { path: '' } },
        { tool: 'runtime.inspect', params: {} },
      ])
        job.repeat.check(seed, progressState(task));
      if (!(await this.scaffold(job))) return;
    }
    if (
      !job.launchPrepared &&
      launchOnly(task.goal) &&
      this.repository.executionPolicy(job.userId, task.workspaceId, task.binding).commands
    ) {
      job.launchPrepared = true;
      const launch = await this.runRequest(job);
      if (launch) {
        job.directLaunch = true;
        if (!(await this.perform(job, launch))) return;
      }
    }
    if (job.directLaunch) {
      job.directLaunch = false;
      const latestLaunch = task.launches?.at(-1);
      const output =
        latestLaunch &&
        this.engine.runtime.output(
          { userId: job.userId, workspaceId: task.workspaceId },
          latestLaunch.jobId,
        );
      if (
        output &&
        (output.status === 'running' || (output.status === 'exited' && output.exitCode === 0))
      ) {
        await this.verify(job);
        return;
      }
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
        createdDirectories: task.directories || [],
        requiredValidations: requiredValidations(task.goal),
        validation: task.validation.map(({ kind, status, exitCode }) => ({
          kind,
          status,
          exitCode,
        })),
        ...(job.scaffolded ? { projectScaffold: SCAFFOLD_NOTE } : {}),
        ...(job.verificationFeedback ? { verificationPending: job.verificationFeedback } : {}),
        ...(job.progressFeedback ? { noProgress: job.progressFeedback } : {}),
      });
      const policy = this.repository.executionPolicy(job.userId, task.workspaceId, task.binding);
      history.push({ executionPolicy: policy });
      const result = await this.model.next({
        model: task.model,
        task: task.goal,
        history,
        tools: this.engine.definitions(policy),
        guidance:
          codingGuidance(task.goal) +
          ' Plain HTML uses preview.start with its relative path: no npm package or script is needed. Inspect package.json before using npm dev/start; never invent a missing start script.',
        contextWindow: task.contextWindow,
        signal: job.controller.signal,
      });
      const proposal = result.proposal || result;
      if (result.metrics) task.metrics.push(result.metrics);
      if (proposal.plan) task.plan = proposal.plan;
      if (proposal.kind === 'finish') {
        const outcome = await this.tryFinish(job, policy);
        if (outcome !== 'continue') return;
        continue;
      }
      if (proposal.kind !== 'tool')
        throw fail('MODEL_OUTPUT_INVALID', 'The local model returned no validated action.');
      let call = { tool: proposal.tool, params: proposal.params };
      const server = asServerLaunch(call);
      if (server) {
        task.events.push({
          type: 'server_launch',
          message: `${[call.params.executable, ...call.params.args].join(' ')} keeps running, so it is started in the background (exec.start) instead of waiting for it to exit.`,
          at: new Date().toISOString(),
        });
        call = server;
      }
      const repeated = job.repeat.check(call, progressState(task));
      if (repeated && call.tool === 'fs.write') {
        // Writing the same thing again cannot add anything: the files are as complete as this
        // model will make them, so check the project (build/run) and show it the real result.
        task.events.push({
          type: 'repeat_blocked',
          message: repeated.message,
          at: new Date().toISOString(),
        });
        job.progressFeedback = repeated.message;
        const outcome = await this.tryFinish(job, policy, { forced: true });
        if (outcome !== 'continue') return;
        continue;
      }
      if (repeated) {
        if (repeated.exhausted)
          throw fail(
            'NO_PROGRESS',
            'The model kept repeating the same read-only action without creating or changing anything. Make the request more specific (for example name the files to create) or choose a larger model.',
          );
        job.progressFeedback = repeated.message;
        task.events.push({
          type: 'repeat_blocked',
          message: repeated.message,
          at: new Date().toISOString(),
        });
        this.repository.save(job.userId, task);
        continue;
      }
      job.progressFeedback = null;
      if (!(await this.perform(job, call))) return;
      // Two harmless no-op rewrites in a row mean the model has nothing left to write.
      const last = execution.state.attempts.at(-1)?.observation;
      job.noops = last?.data?.unchanged === true ? (job.noops || 0) + 1 : 0;
      if (job.noops >= 2) {
        job.noops = 0;
        const outcome = await this.tryFinish(job, policy, { forced: true });
        if (outcome !== 'continue') return;
      }
    }
  }
  /**
   * React/Vite requests get a known-good starter written by the application before the
   * model runs, then one `npm install` from that package.json. Returns false when the
   * task stopped (approval wait, cancel, error) like perform().
   */
  async scaffold(job) {
    const { task } = job;
    const goals = [task.goal, ...(task.conversation || []).map((turn) => turn.goal)].join('\n');
    if (!this.starterProjects || !wantsReactVite(goals)) return true;
    let plan;
    try {
      plan = await planReactViteScaffold(job.context.files, {
        goal: goals,
        name: path.basename(job.context.root || ''),
      });
    } catch (error) {
      // An unreadable folder is reported by the normal tools; the model can still try.
      console.warn(`[coding] React/Vite starter skipped: ${error.message}`);
      return true;
    }
    if (!plan) return true;
    job.serverWrites = new Set(plan.writes.map((params) => digest({ tool: 'fs.write', params })));
    task.events.push({
      type: 'project_scaffold',
      files: plan.writes.map(({ path: file }) => file),
      message: plan.repairOnly
        ? 'Setting "type": "module" in package.json so Vite loads vite.config.js as ESM.'
        : 'Creating a working React + Vite starter project.',
      at: new Date().toISOString(),
    });
    this.repository.save(job.userId, task);
    try {
      for (const params of plan.writes)
        if (!(await this.perform(job, { tool: 'fs.write', params }))) return false;
    } finally {
      job.serverWrites = null;
    }
    if (plan.repairOnly) return true;
    job.scaffolded = true;
    const policy = this.repository.executionPolicy(job.userId, task.workspaceId, task.binding);
    if (policy.commands && policy.downloads)
      return this.perform(job, { tool: 'deps.install', params: { manager: 'npm' } });
    return true;
  }
  /** The model (or the server, when it stalls) says the work is complete: verify, or run the next check. */
  async tryFinish(job, policy, { forced = false } = {}) {
    const { task } = job;
    try {
      await this.verify(job);
      return 'done';
    } catch (error) {
      // Server-initiated: the model never said it was finished, so an unrelated blocker is feedback, not a verdict.
      if (forced && (!error.validationKind || !policy.commands)) {
        if (++job.finishRepairs > 2) throw error;
        job.verificationFeedback = error.message;
        job.task.events.push({
          type: 'verification_pending',
          message: error.message,
          at: new Date().toISOString(),
        });
        this.repository.save(job.userId, task);
        return 'continue';
      }
      if (!error.validationKind || !policy.commands) throw error;
      const check = await this.nextValidation(job, error.validationKind);
      if (check) return (await this.perform(job, check)) ? 'continue' : 'stopped';
      if (++job.finishRepairs > 2) throw error;
      job.verificationFeedback = error.message;
      task.events.push({
        type: 'verification_pending',
        message: error.message,
        at: new Date().toISOString(),
      });
      this.repository.save(job.userId, task);
      return 'continue';
    }
  }
  async runRequest(job) {
    const explicit = job.task.goal
      .match(
        /^\s*(?:please\s+)?(?:run|start|launch|open|preview)\s+["']?([^"'\r\n]+\.(?:html?|py|[cm]?js))["']?\s*[.!?]*\s*$/i,
      )?.[1]
      ?.replaceAll('\\', '/');
    if (
      (/\.(?:html?|py|[cm]?js)\b/i.test(job.task.goal) && !explicit) ||
      (explicit && /^(?:[a-z]:|\/)/i.test(explicit))
    )
      return null;
    const recent = [
      ...job.task.changes.map((change) => change.path),
      ...(job.task.conversation || [])
        .slice()
        .reverse()
        .flatMap((turn) => turn.changedFiles || []),
    ];
    // A package.json dev/start script is how a Node/Vite project runs: index.html or
    // vite.config.js on their own would start the wrong thing.
    if (!explicit && !/\bfile\b/i.test(job.task.goal)) {
      const scripted = await this.scriptLaunch(job);
      if (scripted) return scripted;
    }
    const candidates = explicit ? [explicit] : [...recent, 'index.html', 'public/index.html'];
    for (const candidate of [...new Set(candidates)]) {
      if (
        !/\.(?:html?|py|[cm]?js)$/i.test(candidate) ||
        /(?:^|\/)[^/]*\.config\.[cm]?js$/i.test(candidate)
      )
        continue;
      try {
        await job.context.files.read({ path: candidate });
      } catch (error) {
        if (['FILE_NOT_FOUND', 'ENOENT'].includes(error.code)) continue;
        throw error;
      }
      if (/\.html?$/i.test(candidate))
        return { tool: 'preview.start', params: { path: candidate } };
      return {
        tool: 'exec.start',
        params: { executable: /\.py$/i.test(candidate) ? 'python' : 'node', args: [candidate] },
      };
    }
    return null;
  }
  async scriptLaunch(job) {
    try {
      const manifest = JSON.parse((await job.context.files.read({ path: 'package.json' })).content);
      if (manifest.scripts?.dev) {
        const vite = /(?:^|\s|\/)vite(?:\s|$)/.test(manifest.scripts.dev);
        return {
          tool: 'exec.start',
          params: {
            executable: 'npm',
            args: [
              'run',
              'dev',
              ...(vite ? ['--', '--host', '127.0.0.1', '--port', '5175', '--strictPort'] : []),
            ],
            ...(vite ? { port: 5175 } : {}),
          },
        };
      }
      if (manifest.scripts?.start)
        return { tool: 'exec.start', params: { executable: 'npm', args: ['start'] } };
    } catch (error) {
      if (!['FILE_NOT_FOUND', 'ENOENT'].includes(error.code)) throw error;
    }
    return null;
  }
  async nextValidation(job, kind) {
    // Small local models sometimes finish after writing files or compiling them.
    // Schedule known project checks through the same exact approval path.
    const changes = job.task.changes.filter((change) => !change.deleted);
    let request;
    if (kind === 'command') request = await this.runRequest(job);
    if (kind === 'syntax' && changes.some((change) => /\.py$/i.test(change.path)))
      request = {
        tool: 'exec.run',
        params: {
          executable: 'python',
          args: [
            '-m',
            'py_compile',
            ...changes.filter((change) => /\.py$/i.test(change.path)).map((change) => change.path),
          ],
        },
      };
    if (kind === 'tests' && changes.some((change) => /\.py$/i.test(change.path))) {
      const listing = await job.context.files.list({ path: '', recursive: true });
      const tests = [...changes, ...(listing.entries || [])].filter((entry) =>
        /(?:^|\/)(?:test_[^/]+|[^/]+_test)\.py$/i.test(entry.path || ''),
      );
      const directories = [...new Set(tests.map((entry) => path.posix.dirname(entry.path)))];
      for (const directory of directories.slice(0, 6)) {
        const candidate = {
          tool: 'tests.run',
          params: { executable: 'python', args: ['-m', 'unittest', 'discover', '-s', directory] },
        };
        if (!this.hasCurrentPassingCheck(job, candidate)) {
          request = candidate;
          break;
        }
      }
    }
    if (kind === 'build') {
      try {
        const manifest = JSON.parse(
          (await job.context.files.read({ path: 'package.json' })).content,
        );
        if (manifest.scripts?.build) {
          request = { tool: 'exec.run', params: { executable: 'npm', args: ['run', 'build'] } };
          // Builds are offline: a project whose packages were never installed cannot build.
          const wantsPackages =
            Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).length > 0;
          const installed = await job.context.files
            .list({ path: 'node_modules', maxEntries: 1 })
            .then(() => true)
            .catch(() => false);
          if (
            wantsPackages &&
            !installed &&
            this.repository.executionPolicy(job.userId, job.task.workspaceId, job.task.binding)
              .downloads
          )
            request = { tool: 'deps.install', params: { manager: 'npm' } };
        }
      } catch (error) {
        if (!['FILE_NOT_FOUND', 'ENOENT'].includes(error.code)) throw error;
      }
    }
    if (!request) return null;
    const revision = digest(job.task.changes.map(({ path, version }) => ({ path, version })));
    const key = digest({ request, revision });
    job.automaticChecks ||= new Set();
    if (job.automaticChecks.has(key) || job.automaticChecks.size >= 8) return null;
    job.automaticChecks.add(key);
    job.task.events.push({
      type: 'automatic_validation',
      tool: request.tool,
      params: request.params,
      at: new Date().toISOString(),
    });
    return request;
  }
  hasCurrentPassingCheck(job, request) {
    const revision = digest(job.task.changes.map(({ path, version }) => ({ path, version })));
    return job.task.validation.some(
      (check) =>
        check.status === 'passed' &&
        check.changeRevision === revision &&
        check.executable === request.params.executable &&
        JSON.stringify(check.args) === JSON.stringify(request.params.args),
    );
  }
  async verify(job) {
    const context = await this.context(job.userId, job.task.workspaceId, {
      signal: job.controller.signal,
      files: job.context.files,
    });
    if (context.binding !== job.task.binding)
      throw fail('WORKSPACE_CHANGED', 'The workspace changed before final verification.', 409);
    job.controller.signal.throwIfAborted();
    for (const directory of job.task.directories || [])
      await job.context.files.list({ path: directory, maxEntries: 1 });
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
    const requirements = requiredValidations(job.task.goal);
    const policy = this.repository.executionPolicy(
      job.userId,
      job.task.workspaceId,
      job.task.binding,
    );
    if (
      policy.commands &&
      job.task.changes.some((change) => /\.py$/i.test(change.path)) &&
      !requirements.includes('syntax')
    )
      requirements.push('syntax');
    if (
      policy.commands &&
      job.task.changes.some((change) =>
        /(?:\.(?:jsx|tsx|vue|svelte|[cm]?[jt]s)|(?:^|\/)package\.json)$/i.test(change.path),
      )
    ) {
      try {
        const manifest = JSON.parse(
          (await job.context.files.read({ path: 'package.json' })).content,
        );
        if (manifest.scripts?.build && !requirements.includes('build')) requirements.push('build');
      } catch (error) {
        if (!['FILE_NOT_FOUND', 'ENOENT'].includes(error.code)) throw error;
      }
    }
    for (const kind of requirements) {
      if (
        kind === 'command' &&
        job.task.launches?.some((launch) => {
          const output = this.engine.runtime.output(
            { userId: job.userId, workspaceId: job.task.workspaceId },
            launch.jobId,
          );
          return (
            output.status === 'running' || (output.status === 'exited' && output.exitCode === 0)
          );
        })
      )
        continue;
      const latest = new Map();
      const revision = digest(job.task.changes.map(({ path, version }) => ({ path, version })));
      for (const validation of job.task.validation.filter(
        (v) => v.kind === kind && v.changeRevision === revision,
      ))
        latest.set(
          digest({ executable: validation.executable, args: validation.args }),
          validation,
        );
      const passed = [...latest.values()].some((v) => v.status === 'passed');
      if (
        !passed ||
        [...latest.values()].some((v) => v.status !== 'passed' && v.code !== 'NO_TESTS_DISCOVERED')
      ) {
        const failed = [...latest.values()]
          .reverse()
          .find((check) => check.status !== 'passed' && check.code !== 'NO_TESTS_DISCOVERED');
        if (failed) {
          const detail =
            failed.stderr
              ?.trim()
              .split(/\r?\n/)
              .filter(Boolean)
              .slice(0, 3)
              .join(' ')
              .slice(0, 500) ||
            failed.message ||
            'Review its actual output before retrying.';
          throw Object.assign(
            fail(
              failed.code || 'COMMAND_FAILED',
              `Could not complete ${[failed.executable, ...failed.args].join(' ')}${failed.exitCode !== null ? ` (exit ${failed.exitCode})` : ''}: ${detail}`,
              409,
            ),
            { validationKind: kind },
          );
        }
        throw Object.assign(
          fail(
            'VALIDATION_NOT_RUN',
            `Required ${kind} validation has not executed and passed, or has an unresolved failure. No project success is claimed.`,
            409,
          ),
          { validationKind: kind },
        );
      }
    }
    if (job.execution.state.phase === 'replan')
      throw fail(
        'UNRESOLVED_FAILURE',
        'A failed operation must be resolved before completion.',
        409,
      );
    const changedCount = job.task.changes.length;
    const changeIntent = job.task.goal.replace(
      /\b(?:(?:run|execute|check|verify)\s+(?:the\s+)?(?:npm\s+(?:run\s+)?)?build|npm\s+(?:run\s+)?build)\b/gi,
      '',
    );
    if (
      !changedCount &&
      !(
        job.task.directories?.length &&
        /\b(?:folders?|directory|directories)\b/i.test(job.task.goal) &&
        !/\b(?:website|app|application|component|files?|software)\b/i.test(job.task.goal)
      ) &&
      /\b(?:create|build|develop|scaffold|implement|modify|edit|change|patch|fix|refactor|add|remove|delete)\b/i.test(
        changeIntent,
      )
    )
      throw fail(
        'NO_VERIFIED_CHANGES',
        'No executed file changes were recorded for this task.',
        409,
      );
    const passed = job.task.validation.filter((v) => v.status === 'passed').length;
    const directoryCount = job.task.directories?.length || 0;
    // Say plainly why nothing was installed/built, instead of a silent "done".
    const needsPackages = job.task.changes.some((change) =>
      /(?:^|\/)(?:package\.json|requirements\.txt|pyproject\.toml|Cargo\.toml|go\.mod|pom\.xml)$/i.test(
        change.path,
      ),
    );
    const blockedNote =
      !passed && needsPackages && !policy.commands
        ? ' Packages were NOT installed and nothing was built because project commands are off. Switch the access mode to Manual or Automatic and send "install and build" to finish the setup.'
        : '';
    const summary = `${changedCount} recorded file change${changedCount === 1 ? '' : 's'} verified against current contents. ${directoryCount ? `${directoryCount} created director${directoryCount === 1 ? 'y' : 'ies'} verified. ` : ''}${passed ? `${passed} validation command${passed === 1 ? '' : 's'} passed.` : 'No project test or build command has run.'}${blockedNote}`;
    job.execution.finish({
      success: true,
      summary,
    });
    job.task.status = 'done';
    job.task.summary = job.execution.state.verdict.summary;
    if (launchOnly(job.task.goal) && job.task.launches?.length)
      job.task.summary = 'Project app started. Open Run & packages to view or stop it.';
    if (
      !launchOnly(job.task.goal) &&
      job.task.launches?.some(
        (launch) =>
          this.engine.runtime.output(
            { userId: job.userId, workspaceId: job.task.workspaceId },
            launch.jobId,
          ).status === 'running',
      )
    )
      job.task.summary += ' Project app started; check Run controls for its current status.';
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
    this.engine.runtime
      ?.stopTask?.({ userId: job.userId, workspaceId: job.task.workspaceId, taskId: job.task.id })
      ?.catch(() => {});
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
