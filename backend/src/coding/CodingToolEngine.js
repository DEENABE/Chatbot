import { CODING_TOOLS, validateCall, codingRisk, fail, digest } from './contracts.js';
import { CommandExecutionService } from './CommandExecutionService.js';

/** Scoped ToolEngine-compatible adapter. The fixed manifest is the only dispatch authority. */
export class CodingToolEngine {
  constructor({ repository, commands = new CommandExecutionService() }) {
    Object.assign(this, { repository, commands });
  }
  definitions() {
    return CODING_TOOLS;
  }
  async execute(request, context) {
    const start = Date.now();
    let definition, risk;
    try {
      definition = validateCall(request);
      risk = codingRisk(definition, request.params);
      const { userId, workspaceId, taskId, files, root, binding, signal } = context;
      signal?.throwIfAborted();
      if (context.currentBinding !== binding)
        throw fail(
          'WORKSPACE_CHANGED',
          'Workspace identity changed; authorize its current root again.',
          409,
        );
      if (risk !== 'READ' && !this.repository.writeAllowed(userId, workspaceId, binding))
        throw fail(
          'WRITE_GRANT_REQUIRED',
          'Authorize coding writes to this workspace before modifying or executing its project.',
          403,
        );
      this.repository.audit(userId, workspaceId, taskId, {
        stage: 'requested',
        tool: definition.name,
        risk,
        parameterDigest: digest(request.params),
      });
      if (risk === 'DANGEROUS' && context.approved !== true) {
        let preview = null;
        if (request.tool === 'fs.patch')
          preview = await files.patch({ ...request.params, preview: true, signal });
        if (request.tool === 'fs.write') {
          let before = '';
          if (request.params.expectedVersion !== 'new') {
            const current = await files.read({ path: request.params.path, signal });
            if (current.version !== request.params.expectedVersion)
              throw fail('FILE_CONFLICT', 'The file changed after inspection.', 409);
            before = current.content;
          }
          preview = { path: request.params.path, before, after: request.params.content };
        }
        if (request.tool === 'fs.delete') {
          const current = await files.read({ path: request.params.path, signal });
          if (current.version !== request.params.expectedVersion)
            throw fail('FILE_CONFLICT', 'The file changed after inspection.', 409);
          preview = { path: request.params.path, before: current.content, after: null };
        }
        if (request.tool === 'checkpoint.restore')
          preview = await files.previewRestore({ ...request.params, signal });
        const pending = {
          request,
          binding,
          preview,
          taskId: taskId || null,
          expiresAt: Date.now() + 10 * 60000,
        };
        const approvalId = this.repository.approval(userId, workspaceId, pending);
        return {
          success: false,
          needsConfirmation: true,
          confirmationId: approvalId,
          approvalId,
          tool: request.tool,
          params: request.params,
          preview,
          message: `Review ${request.tool} in this workspace. Approval permits this exact action once.`,
        };
      }
      const scoped = {
        ...request.params,
        signal: AbortSignal.any([
          ...(signal ? [signal] : []),
          AbortSignal.timeout(definition.timeout),
        ]),
      };
      const handlers = {
        'workspace.open': () => files.inspect(scoped),
        'workspace.inspect': () => files.inspect(scoped),
        'fs.list': () => files.list(scoped),
        'fs.read': () => files.read(scoped),
        'fs.mkdir': () => files.mkdir(scoped),
        'fs.write': () => files.write(scoped),
        'fs.patch': () => files.patch(scoped),
        'fs.delete': () => files.remove(scoped),
        'code.search': () => files.search(scoped),
        'code.symbols': () => files.symbols(scoped),
        'code.diff': () => files.diff(scoped),
        'checkpoint.create': () => files.checkpoint(scoped),
        'checkpoint.restore': () => files.restore(scoped),
        'checkpoint.list': () => files.checkpoints(scoped),
        'git.status': () =>
          this.commands.run(
            {
              executable: 'git',
              args: [
                '--no-pager',
                '-c',
                'core.fsmonitor=false',
                '-c',
                'core.hooksPath=',
                'status',
                '--porcelain=v1',
              ],
            },
            { root, signal: scoped.signal },
          ),
        'git.diff': () =>
          this.commands.run(
            {
              executable: 'git',
              args: [
                '--no-pager',
                '-c',
                'core.fsmonitor=false',
                '-c',
                'core.hooksPath=',
                'diff',
                '--no-ext-diff',
                '--no-textconv',
              ],
            },
            { root, signal: scoped.signal },
          ),
        'exec.run': () => this.commands.run(request.params, { root, signal: scoped.signal }),
        'tests.run': () => this.commands.run(request.params, { root, signal: scoped.signal }),
      };
      const data = await handlers[request.tool]();
      if (!data || typeof data !== 'object' || JSON.stringify(data).length > 2 * 1024 * 1024)
        throw fail(
          'INVALID_TOOL_RESULT',
          'The tool did not return a bounded structured result.',
          500,
        );
      const command = ['exec.run', 'tests.run', 'git.status', 'git.diff'].includes(request.tool);
      const ok = data.success !== false && (!command || data.exitCode === 0);
      this.repository.audit(userId, workspaceId, taskId, {
        stage: 'completed',
        tool: definition.name,
        risk,
        success: ok,
        durationMs: Date.now() - start,
        version: data.version || null,
      });
      return {
        success: ok,
        data,
        ...(ok
          ? {}
          : {
              error: {
                code: data.code || 'COMMAND_FAILED',
                message:
                  data.message || 'The command failed; inspect its actual exit code and output.',
              },
            }),
      };
    } catch (error) {
      this.repository.audit(context.userId, context.workspaceId, context.taskId, {
        stage: 'failed',
        tool: request?.tool || 'invalid',
        code: error.code || 'TOOL_FAILED',
        durationMs: Date.now() - start,
      });
      return {
        success: false,
        error: {
          code: error.code || (error.name === 'AbortError' ? 'CANCELLED' : 'TOOL_FAILED'),
          message: error.status ? error.message : 'The coding operation could not complete safely.',
        },
      };
    }
  }
  async approve(userId, workspaceId, approvalId, approved, context) {
    if (typeof approved !== 'boolean')
      throw fail('INVALID_APPROVAL', 'An explicit approval or rejection is required.');
    const saved = this.repository.takeApproval(userId, workspaceId, approvalId);
    if ((saved.taskId || null) !== (context.taskId || null))
      throw fail('APPROVAL_INVALID', 'Use this approval in the task that requested it.', 409);
    if (!approved)
      return {
        success: false,
        error: {
          code: 'APPROVAL_DENIED',
          message: 'The action was rejected. No pending operation was executed.',
        },
      };
    if (saved.binding !== context.binding || saved.binding !== context.currentBinding)
      throw fail('WORKSPACE_CHANGED', 'The approved workspace changed.', 409);
    return this.execute(saved.request, { ...context, approved: true });
  }
}
