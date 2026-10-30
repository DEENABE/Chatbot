import React, { useState } from 'react';
import {
  Check,
  Download,
  ExternalLink,
  Loader2,
  Play,
  ShieldCheck,
  Square,
  Terminal,
} from 'lucide-react';

export default function RuntimePanel({
  info,
  error,
  writeAuthorized,
  busy,
  locked,
  selectedPath,
  entries,
  onPolicy,
  onAction,
  onStop,
  onOpen,
}) {
  const [packages, setPackages] = useState('');
  const [manager, setManager] = useState('npm');
  const [port, setPort] = useState('5175');
  const validPort = /^\d+$/.test(port) && Number(port) >= 1024 && Number(port) <= 65535;
  const policy = info?.policy || { commands: false, downloads: false };
  const jobs = info?.jobs || [];
  const hasPackage = entries.some((entry) => (entry.path || entry.relativePath) === 'package.json');
  const hasRequirements = entries.some(
    (entry) => (entry.path || entry.relativePath) === 'requirements.txt',
  );
  const pythonFile = selectedPath && /\.py$/i.test(selectedPath);
  const nodeFile = selectedPath && /\.[cm]?js$/i.test(selectedPath);
  const htmlFile = selectedPath && /\.html?$/i.test(selectedPath);
  const toolchains = info?.toolchains || {};
  const hasEntry = (test) => entries.some((entry) => test(entry.path || entry.relativePath || ''));
  // Compiled-language projects are recognised by their manifest in the project root.
  // Each project type lists the runtimes it needs and the buttons it gets:
  // install (deps.install manager), build, test and run.
  const compiled = [
    {
      id: 'rust',
      needs: ['rust'],
      present: hasEntry((name) => name === 'Cargo.toml'),
      install: 'cargo',
      build: ['cargo', ['build']],
      test: ['cargo', ['test']],
      run: ['cargo', ['run']],
    },
    {
      id: 'go',
      needs: ['go'],
      present: hasEntry((name) => name === 'go.mod'),
      install: 'go',
      build: ['go', ['build', './...']],
      test: ['go', ['test', './...']],
      run: ['go', ['run', '.']],
    },
    {
      id: 'dotnet',
      needs: ['dotnet'],
      present: hasEntry((name) => /^[^/\\]+\.(?:cs|fs|vb)proj$/i.test(name)),
      install: 'dotnet',
      build: ['dotnet', ['build']],
      test: ['dotnet', ['test']],
      run: ['dotnet', ['run']],
    },
    {
      id: 'maven',
      needs: ['maven'],
      present: hasEntry((name) => name === 'pom.xml'),
      install: 'maven',
      build: ['mvn', ['package']],
      test: ['mvn', ['test']],
    },
    {
      id: 'gradle',
      needs: ['gradle'],
      present: hasEntry((name) => /^build\.gradle(?:\.kts)?$/.test(name)),
      install: 'gradle',
      build: ['gradle', ['build']],
      test: ['gradle', ['test']],
      run: ['gradle', ['run']],
    },
    {
      id: 'cmake',
      needs: ['cmake', 'ninja', 'mingw'],
      present: hasEntry((name) => name === 'CMakeLists.txt'),
      install: hasEntry((name) => /^conanfile\.(?:txt|py)$/.test(name))
        ? 'conan'
        : hasEntry((name) => name === 'vcpkg.json')
          ? 'vcpkg'
          : null,
      configure: ['cmake', ['-S', '.', '-B', 'build', '-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release']],
      build: ['cmake', ['--build', 'build']],
      test: ['ctest', ['--test-dir', 'build', '--output-on-failure']],
    },
  ].filter((item) => item.present);
  const toolsReady = (item) => item.needs.every((name) => toolchains[name]?.available);
  const missingTools = Object.entries(toolchains).filter(([, tool]) => !tool.available);
  const packagePlaceholder = {
    pip: 'requests numpy',
    cargo: 'serde@1 rand',
    go: 'github.com/google/uuid',
    dotnet: 'Newtonsoft.Json@13.0.3 (one package)',
    vcpkg: 'fmt zlib',
  };
  const noPackageNames = ['maven', 'gradle', 'conan'].includes(manager);
  return (
    <div className="coding-inspector-scroll coding-runtime-panel">
      <div className="coding-run-heading">
        <span className="coding-avatar">
          <Terminal size={17} />
        </span>
        <div>
          <h3>Run your project</h3>
          <p>Install dependencies, run checks and launch apps.</p>
        </div>
      </div>
      {error && (
        <p role="alert" className="coding-diagnostic">
          {error}
        </p>
      )}
      <div className="coding-runtime-badges">
        <span className={info?.node?.available ? 'available' : ''}>
          Node {info?.node?.version || 'unavailable'}
        </span>
        <span className={info?.python?.available ? 'available' : ''}>
          Python {info?.python?.version?.replace(/^Python\s*/, '') || 'not installed'}
        </span>
        <span className={info?.npm?.available ? 'available' : ''}>
          npm {info?.npm?.available ? 'ready' : 'unavailable'}
        </span>
        {Object.entries(toolchains).map(([name, tool]) => (
          <span key={name} className={tool.available ? 'available' : ''}>
            {tool.label}{' '}
            {tool.available ? tool.version?.replace(/^go version /, '') : 'not installed'}
          </span>
        ))}
      </div>
      <section className="coding-runtime-permissions">
        <label>
          <input
            type="checkbox"
            aria-label="Allow project commands"
            checked={policy.commands}
            disabled={busy || !writeAuthorized}
            onChange={(event) =>
              onPolicy({
                commands: event.target.checked,
                downloads: event.target.checked && policy.downloads,
              })
            }
          />
          <span>
            <strong>Allow project commands</strong>
            <small>
              Run project code with your Windows account access. Each command needs approval.
            </small>
          </span>
        </label>
        <label>
          <input
            type="checkbox"
            aria-label="Allow package downloads"
            checked={policy.downloads}
            disabled={busy || !writeAuthorized || !policy.commands}
            onChange={(event) => onPolicy({ commands: true, downloads: event.target.checked })}
          />
          <span>
            <strong>Allow package downloads</strong>
            <small>
              Once enabled for this project, npm, PyPI, crates.io, Go and NuGet packages install
              without asking each time (install scripts off). Installing Python, Rust, Go or .NET
              still asks first.
            </small>
          </span>
        </label>
        {!writeAuthorized && <p>Enable project changes in settings first.</p>}
      </section>
      {!info?.python?.available && (
        <section className="coding-inspector-card">
          <h4>Python runtime</h4>
          <p>
            Python desktop apps need a local Python installation. Tkinter is included with the
            Windows Python installer.
          </p>
          <button
            className="coding-button"
            disabled={locked || !policy.downloads || !info?.pythonInstallAvailable}
            onClick={() => onAction('runtime.install', { runtime: 'python' })}
          >
            <Download size={13} /> Install Python
          </button>
          {!info?.pythonInstallAvailable && (
            <small>
              Windows Package Manager is unavailable. Install Python, then refresh the app.
            </small>
          )}
        </section>
      )}
      {!!missingTools.length && (
        <section className="coding-inspector-card">
          <h4>Language runtimes and build tools</h4>
          <p>
            Install what your project needs. Each install asks for approval first; Maven and Gradle
            need the JDK installed before them.
          </p>
          {missingTools.map(([name, tool]) => (
            <div key={name} className="flex items-center justify-between gap-2 py-1">
              <span title={tool.note || ''}>{tool.label}</span>
              {tool.installable ? (
                <button
                  className="coding-button"
                  disabled={
                    locked ||
                    !policy.downloads ||
                    (['maven', 'gradle'].includes(name) ? false : !info?.pythonInstallAvailable)
                  }
                  onClick={() => onAction('runtime.install', { runtime: name })}
                >
                  <Download size={13} /> Install
                </button>
              ) : (
                <small>{tool.note}</small>
              )}
            </div>
          ))}
        </section>
      )}
      <section className="coding-runtime-actions">
        <h4>Project actions</h4>
        <div className="flex flex-wrap gap-2">
          {htmlFile && (
            <button
              className="coding-button coding-button-primary"
              disabled={locked || !policy.commands}
              onClick={() => onAction('preview.start', { path: selectedPath })}
            >
              <Play size={13} /> Preview HTML
            </button>
          )}
          {(pythonFile || nodeFile) && (
            <>
              <button
                className="coding-button coding-button-primary"
                disabled={locked || !policy.commands || (pythonFile && !info?.python?.available)}
                onClick={() =>
                  onAction('exec.start', {
                    executable: pythonFile ? 'python' : 'node',
                    args: [selectedPath],
                  })
                }
              >
                <Play size={13} /> Run app
              </button>
              <button
                className="coding-button"
                disabled={locked || !policy.commands || (pythonFile && !info?.python?.available)}
                onClick={() =>
                  onAction('tests.run', {
                    executable: pythonFile ? 'python' : 'node',
                    args: pythonFile
                      ? ['-m', 'py_compile', selectedPath]
                      : ['--check', selectedPath],
                  })
                }
              >
                <Check size={13} /> Check syntax
              </button>
            </>
          )}
          {hasPackage && (
            <>
              <button
                className="coding-button"
                disabled={locked || !policy.downloads || !info?.npm?.available}
                onClick={() => onAction('deps.install', { manager: 'npm' })}
              >
                <Download size={13} /> Install project packages
              </button>
              <button
                className="coding-button"
                disabled={locked || !policy.commands || !info?.npm?.available}
                onClick={() => onAction('tests.run', { executable: 'npm', args: ['run', 'build'] })}
              >
                <ShieldCheck size={13} /> Build
              </button>
              <button
                className="coding-button"
                disabled={locked || !policy.commands || !info?.npm?.available || !validPort}
                onClick={() =>
                  onAction('exec.start', {
                    executable: 'npm',
                    args: [
                      'run',
                      'dev',
                      '--',
                      '--host',
                      '127.0.0.1',
                      '--port',
                      port,
                      '--strictPort',
                    ],
                    port: Number(port),
                  })
                }
              >
                <Play size={13} /> Start localhost
              </button>
              <label className="coding-preview-port">
                Port
                <input
                  aria-label="Localhost port"
                  type="number"
                  min="1024"
                  max="65535"
                  value={port}
                  onChange={(event) => setPort(event.target.value)}
                />
              </label>
            </>
          )}
          {compiled.map((item) => {
            const ready = toolsReady(item);
            const step = (label, icon, [executable, args], tool = 'tests.run', primary = false) => (
              <button
                key={label}
                className={`coding-button${primary ? ' coding-button-primary' : ''}`}
                disabled={locked || !policy.commands || !ready}
                onClick={() => onAction(tool, { executable, args })}
              >
                {icon} {label}
              </button>
            );
            return (
              <React.Fragment key={item.id}>
                {item.install && (
                  <button
                    className="coding-button"
                    disabled={locked || !policy.downloads || !ready}
                    onClick={() => onAction('deps.install', { manager: item.install })}
                  >
                    <Download size={13} /> Install {item.install} packages
                  </button>
                )}
                {item.configure && step('Configure', <ShieldCheck size={13} />, item.configure)}
                {step('Build', <ShieldCheck size={13} />, item.build)}
                {step('Test', <Check size={13} />, item.test)}
                {item.run && step('Run', <Play size={13} />, item.run, 'exec.start', true)}
              </React.Fragment>
            );
          })}
          {hasRequirements && (
            <button
              className="coding-button"
              disabled={locked || !policy.downloads || !info?.python?.available}
              onClick={() => onAction('deps.install', { manager: 'pip' })}
            >
              <Download size={13} /> Install requirements
            </button>
          )}
        </div>
        {!selectedPath && !hasPackage && !compiled.length && (
          <p>Select a Python/JavaScript entry file, or ask the agent to build your app.</p>
        )}
      </section>
      <section className="coding-runtime-install">
        <h4>Add a missing package</h4>
        <div>
          <select
            aria-label="Package manager"
            value={manager}
            onChange={(event) => setManager(event.target.value)}
          >
            <option value="npm">npm</option>
            <option value="pip">pip</option>
            <option value="cargo">cargo (Rust)</option>
            <option value="go">go modules</option>
            <option value="dotnet">dotnet (NuGet)</option>
            <option value="vcpkg">vcpkg (C/C++)</option>
            <option value="maven">Maven (pom.xml)</option>
            <option value="gradle">Gradle (build file)</option>
            <option value="conan">Conan (conanfile)</option>
          </select>
          <input
            aria-label="Packages to install"
            value={packages}
            onChange={(event) => setPackages(event.target.value)}
            disabled={noPackageNames}
            placeholder={
              noPackageNames
                ? 'Edit the build file, then install'
                : packagePlaceholder[manager] || 'lodash@4.17.21'
            }
          />
        </div>
        <button
          className="coding-button"
          disabled={locked || !policy.downloads || (!noPackageNames && !packages.trim())}
          onClick={() =>
            onAction('deps.install', {
              manager,
              ...(noPackageNames ? {} : { packages: packages.trim().split(/\s+/) }),
            })
          }
        >
          <Download size={13} /> Install packages
        </button>
      </section>
      <section className="coding-project-processes">
        <h4>Terminal & apps</h4>
        {!jobs.length && <p>Commands and their actual output will appear here.</p>}
        {[...jobs].reverse().map((job) => (
          <article key={job.jobId} className="coding-process-card">
            <header>
              <span
                className={
                  job.status === 'running' || job.status === 'starting'
                    ? 'running'
                    : job.status === 'failed'
                      ? 'failed'
                      : ''
                }
              >
                {job.status === 'starting' && <Loader2 size={12} className="animate-spin" />}
                {job.status}
                {job.exitCode !== null && ` · exit ${job.exitCode}`}
              </span>
              <div>
                {job.previewUrl && job.status === 'running' && (
                  <button
                    className="coding-icon-button"
                    title="Open localhost preview"
                    aria-label="Open localhost preview"
                    onClick={() => onOpen(job.jobId)}
                  >
                    <ExternalLink size={14} />
                  </button>
                )}
                {['running', 'starting'].includes(job.status) && (
                  <button
                    className="coding-icon-button"
                    aria-label="Stop project process"
                    title="Stop project process"
                    onClick={() => onStop(job.jobId)}
                  >
                    <Square size={13} fill="currentColor" />
                  </button>
                )}
              </div>
            </header>
            <code className="coding-process-command">{job.command}</code>
            {job.previewUrl && <p className="coding-preview-url">{job.previewUrl}</p>}
            {job.stdout && <pre className="coding-output">{job.stdout}</pre>}
            {job.stderr && <pre className="coding-output coding-process-error">{job.stderr}</pre>}
            {job.message && <p className="coding-process-error">{job.message}</p>}
          </article>
        ))}
      </section>
    </div>
  );
}
