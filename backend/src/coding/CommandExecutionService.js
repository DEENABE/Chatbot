import path from 'node:path';
import { fail } from './contracts.js';

/** A process allowlist is not a sandbox. Only code-installed OS confinement adapters may execute project code. */
export class CommandExecutionService {
  constructor({ isolation = null } = {}) {
    this.isolation = isolation;
  }
  async run(params, { root, signal } = {}) {
    signal?.throwIfAborted();
    if (
      !/^[A-Za-z0-9._+-]{1,100}$/.test(params.executable) ||
      /^(?:cmd|powershell|pwsh|wscript|cscript|mshta|rundll32|regsvr32)(?:\.exe)?$/i.test(
        params.executable,
      )
    )
      throw fail(
        'COMMAND_DENIED',
        'Shells, elevation and OS administration are not coding executables.',
        403,
      );
    if (params.args.some((a) => /[\0\r\n]/.test(a)) || /\.(?:cmd|bat)$/i.test(params.executable))
      throw fail('COMMAND_DENIED', 'Unsupported command wrapper or arguments.', 403);
    if (
      /^(?:npm|pnpm|yarn|pip|pip3|uv|cargo|dotnet|go)$/i.test(params.executable) &&
      params.args.some((a) =>
        /^(?:install|add|update|upgrade|restore|download|publish|push|login)$/i.test(a),
      )
    )
      throw fail(
        'DEPENDENCY_INSTALL_BLOCKED',
        'Dependency installation and network operations require a separate explicit workflow.',
        403,
      );
    const cwd = path.resolve(root, params.cwd || '.');
    const relative = path.relative(root, cwd);
    if (
      path.isAbsolute(params.cwd || '') ||
      /^[A-Za-z]:/.test(params.cwd || '') ||
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
      throw fail(
        'WORKSPACE_PATH_DENIED',
        'Command directory must be inside the authorized workspace.',
        403,
      );
    const caps = this.isolation?.capabilities;
    if (
      !caps?.workspaceIsolation ||
      !caps?.networkDenied ||
      !caps?.processTreeCleanup ||
      !caps?.environmentRestricted ||
      typeof this.isolation.run !== 'function'
    )
      throw fail(
        'ISOLATION_UNAVAILABLE',
        'Project commands are blocked: this runtime has no verified OS provider for workspace confinement, network denial, secret-free environments and child-process cleanup. An executable allowlist or approval alone cannot safely run project code.',
        409,
      );
    return this.isolation.run({
      executable: params.executable,
      args: params.args,
      cwd,
      root,
      timeoutMs: Math.min(params.timeoutMs || 120000, 300000),
      maxOutputBytes: 1048576,
      shell: false,
      environment: {},
      signal,
    });
  }
}
