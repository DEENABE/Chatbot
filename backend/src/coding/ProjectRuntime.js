import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify, stripVTControlCharacters } from 'node:util';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { fail } from './contracts.js';
import { codingWorkspacePath } from './codingPaths.js';
import { startProjectProcess } from './WindowsProjectProcess.js';
import { startProjectPreview } from './ProjectPreview.js';
import {
  DOWNLOAD_SCRIPT,
  MANAGED_DOWNLOADS,
  MANAGER_COMMAND,
  MAVEN_SETTINGS,
  ONLINE_COMMANDS,
  PATH_GROUPS,
  TOOLCHAINS,
  TOOLCHAIN_BY_COMMAND,
  TOOLCHAIN_BY_MANAGER,
  candidateSpecs,
  launchCommand,
  managedFiles,
  packageCommand,
  toolchainCommand,
  toolchainEnvironment,
} from './Toolchains.js';
import { PSQL_FILE_DENIED } from './ToolchainCommands.js';

const execute = promisify(execFile);
const exists = async (file) => {
  try {
    return (await fs.stat(file)).isFile();
  } catch (error) {
    // App execution aliases such as winget.exe fail stat with EACCES but launch fine.
    if (error.code === 'EACCES' && /\.exe$/i.test(file)) {
      try {
        await fs.access(file);
        return true;
      } catch {}
    }
    return false;
  }
};
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
};
const vendorNpm = fileURLToPath(new URL('../../vendor/npm/bin/npm-cli.js', import.meta.url));
const npmPackage =
  /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[A-Za-z0-9*^~.>=<| +-]+)?$/;
const pythonPackage =
  /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9,._-]+\])?(?:(?:==|>=|<=|~=|!=|>|<)[A-Za-z0-9.*+_-]+(?:,(?:==|>=|<=|~=|!=|>|<)[A-Za-z0-9.*+_-]+)*)?$/;

