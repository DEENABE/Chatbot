import path from 'node:path';
import { CODING_TOOLS, validateCall, codingRisk, fail, digest } from './contracts.js';
import { CommandExecutionService } from './CommandExecutionService.js';
import { normalizeCodingPaths } from './codingPaths.js';
import { ProjectRuntime } from './ProjectRuntime.js';

/** Scoped ToolEngine-compatible adapter. The fixed manifest is the only dispatch authority. */
export class CodingToolEngine {
  constructor({
    repository,
    commands = new CommandExecutionService(),
    runtime = new ProjectRuntime(),
  }) {
    Object.assign(this, { repository, commands, runtime });
  }
  definitions(policy) {
    if (!policy) return CODING_TOOLS;
    return CODING_TOOLS.filter((tool) => {
      if (tool.name.startsWith('git.')) return false;
      if (['exec.run', 'exec.start', 'tests.run', 'preview.start'].includes(tool.name))
        return policy.commands;
      if (['deps.install', 'runtime.install'].includes(tool.name))
        return policy.commands && policy.downloads;
      return true;
    });
  }
  async execute(request, context) {
    const start = Date.now();
    let definition, risk;
    try {
      definition = validateCall(request);
      request = normalizeCodingPaths(request, context.root);
      risk = codingRisk(definition, request.params);
      const { userId, workspaceId, taskId, files, root, binding, signal } = context;
      context = {
        ...context,
        executionPolicy: this.repository.executionPolicy?.(userId, workspaceId, binding) || {
          commands: false,
          downloads: false,
        },
      };
      signal?.throwIfAborted();
      // Enabling "Allow package downloads" for a project is the once-per-project
      // consent for registry package installs: deps.install then runs without a
      // prompt per call. The runtime still restricts it to named registry
      // packages with install scripts disabled, and every call is audited.
      // Runtime installs (Python via winget) keep their per-action approval.
      if (
        request.tool === 'deps.install' &&
        context.executionPolicy.commands &&
        context.executionPolicy.downloads
      )
        context = { ...context, approved: true };
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
      // A small model can loop on rewriting a file it already wrote (each config
      // write also asks for approval). Identical content is a harmless no-op, not a
      // failure: report success without approval or a second write, so the task keeps
      // going instead of dying on a repeated call.
      if (request.tool === 'fs.write' && request.params.expectedVersion !== 'new') {
        const current = await files.read({ path: request.params.path, signal }).catch(() => null);
        if (
          current &&
          current.version === request.params.expectedVersion &&
          current.content === request.params.content
        ) {
          const result = {
            path: request.params.path,
            version: current.version,
            unchanged: true,
            code: 'FILE_UNCHANGED',
            message: `${request.params.path} already contains exactly this content, nothing was written. Do not write it again: create the next missing file or run the project checks.`,
          };
          this.repository.audit(userId, workspaceId, taskId, {
            stage: 'completed',
            tool: definition.name,
            risk,
            success: true,
            durationMs: Date.now() - start,
            version: current.version,
          });
          return { success: true, data: result };
        }
      }
      // "new" on an existing file used to be asked for approval first and only then fail,
      // so the user approved a write that could never happen. Decide it up front, and
      // hand the model the version it needs to replace the file properly.
      if (request.tool === 'fs.write' && request.params.expectedVersion === 'new') {
        let current = null;
        if (typeof files?.read === 'function')
          try {
            current = await files.read({ path: request.params.path, signal });
          } catch (error) {
            if (!['FILE_NOT_FOUND', 'ENOENT'].includes(error.code)) throw error;
          }
        if (current && current.content === request.params.content) {
          this.repository.audit(userId, workspaceId, taskId, {
            stage: 'completed',
            tool: definition.name,
            risk,
            success: true,
            durationMs: Date.now() - start,
            version: current.version,
          });
          return {
            success: true,
            data: {
              path: request.params.path,
              version: current.version,
              unchanged: true,
              code: 'FILE_UNCHANGED',
              message: `${request.params.path} already contains exactly this content, nothing was written. Do not write it again: create the next missing file or run the project checks.`,
            },
          };
        }
        if (current)
          throw fail(
            'FILE_EXISTS',
            `${request.params.path} already exists (version ${current.version}). Do not write it as new: fs.read it, then fs.write with expectedVersion "${current.version}" (or fs.patch) to change it, or leave it as it is and create the next missing file.`,
            409,
          );
      }
      // Vite looks for index.html in the project root. Small models often put it in src/.
      if (
        request.tool === 'fs.write' &&
        /^\.?\/?src\/index\.html$/i.test(String(request.params.path || '').replace(/\\/g, '/'))
      ) {
        const manifest = await files.read({ path: 'package.json', signal }).catch(() => null);
        if (manifest && /"vite"/.test(manifest.content))
          throw fail(
            'WRONG_LOCATION',
            'Vite needs index.html in the project ROOT, not in src/. Write it to index.html (root) with <script type="module" src="/src/main.jsx"></script>, and keep main.jsx and App.jsx in src/.',
            409,
          );
      }
      if (risk === 'DANGEROUS' && context.approved !== true) {
        let preview = null;
        const localCommand = [
          'exec.run',
          'tests.run',
          'exec.start',
          'preview.start',
          'deps.install',
          'runtime.install',
        ].includes(request.tool);
        if (localCommand)
          preview = await this.runtime.preview(request.tool, request.params, context);
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
          message: localCommand
            ? `${preview.command}\n${preview.message}\nAllow this exact action once.`
            : `Review ${request.tool} in this workspace. Approval permits this exact action once.`,
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
        'fs.write': () => this.writeCreatingParents(files, scoped),
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
        'exec.run': () =>
          this.runtime.run(request.tool, request.params, { ...context, signal: scoped.signal }),
        'tests.run': () =>
          this.runtime.run(request.tool, request.params, { ...context, signal: scoped.signal }),
        'exec.start': () => this.runtime.run(request.tool, request.params, context),
        'preview.start': () => this.runtime.run(request.tool, request.params, context),
        'deps.install': () =>
          this.runtime.run(request.tool, request.params, { ...context, signal: scoped.signal }),
        'runtime.install': () =>
          this.runtime.run(request.tool, request.params, { ...context, signal: scoped.signal }),
        'runtime.inspect': () => this.runtime.inspect(context),
        'exec.output': () => this.runtime.output(context, request.params.jobId),
        'exec.stop': () => this.runtime.stop(context, request.params.jobId),
      };
      const data = await handlers[request.tool]();
      if (!data || typeof data !== 'object' || JSON.stringify(data).length > 2 * 1024 * 1024)
        throw fail(
          'INVALID_TOOL_RESULT',
          'The tool did not return a bounded structured result.',
          500,
        );
      const command = [
        'exec.run',
        'tests.run',
        'deps.install',
        'runtime.install',
        'git.status',
        'git.diff',
      ].includes(request.tool);
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
                  data.message ||
                  data.stderr
                    ?.trim()
                    .split(/\r?\n/)
                    .filter(Boolean)
                    .slice(-3)
                    .join(' ')
                    .slice(0, 1000) ||
                  'The command failed; inspect its actual exit code and output.',
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
  /** New files create their missing parent folders (same write grant as fs.mkdir). */
  async writeCreatingParents(files, params) {
    try {
      return await files.write(params);
    } catch (error) {
      // "new" means create-only; an existing file is not a transient conflict the model can retry.
      if (error.code === 'FILE_CONFLICT' && params.expectedVersion === 'new')
        throw fail(
          'FILE_EXISTS',
          `${params.path} already exists. Do not write it as new: fs.read it, then fs.write with its version (or fs.patch) to change it, or leave it as it is and create the next missing file.`,
          409,
        );
      const parent = path.posix.dirname(String(params.path || '').replace(/\\/g, '/'));
      if (
        error.code !== 'FILE_NOT_FOUND' ||
        params.expectedVersion !== 'new' ||
        !parent ||
        parent === '.'
      )
        throw error;
      const created = await files.mkdir({ path: parent, signal: params.signal });
      const result = await files.write(params);
      return { ...result, createdDirectories: created?.createdDirectories || [] };
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
    return this.execute(saved.request, {
      ...context,
      approved: true,
      executionPreview: saved.preview,
    });
  }
}