export class ProjectRuntime {
  constructor({
    processStart = startProjectProcess,
    storage = path.join(config.appDataPath, 'storage/coding-runtime'),
    overrides = {},
    probe = execute,
  } = {}) {
    Object.assign(this, { processStart, storage, overrides, probe });
    this.jobs = new Map();
    this.discovery = null;
  }
  async discover({ refresh = false } = {}) {
    if (!refresh && this.discovery && Date.now() - this.discovery.at < 30000)
      return this.discovery.value;
    const local = process.env.LOCALAPPDATA || '',
      programs = process.env.ProgramFiles || 'C:\\Program Files';
    const pathEntries = (process.env.PATH || '')
      .split(path.delimiter)
      .filter((entry) => path.isAbsolute(entry));
    const candidates = (name) =>
      pathEntries.map((directory) =>
        path.join(directory, process.platform === 'win32' ? `${name}.exe` : name),
      );
    const pick = async (files, { skipStore = false } = {}) => {
      for (const file of files.filter(Boolean)) {
        if (skipStore && /Microsoft[\\/]WindowsApps/i.test(file)) continue;
        if (await exists(file)) {
          try {
            return await fs.realpath(file);
          } catch {
            return path.resolve(file);
          }
        }
      }
      return null;
    };
    const node = await pick([
      this.overrides.node || process.env.CHANAKYA_NODE_EXE,
      path.join(programs, 'nodejs/node.exe'),
      ...candidates('node'),
      process.execPath,
    ]);
    const pythonCandidates = [this.overrides.python || process.env.CHANAKYA_PYTHON_EXE];
    for (const base of [
      path.join(local, 'Programs/Python'),
      path.join(local, 'Python'),
      programs,
      'C:\\',
    ]) {
      try {
        for (const name of (await fs.readdir(base))
          .filter((name) => /^(?:Python\d|pythoncore-)/i.test(name))
          .sort()
          .reverse())
          pythonCandidates.push(path.join(base, name, 'python.exe'));
      } catch {}
    }
    pythonCandidates.push(...candidates('python3'), ...candidates('python'));
    const python = await pick(pythonCandidates, { skipStore: true });
    const npm = await pick([
      this.overrides.npm,
      vendorNpm,
      node && path.join(path.dirname(node), 'node_modules/npm/bin/npm-cli.js'),
      node && path.join(path.dirname(node), '../lib/node_modules/npm/bin/npm-cli.js'),
      node && path.join(path.dirname(node), '../node_modules/npm/bin/npm-cli.js'),
    ]);
    const winget = await pick([
      this.overrides.winget,
      path.join(local, 'Microsoft/WindowsApps/winget.exe'),
      ...candidates('winget'),
    ]);
    const home = process.env.USERPROFILE || os.homedir();
    const programsX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const specEnv = {
      home,
      programs,
      programsX86,
      local,
      javaHome: process.env.JAVA_HOME,
      vcpkgRoot: process.env.VCPKG_ROOT,
    };
    // Object specs name a folder whose sub-folders each hold the executable.
    const expand = async (specs) => {
      const files = [];
      for (const spec of specs) {
        if (typeof spec === 'string') files.push(spec);
        else
          try {
            for (const name of (await fs.readdir(spec.dir))
              .filter((entry) => entry.startsWith(spec.prefix))
              .sort()
              .reverse())
              files.push(path.join(spec.dir, name, spec.relative));
          } catch {}
      }
      return files;
    };
    const found = {};
    for (const [name, tool] of Object.entries(TOOLCHAINS)) {
      if (tool.install?.type === 'download') continue;
      const bins = {};
      for (const bin of tool.bins) {
        const variable = `CHANAKYA_${bin.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_EXE`;
        const file = await pick([
          this.overrides[bin] || process.env[variable],
          ...(await expand(candidateSpecs(name, bin, specEnv))),
          ...candidates(bin),
        ]);
        if (file) bins[bin] = file;
      }
      found[name] = { bins, primary: bins[tool.bins[0]] || null };
    }
    const version = async (file, args, electron = false) => {
      if (!file) return null;
      try {
        const result = await this.probe(file, args, {
          windowsHide: true,
          timeout: 10000,
          maxBuffer: 4096,
          env: {
            ...this.environment({ root: os.tmpdir() }),
            ...(electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
          },
        });
        return String(result.stdout || result.stderr)
          .trim()
          .slice(0, 120);
      } catch {
        return null;
      }
    };
    const nodeVersion = await version(
      node,
      ['--version'],
      node === process.execPath && Boolean(process.versions.electron),
    );
    const pythonVersion = await version(python, ['-I', '--version']);
    const toolchains = {};
    for (const [name, { bins, primary }] of Object.entries(found)) {
      const text = await version(primary, TOOLCHAINS[name].versionArgs);
      toolchains[name] = { available: !!text, version: text, path: primary, bins };
    }
    // Maven and Gradle are unpacked into app storage by runtime.install and
    // started through the JDK's java.exe.
    for (const [name, spec] of Object.entries(MANAGED_DOWNLOADS)) {
      const homeDirectory = path.join(this.storage, 'tools', spec.directory);
      const [folder, prefix] =
        name === 'maven' ? ['boot', 'plexus-classworlds'] : ['lib', 'gradle-launcher'];
      let jar = null;
      try {
        const entry = (await fs.readdir(path.join(homeDirectory, folder))).find(
          (item) => item.startsWith(prefix) && item.endsWith('.jar'),
        );
        if (entry) jar = path.join(homeDirectory, folder, entry);
      } catch {}
      toolchains[name] = {
        available: Boolean(jar && toolchains.java?.available),
        version: jar ? spec.version : null,
        path: jar ? homeDirectory : null,
        jar,
        bins: {},
      };
    }
    const value = {
      ...toolchains,
      node: { available: !!nodeVersion, version: nodeVersion, path: node },
      npm: { available: !!npm && !!nodeVersion, path: npm },
      python: { available: !!pythonVersion, version: pythonVersion, path: python },
      pythonInstallAvailable: !!winget,
      winget,
    };
    this.discovery = { at: Date.now(), value };
    return value;
  }
  environment({ root, nodeDirectory, pythonDirectory, toolDirectory } = {}) {
    const env = {};
    for (const key of [
      'SystemRoot',
      'WINDIR',
      'TEMP',
      'TMP',
      'LOCALAPPDATA',
      'APPDATA',
      'USERPROFILE',
      'HOMEDRIVE',
      'HOMEPATH',
      'ProgramFiles',
      'ProgramFiles(x86)',
      'ProgramData',
      'LANG',
      'LC_ALL',
    ])
      if (process.env[key]) env[key] = process.env[key];
    const system = process.env.SystemRoot || 'C:\\Windows';
    env.PATH = [
      nodeDirectory,
      pythonDirectory,
      toolDirectory,
      path.join(this.storage, 'bin'),
      path.join(system, 'System32'),
      system,
    ]
      .filter(Boolean)
      .join(path.delimiter);
    env.COMSPEC = path.join(system, 'System32/cmd.exe');
    env.PATHEXT = '.COM;.EXE;.BAT;.CMD';
    env.PYTHONUTF8 = '1';
    env.PYTHONUNBUFFERED = '1';
    if (root) env.PYTHONPATH = path.join(root, '.chanakya-python-packages');
    env.npm_config_audit = 'false';
    env.npm_config_fund = 'false';
    env.npm_config_update_notifier = 'false';
    env.npm_config_userconfig = path.join(this.storage, 'user.npmrc');
    env.npm_config_globalconfig = path.join(this.storage, 'global.npmrc');
    env.npm_config_cache = path.join(this.storage, 'npm-cache');
    env.PIP_CONFIG_FILE = process.platform === 'win32' ? 'NUL' : '/dev/null';
    return env;
  }
  policy(context, download = false) {
    if (!context.executionPolicy?.commands)
      throw fail(
        'EXECUTION_GRANT_REQUIRED',
        'Enable project commands for this workspace before running code.',
        403,
      );
    if (download && !context.executionPolicy?.downloads)
      throw fail(
        'DOWNLOAD_GRANT_REQUIRED',
        'Enable package downloads for this workspace before installing dependencies.',
        403,
      );
  }
  async plan(tool, params, context) {
    const commandName = params.executable?.replace(/\.exe$/i, '').toLowerCase();
    this.policy(
      context,
      ['deps.install', 'runtime.install'].includes(tool) || ONLINE_COMMANDS.has(commandName),
    );
    const runtimes =
      tool === 'preview.start'
        ? { node: { path: process.execPath, available: true }, python: { path: null } }
        : await this.discover();
    const cwdRelative = codingWorkspacePath(params.cwd || '', context.root, {
      allowRoot: true,
      directory: true,
    });
    // Native listing rejects links and verifies this directory against the bound root.
    await context.files.list({ path: cwdRelative, maxEntries: 1 });
    const cwd = path.resolve(context.root, cwdRelative);
    const environment = this.environment({
      root: context.root,
      nodeDirectory: runtimes.node.path && path.dirname(runtimes.node.path),
      pythonDirectory: runtimes.python.path && path.dirname(runtimes.python.path),
    });
    const useNode = runtimes.node.path === process.execPath && Boolean(process.versions.electron);
    const plan = {
      cwd,
      cwdRelative,
      environment,
      executable: null,
      args: [],
      display: null,
      observedFiles: [],
      port: params.port || null,
      nodeShimExecutable: useNode ? runtimes.node.path : null,
    };
    const need = (runtime) => {
      if (!runtimes[runtime]?.available)
        throw fail(
          'RUNTIME_MISSING',
          `${runtime === 'python' ? 'Python' : runtime} is not installed. Use the runtime controls to install or configure it.`,
          409,
        );
    };
    if (tool === 'preview.start') {
      const entry = codingWorkspacePath(params.path, context.root);
      if (!/\.html?$/i.test(entry))
        throw fail('PREVIEW_FILE_REQUIRED', 'Select an HTML file to preview.');
      const file = await context.files.read({ path: entry });
      plan.observedFiles.push({ path: file.path, version: file.version });
      plan.previewEntry = entry;
      plan.display = `Preview ${entry} on localhost${params.port ? `:${params.port}` : ' (free port)'}`;
      plan.executable = runtimes.node.path;
    } else if (tool === 'runtime.install') {
      const toolchain = TOOLCHAINS[params.runtime];
      const install = toolchain?.install;
      if (install?.type === 'download') {
        need('node');
        const spec = MANAGED_DOWNLOADS[params.runtime];
        plan.executable = runtimes.node.path;
        plan.args = [
          '-e',
          DOWNLOAD_SCRIPT,
          spec.url,
          spec.hashUrl,
          spec.algorithm,
          path.join(this.storage, 'tools'),
        ];
        plan.display = `Download and verify ${toolchain.label} ${spec.version} (${new URL(spec.url).host})`;
        plan.note = install.note;
      } else {
        if ((params.runtime !== 'python' && install?.type !== 'winget') || !runtimes.winget)
          throw fail(
            'RUNTIME_INSTALL_UNAVAILABLE',
            toolchain?.manual || 'Runtime installation requires Windows Package Manager (winget).',
          );
        plan.executable = runtimes.winget;
        plan.args = [
          'install',
          '--id',
          install ? install.id : 'Python.Python.3.13',
          '--exact',
          '--source',
          'winget',
          ...(!install || install.userScope ? ['--scope', 'user'] : []),
          '--silent',
          '--accept-package-agreements',
          '--accept-source-agreements',
          '--disable-interactivity',
        ];
        plan.display = install
          ? `Install ${toolchain.label} using winget (${install.id})`
          : 'Install Python 3.13 for the current Windows user using winget';
        plan.note = install?.note;
      }
    } else if (tool === 'deps.install') {
      let packages = params.packages || [];
      if (params.manager === 'npm') {
        need('npm');
        plan.executable = runtimes.node.path;
        if (packages.some((name) => !npmPackage.test(name)))
          throw fail(
            'PACKAGE_SPEC_DENIED',
            'Use npm package names with optional versions; URLs and local paths are not accepted.',
          );
        let file;
        try {
          file = await context.files.read({ path: path.posix.join(cwdRelative, 'package.json') });
        } catch (error) {
          if (!packages.length || !['FILE_NOT_FOUND', 'ENOENT'].includes(error.code)) throw error;
          // `npm install <pkg>` in an empty folder writes a package.json with no scripts,
          // after which `npm run build` / `npm run dev` can never work and the model loops.
          throw fail(
            'PACKAGE_JSON_REQUIRED',
            `There is no ${path.posix.join(cwdRelative, 'package.json')} yet. First fs.write package.json (with expectedVersion "new") containing "type": "module", "scripts" (for Vite: "dev": "vite", "build": "vite build", "preview": "vite preview"), "dependencies" and "devDependencies" (use "latest" when unsure of a version). Then call deps.install npm with no packages.`,
            409,
          );
        }
        if (file) plan.observedFiles.push({ path: file.path, version: file.version });
        else
          plan.observedFiles.push({
            path: path.posix.join(cwdRelative, 'package.json'),
            version: 'new',
          });
        if (!packages.length) {
          const manifest = JSON.parse(file.content);
          for (const [name, version] of Object.entries({
            ...manifest.dependencies,
            ...manifest.devDependencies,
          }))
            if (
              !npmPackage.test(name) ||
              typeof version !== 'string' ||
              /(?:https?:|git[+:]|file:|link:|[\\/])/.test(version)
            )
              throw fail(
                'PACKAGE_SPEC_DENIED',
                'The manifest contains a dependency outside named registry packages.',
              );
        }
        plan.args = [
          runtimes.npm.path,
          'install',
          '--prefix',
          cwd,
          '--global=false',
          '--workspaces=false',
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
          '--registry=https://registry.npmjs.org/',
          ...packages,
        ];
        plan.display = `npm install${packages.length ? ' ' + packages.join(' ') : ' (project dependencies)'} · installation scripts disabled`;
        plan.managedFiles = managedFiles('npm');
      } else if (params.manager === 'pip') {
        need('python');
        plan.executable = runtimes.python.path;
        if (!packages.length) {
          const file = await context.files.read({
            path: path.posix.join(cwdRelative, 'requirements.txt'),
          });
          packages = file.content
            .split(/\r?\n/)
            .map((line) => line.replace(/\s*#.*$/, '').trim())
            .filter(Boolean);
          plan.observedFiles.push({ path: file.path, version: file.version });
        }
        if (
          !packages.length ||
          packages.length > 60 ||
          packages.some((name) => !pythonPackage.test(name))
        )
          throw fail(
            'PACKAGE_SPEC_DENIED',
            'Use named PyPI packages with optional versions. Requirement options, URLs and local paths are not accepted.',
          );
        plan.args = [
          '-m',
          'pip',
          '--isolated',
          'install',
          '--no-input',
          '--disable-pip-version-check',
          '--only-binary=:all:',
          '--index-url',
          'https://pypi.org/simple',
          '--cache-dir',
          path.join(this.storage, 'pip-cache'),
          '--target',
          path.join(context.root, '.chanakya-python-packages'),
          ...packages,
        ];
        plan.display = `pip install ${packages.join(' ')} · project packages only`;
      } else if (TOOLCHAIN_BY_MANAGER[params.manager]) {
        const toolchain = TOOLCHAIN_BY_MANAGER[params.manager];
        const command = MANAGER_COMMAND[params.manager];
        need(toolchain);
        const manifests = {
          cargo: ['Cargo.toml'],
          go: ['go.mod'],
          maven: ['pom.xml'],
          gradle: ['build.gradle.kts', 'build.gradle'],
          conan: ['conanfile.txt', 'conanfile.py'],
          vcpkg: ['vcpkg.json'],
        }[params.manager];
        let projectFile;
        if (!manifests) {
          const listing = await context.files.list({ path: cwdRelative, maxEntries: 500 });
          const projects = (listing.entries || []).filter(
            (entry) => entry.type === 'file' && /\.(?:cs|fs|vb)proj$/i.test(entry.path),
          );
          if (projects.length !== 1)
            throw fail(
              'PACKAGE_SPEC_DENIED',
              'Set cwd to a folder with exactly one .csproj, .fsproj or .vbproj file.',
            );
          projectFile = path.posix.basename(projects[0].path);
        }
        for (const candidate of manifests || [projectFile]) {
          try {
            const file = await context.files.read({
              path: path.posix.join(cwdRelative, candidate),
            });
            plan.observedFiles.push({ path: file.path, version: file.version });
            projectFile = candidate;
            break;
          } catch (error) {
            if (!['FILE_NOT_FOUND', 'ENOENT'].includes(error.code)) throw error;
          }
        }
        if (!plan.observedFiles.length)
          throw fail(
            'PROJECT_FILE_MISSING',
            `Create ${(manifests || [projectFile])[0]} before installing packages.`,
          );
        const { args, display } = packageCommand(params.manager, packages, {
          projectFile,
          settings: path.join(this.storage, 'maven-settings.xml'),
          repository: path.join(this.storage, 'm2-repository'),
          triplet: runtimes.mingw?.available ? 'x64-mingw-static' : undefined,
        });
        const launch = launchCommand(command, args, { runtimes, cwd });
        plan.executable = launch.executable;
        plan.args = launch.args;
        plan.display = display;
        plan.managedFiles = managedFiles(params.manager, projectFile);
        plan.toolchain = toolchain;
        plan.install = true;
      } else
        throw fail(
          'PACKAGE_MANAGER_UNSUPPORTED',
          'Choose npm, pip, cargo, go, dotnet, maven, gradle, conan or vcpkg.',
        );
    } else if (TOOLCHAIN_BY_COMMAND[commandName]) {
      const toolchain = TOOLCHAIN_BY_COMMAND[commandName];
      need(toolchain);
      let argv = toolchainCommand(commandName, params.args, { storage: this.storage });
      if (commandName === 'sqlite3')
        argv = await this.inlineSqlFiles(argv, cwdRelative, context, plan);
      if (commandName === 'psql') await this.checkPsqlScript(argv, cwdRelative, context, plan);
      const launch = launchCommand(commandName, argv, { runtimes, cwd });
      plan.executable = launch.executable;
      plan.args = launch.args;
      plan.display = [commandName, ...params.args].join(' ');
      plan.toolchain = toolchain;
      // Bind approval to the project manifest when there is one.
      const manifest = { cargo: 'Cargo.toml', go: 'go.mod', mvn: 'pom.xml' }[commandName];
      if (manifest) {
        try {
          const file = await context.files.read({ path: path.posix.join(cwdRelative, manifest) });
          plan.observedFiles.push({ path: file.path, version: file.version });
        } catch (error) {
          if (!['FILE_NOT_FOUND', 'ENOENT'].includes(error.code)) throw error;
        }
      }
    } else {
      const executable = params.executable.replace(/\.exe$/i, '').toLowerCase();
      if (!['node', 'python', 'python3', 'npm'].includes(executable))
        throw fail(
          'COMMAND_DENIED',
          'Project execution supports node, python, npm and the installed Rust, Go, .NET, Java, C/C++, SQL and embedded toolchains. Shells and system commands are not accepted.',
          403,
        );
      const runtime = executable === 'python3' ? 'python' : executable;
      need(runtime);
      plan.executable = runtime === 'npm' ? runtimes.node.path : runtimes[runtime].path;
      if (params.args.some((arg) => /[\x00\r\n]/.test(arg)))
        throw fail('COMMAND_DENIED', 'Command arguments cannot contain control characters.');
      if (runtime === 'npm' && !['run', 'test', 'start'].includes(params.args[0]))
        throw fail(
          'COMMAND_DENIED',
          'Use deps.install for packages. npm commands support run, test and start.',
        );
      if (
        runtime === 'python' &&
        params.args[0] === '-m' &&
        ['pip', 'ensurepip', 'venv'].includes(params.args[1])
      )
        throw fail('COMMAND_DENIED', 'Use deps.install to install Python packages.');
      plan.args =
        runtime === 'npm'
          ? [runtimes.npm.path, '--prefix', cwd, '--workspaces=false', ...params.args]
          : [...params.args];
      plan.display = [executable, ...params.args].join(' ');
      // Bind approval to the inspected entry point or npm manifest when present.
      const entry =
        runtime === 'npm'
          ? 'package.json'
          : params.args.find((arg) => !arg.startsWith('-') && /\.(?:[cm]?js|py)$/i.test(arg));
      if (entry) {
        const relative = codingWorkspacePath(path.resolve(cwd, entry), context.root);
        const file = await context.files.read({ path: relative });
        plan.observedFiles.push({ path: file.path, version: file.version });
        if (runtime === 'npm') {
          const manifest = JSON.parse(file.content);
          const script = params.args[0] === 'run' ? params.args[1] : params.args[0];
          if (
            script &&
            (!Object.hasOwn(manifest.scripts || {}, script) ||
              typeof manifest.scripts[script] !== 'string')
          ) {
            let defaultStart = false;
            if (script === 'start') {
              try {
                const server = await context.files.read({
                  path: path.posix.join(cwdRelative, 'server.js'),
                });
                plan.observedFiles.push({ path: server.path, version: server.version });
                defaultStart = true;
              } catch (error) {
                if (!['FILE_NOT_FOUND', 'ENOENT'].includes(error.code)) throw error;
              }
            }
            if (!defaultStart)
              throw fail(
                'NPM_SCRIPT_MISSING',
                `No "${script}" script exists in ${file.path}. Available scripts: ${Object.keys(manifest.scripts || {}).join(', ') || 'none'}. Use preview.start for a plain HTML file; do not invent npm start.`,
                409,
              );
          }
        }
      }
    }
    if (plan.toolchain) {
      const executableDirectory = path.dirname(plan.executable);
      // JAVA_HOME is the JDK folder above bin; every other tool reports its own folder.
      const directory = ['java', 'maven', 'gradle'].includes(plan.toolchain)
        ? path.dirname(executableDirectory)
        : executableDirectory;
      const directories = new Set([executableDirectory]);
      // cmake, ninja, the compiler and Conan must see each other's folders.
      if (PATH_GROUPS.cpp.includes(plan.toolchain))
        for (const member of PATH_GROUPS.cpp)
          for (const file of Object.values(runtimes[member]?.bins || {}))
            directories.add(path.dirname(file));
      environment.PATH = [...directories, environment.PATH].join(path.delimiter);
      Object.assign(
        environment,
        toolchainEnvironment(plan.toolchain, {
          storage: this.storage,
          directory,
          install: plan.install === true,
          port: plan.port,
        }),
      );
    }
    if (useNode && plan.executable === runtimes.node.path) environment.ELECTRON_RUN_AS_NODE = '1';
    if (!plan.executable || !inside(context.root, plan.cwd))
      throw fail('COMMAND_DENIED', 'The command has no supported runtime or project directory.');
    return plan;
  }
  async preview(tool, params, context) {
    const plan = await this.plan(tool, params, context);
    return {
      command: plan.display,
      cwd: plan.cwd,
      observedFiles: plan.observedFiles,
      message:
        tool === 'runtime.install'
          ? plan.note ||
            'Downloads and installs Python for your Windows user and accepts the package/source installation terms.'
          : 'Runs locally with your Windows account access. This is not an OS sandbox.',
      ...(tool === 'runtime.install' ? { installsForCurrentUser: true } : {}),
    };
  }
  /**
   * sqlite3 safe mode blocks .read, so a .sql file argument is read here and
   * passed to sqlite3 as SQL text. The file's version is bound to the approval.
   */
  async inlineSqlFiles(argv, cwdRelative, context, plan) {
    const databaseAt = argv.findIndex((token, index) => index >= 3 && !token.startsWith('-'));
    const out = argv.slice(0, databaseAt + 1);
    for (const token of argv.slice(databaseAt + 1)) {
      if (!/^[\w./\\-]+\.sql$/i.test(token)) {
        out.push(token);
        continue;
      }
      const file = await context.files.read({
        path: codingWorkspacePath(
          path.posix.join(cwdRelative, token.replace(/\\/g, '/')),
          context.root,
        ),
      });
      if (file.content.length > 24000)
        throw fail(
          'COMMAND_DENIED',
          `${token} is too large to run (24,000 characters at most).`,
          403,
        );
      plan.observedFiles.push({ path: file.path, version: file.version });
      out.push(file.content);
    }
    return out;
  }
  /** psql meta-commands can run programs, so scripts containing them are refused. */
  async checkPsqlScript(argv, cwdRelative, context, plan) {
    const at = argv.indexOf('-f');
    if (at < 0) return;
    const file = await context.files.read({
      path: codingWorkspacePath(
        path.posix.join(cwdRelative, argv[at + 1].replace(/\\/g, '/')),
        context.root,
      ),
    });
    if (PSQL_FILE_DENIED.test(file.content))
      throw fail(
        'COMMAND_DENIED',
        'The SQL script uses a psql meta-command that can run programs or write files; remove it.',
        403,
      );
    plan.observedFiles.push({ path: file.path, version: file.version });
  }
  async initialize(plan) {
    await fs.mkdir(path.join(this.storage, 'bin'), { recursive: true });
    await fs.writeFile(path.join(this.storage, 'maven-settings.xml'), MAVEN_SETTINGS);
    await fs.writeFile(path.join(this.storage, 'user.npmrc'), '', { flag: 'a' });
    await fs.writeFile(path.join(this.storage, 'global.npmrc'), '', { flag: 'a' });
    if (plan.nodeShimExecutable) {
      const executable = plan.nodeShimExecutable.replace(/%/g, '%%');
      await fs.writeFile(
        path.join(this.storage, 'bin/node.cmd'),
        `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${executable}" %*\r\n`,
      );
    }
  }
  snapshot(job) {
    return {
      jobId: job.id,
      status: job.status,
      command: job.display,
      stdout: job.stdout,
      stderr: job.stderr,
      exitCode: job.exitCode ?? null,
      durationMs: (job.endedAt || Date.now()) - job.startedAt,
      code: job.code || null,
      message: job.message || null,
      previewUrl: job.previewUrl || (job.port ? `http://127.0.0.1:${job.port}/` : null),
      persistent: job.persistent,
    };
  }
  owned(context, id) {
    const job = this.jobs.get(id);
    if (!job || job.userId !== context.userId || job.workspaceId !== context.workspaceId)
      throw fail(
        'PROCESS_NOT_FOUND',
        'This project process is not owned by the selected workspace.',
        404,
      );
    return job;
  }
  list(context) {
    return [...this.jobs.values()]
      .filter((job) => job.userId === context.userId && job.workspaceId === context.workspaceId)
      .slice(-30)
      .map((job) => this.snapshot(job));
  }
  output(context, id) {
    return this.snapshot(this.owned(context, id));
  }
  async stop(context, id) {
    const job = this.owned(context, id);
    job.controller?.abort();
    job.process?.stop('CANCELLED');
    if (job.launchPromise) await job.launchPromise.catch(() => {});
    if (job.completion) await job.completion;
    return this.snapshot(job);
  }
  async stopWorkspace(context) {
    await Promise.all(
      this.list(context)
        .filter((job) => ['running', 'starting'].includes(job.status))
        .map((job) => this.stop(context, job.jobId)),
    );
  }
  async stopTask(context) {
    await Promise.all(
      [...this.jobs.values()]
        .filter(
          (job) =>
            job.userId === context.userId &&
            job.workspaceId === context.workspaceId &&
            job.taskId === context.taskId &&
            ['running', 'starting'].includes(job.status),
        )
        .map((job) => this.stop(context, job.id)),
    );
  }
  async openPreview(context, id) {
    const job = this.owned(context, id);
    if (job.status !== 'running' || !job.port)
      throw fail('PREVIEW_UNAVAILABLE', 'Start a localhost app before opening its preview.');
    const url = job.previewUrl || `http://127.0.0.1:${job.port}/`;
    if (process.platform !== 'win32')
      throw fail('PREVIEW_UNAVAILABLE', 'Open the localhost URL in your browser.');
    await execute(
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/rundll32.exe'),
      [
        path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/url.dll') +
          ',FileProtocolHandler',
        url,
      ],
      { windowsHide: true, timeout: 10000 },
    );
    return { opened: true, previewUrl: url };
  }
  async inspect(context) {
    const runtimes = await this.discover();
    return {
      mode: 'approved_local',
      policy: context.executionPolicy || { commands: false, downloads: false },
      node: { available: runtimes.node.available, version: runtimes.node.version },
      npm: { available: runtimes.npm.available },
      python: { available: runtimes.python.available, version: runtimes.python.version },
      pythonInstallAvailable: runtimes.pythonInstallAvailable,
      toolchains: Object.fromEntries(
        Object.keys(TOOLCHAINS).map((name) => [
          name,
          {
            label: TOOLCHAINS[name].label,
            available: runtimes[name].available,
            version: runtimes[name].version,
            installable: Boolean(TOOLCHAINS[name].install),
            note: TOOLCHAINS[name].manual || TOOLCHAINS[name].install?.note || null,
          },
        ]),
      ),
      jobs: this.list(context).map((job) => ({
        ...job,
        stdout: job.stdout.slice(-8000),
        stderr: job.stderr.slice(-8000),
      })),
    };
  }
  async run(tool, params, context) {
    if (!context.approved)
      throw fail(
        'COMMAND_APPROVAL_REQUIRED',
        'Review this exact project command before running it.',
        403,
      );
    const plan = await this.plan(tool, params, context);
    for (const receipt of context.executionPreview?.observedFiles || []) {
      let version = 'new';
      try {
        version = (await context.files.read({ path: receipt.path })).version;
      } catch (error) {
        if (!['FILE_NOT_FOUND', 'ENOENT'].includes(error.code)) throw error;
      }
      if (version !== receipt.version)
        throw fail(
          'FILE_CONFLICT',
          'A command entry point changed after approval. Review the command again.',
          409,
        );
    }
    const persistent = tool === 'exec.start' || tool === 'preview.start';
    if (
      persistent &&
      this.list(context).filter((job) => ['running', 'starting'].includes(job.status)).length >= 2
    )
      throw fail('PROCESS_LIMIT', 'Stop an existing project app before starting another.');
    if (
      persistent &&
      [...this.jobs.values()].filter((job) => ['running', 'starting'].includes(job.status))
        .length >= 8
    )
      throw fail('PROCESS_LIMIT', 'Stop an existing project app before starting another.');
    if (tool === 'preview.start') return this.startPreview(plan, context);
    if (plan.port)
      await new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', () =>
          reject(
            fail(
              'PREVIEW_PORT_BUSY',
              'That localhost port is already in use. Choose another port.',
            ),
          ),
        );
        server.listen({ host: '127.0.0.1', port: plan.port, exclusive: true }, () =>
          server.close(resolve),
        );
      });
    await this.initialize(plan);
    const managed =
      tool === 'deps.install' && plan.managedFiles?.length
        ? await context.files.prepareManagedChanges(
            plan.managedFiles.map((name) => path.posix.join(plan.cwdRelative, name)),
          )
        : [];
    const job = {
      id: randomUUID(),
      userId: context.userId,
      workspaceId: context.workspaceId,
      taskId: context.taskId,
      display: plan.display,
      stdout: '',
      stderr: '',
      rawOutput: { stdout: '', stderr: '' },
      startedAt: Date.now(),
      status: 'starting',
      persistent,
      port: plan.port,
      controller: new AbortController(),
    };
    this.jobs.set(job.id, job);
    for (const old of [...this.jobs.values()].slice(0, Math.max(0, this.jobs.size - 100)))
      if (!['running', 'starting'].includes(old.status)) this.jobs.delete(old.id);
    const onOutput = (channel, text) => {
      job.rawOutput[channel] += text;
      job[channel] = stripVTControlCharacters(job.rawOutput[channel]);
    };
    let process;
    try {
      job.launchPromise = this.processStart(plan, {
        signal: context.signal
          ? AbortSignal.any([context.signal, job.controller.signal])
          : job.controller.signal,
        onOutput,
        timeoutMs: persistent
          ? null
          : params.timeoutMs || (tool === 'runtime.install' ? 600000 : 300000),
      });
      process = await job.launchPromise;
    } catch (error) {
      job.status =
        error.code === 'CANCELLED' || job.controller.signal.aborted ? 'stopped' : 'failed';
      job.code = error.code;
      job.message = error.message;
      job.endedAt = Date.now();
      throw error;
    }
    job.process = process;
    job.status = 'running';
    job.completion = process.completion.then(async (result) => {
      job.exitCode = result.exitCode;
      job.code = result.code;
      job.message = result.error;
      job.status = result.cancelled
        ? 'stopped'
        : result.code || result.exitCode !== 0
          ? 'failed'
          : 'exited';
      job.endedAt = Date.now();
      if (
        result.exitCode === 0 &&
        params.args?.includes('unittest') &&
        /Ran\s+0\s+tests?\b/.test(job.stdout + job.stderr)
      ) {
        job.status = 'failed';
        job.code = 'NO_TESTS_DISCOVERED';
        job.message =
          'unittest found no tests. Use discover -s with the actual test directory, then rerun.';
      }
      if (tool === 'runtime.install') this.discovery = null;
      // npm ETARGET: the model invented a version that does not exist. Tell it exactly how to recover.
      if (tool === 'deps.install' && job.status === 'failed') {
        const missing = [
          ...new Set(
            [
              ...(job.stdout + '\n' + job.stderr).matchAll(
                /No matching version found for ((?:@[\w.-]+\/)?[\w.-]+)@/g,
              ),
            ].map((match) => match[1]),
          ),
        ].slice(0, 10);
        if (missing.length) {
          job.code = 'PACKAGE_VERSION_NOT_FOUND';
          job.message = `npm found no such version for ${missing.join(', ')}. Fix package.json: set ${missing
            .map((name) => `"${name}": "latest"`)
            .join(
              ', ',
            )} (or remove the package if it is not needed), then run deps.install npm again with no packages.`;
        }
      }
      if (managed.length) job.changes = await context.files.finishManagedChanges(managed);
      if (
        tool === 'runtime.install' &&
        result.exitCode === 0 &&
        !(await this.discover({ refresh: true }))[params.runtime]?.available
      ) {
        const label = TOOLCHAINS[params.runtime]?.label || 'Python';
        const refreshed = await this.discover();
        const missing = (TOOLCHAINS[params.runtime]?.requires || []).filter(
          (name) => !refreshed[name]?.available,
        );
        job.code = 'RUNTIME_INSTALL_UNVERIFIED';
        job.message = missing.length
          ? `${label} was installed but needs ${missing.map((name) => TOOLCHAINS[name].label).join(' and ')} first. Install that, then refresh.`
          : `The installer returned, but ${label} is not available yet. Refresh runtimes and review the installation output.`;
        job.status = 'failed';
      }
      return this.snapshot(job);
    });
    if (persistent) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { ...this.snapshot(job), success: job.status === 'running' || job.exitCode === 0 };
    }
    const result = await job.completion;
    return {
      ...result,
      changes: job.changes || [],
      success: result.exitCode === 0 && !result.code,
    };
  }
  async startPreview(plan, context) {
    const job = {
      id: randomUUID(),
      userId: context.userId,
      workspaceId: context.workspaceId,
      taskId: context.taskId,
      display: plan.display,
      startedAt: Date.now(),
      status: 'starting',
      persistent: true,
      stdout: '',
      stderr: '',
      controller: new AbortController(),
    };
    this.jobs.set(job.id, job);
    for (const old of [...this.jobs.values()].slice(0, Math.max(0, this.jobs.size - 100)))
      if (!['running', 'starting'].includes(old.status)) this.jobs.delete(old.id);
    const signal = context.signal
      ? AbortSignal.any([context.signal, job.controller.signal])
      : job.controller.signal;
    try {
      job.launchPromise = startProjectPreview(
        {
          root: context.root,
          files: context.files,
          entryPath: plan.previewEntry,
          port: plan.port || 0,
        },
        { signal },
      );
      job.process = await job.launchPromise;
      job.port = job.process.port;
      job.previewUrl = job.process.previewUrl;
      job.stdout = `HTML preview ready: ${job.previewUrl}\nNo package installation required.\n`;
      job.status = 'running';
      job.completion = job.process.completion.then((result) => {
        job.status = result.cancelled ? 'stopped' : 'failed';
        job.exitCode = result.exitCode;
        job.code = result.code;
        job.message = result.error;
        job.endedAt = Date.now();
        return this.snapshot(job);
      });
      const response = await fetch(job.previewUrl, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
      });
      if (!response.ok)
        throw fail('PREVIEW_HTTP_FAILED', 'The HTML preview could not read its entry file.', 409);
      await response.arrayBuffer();
      return { ...this.snapshot(job), success: true, path: plan.previewEntry };
    } catch (error) {
      job.process?.stop();
      if (job.completion) await job.completion;
      job.status = signal.aborted ? 'stopped' : 'failed';
      job.code = error.code;
      job.message = error.message;
      job.endedAt = Date.now();
      throw error;
    }
  }
}
