import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectRuntime } from './ProjectRuntime.js';
import {
  managedFiles,
  packageCommand,
  toolchainCommand,
  toolchainEnvironment,
} from './Toolchains.js';

const denied = (code = 'COMMAND_DENIED') => ({ code });

test('cargo accepts build-type subcommands and rejects everything that can leave the project', () => {
  assert.deepEqual(toolchainCommand('cargo', ['build', '--release']), ['build', '--release']);
  assert.deepEqual(toolchainCommand('cargo', ['run', '--', '--name', '../ok']), [
    'run',
    '--',
    '--name',
    '../ok',
  ]);
  for (const args of [
    ['install', 'ripgrep'],
    ['add', 'serde'],
    ['publish'],
    ['+nightly', 'build'],
    ['build', '--manifest-path', 'C:/other/Cargo.toml'],
    ['build', '--manifest-path=../x/Cargo.toml'],
    ['build', '--target-dir', '../elsewhere'],
    ['build', '--config', 'build.rustc-wrapper="calc"'],
    ['build', '-Zunstable-options'],
    ['build', '--registry', 'evil'],
    ['build', '@args.rsp'],
    ['build', 'a\nb'],
  ])
    assert.throws(() => toolchainCommand('cargo', args), denied(), args.join(' '));
});

test('go accepts build, run, test and vet but never helper programs or other module files', () => {
  assert.deepEqual(toolchainCommand('go', ['test', './...']), ['test', './...']);
  assert.deepEqual(toolchainCommand('go', ['build', '-o', 'bin/app.exe', '.']), [
    'build',
    '-o',
    'bin/app.exe',
    '.',
  ]);
  for (const args of [
    ['get', 'github.com/x/y'],
    ['install', 'example.com/tool@latest'],
    ['mod', 'tidy'],
    ['env', '-w', 'GOFLAGS=-x'],
    ['build', '-toolexec', 'calc'],
    ['test', '-exec', 'calc'],
    ['vet', '-vettool=evil.exe'],
    ['build', '-ldflags', '-extld=calc'],
    ['build', '-modfile', '../go.mod'],
    ['build', '-o', '../out.exe'],
    ['build', '-o', 'C:\\out.exe'],
    ['run', '-overlay=x.json', '.'],
  ])
    assert.throws(() => toolchainCommand('go', args), denied(), args.join(' '));
});

test('dotnet builds offline, never opens a launch profile, and cannot change targets or sources', () => {
  assert.deepEqual(toolchainCommand('dotnet', ['build', '-c', 'Release']), [
    'build',
    '-c',
    'Release',
    '--no-restore',
  ]);
  assert.deepEqual(toolchainCommand('dotnet', ['run', '--', '--port', '5000']), [
    'run',
    '--no-restore',
    '--no-launch-profile',
    '--',
    '--port',
    '5000',
  ]);
  assert.deepEqual(toolchainCommand('dotnet', ['clean']), ['clean']);
  for (const args of [
    ['add', 'package', 'Newtonsoft.Json'],
    ['restore'],
    ['new', 'console'],
    ['tool', 'install', 'x'],
    ['build', '-p:BeforeBuild=calc'],
    ['build', '/p:Foo=1'],
    ['build', '--property', 'A=b'],
    ['build', '-t:Evil'],
    ['build', '--source', 'https://evil.example/feed'],
    ['build', '--interactive'],
    ['test', '--logger', 'html'],
    ['test', '--test-adapter-path', 'C:\\adapters'],
    ['build', '-o', '..\\out'],
    ['build', '@build.rsp'],
  ])
    assert.throws(() => toolchainCommand('dotnet', args), denied(), args.join(' '));
});

test('package commands accept only named registry packages', () => {
  assert.deepEqual(packageCommand('cargo', ['serde@1', 'rand'], {}).args, [
    'add',
    '--registry',
    'crates-io',
    'serde@1',
    'rand',
  ]);
  assert.deepEqual(packageCommand('cargo', [], {}).args, ['fetch']);
  assert.deepEqual(packageCommand('go', ['github.com/gin-gonic/gin@v1.10.0'], {}).args, [
    'get',
    'github.com/gin-gonic/gin@v1.10.0',
  ]);
  assert.deepEqual(packageCommand('go', [], {}).args, ['mod', 'download']);
  const nuget = packageCommand('dotnet', ['Newtonsoft.Json@13.0.3'], { projectFile: 'App.csproj' });
  assert.deepEqual(nuget.args.slice(0, 6), [
    'add',
    'App.csproj',
    'package',
    'Newtonsoft.Json',
    '--version',
    '13.0.3',
  ]);
  assert.ok(nuget.args.includes('https://api.nuget.org/v3/index.json'));
  assert.deepEqual(packageCommand('dotnet', [], { projectFile: 'App.csproj' }).args.slice(0, 2), [
    'restore',
    'App.csproj',
  ]);

  const bad = {
    cargo: ['serde --git https://x', 'https://x/y', '../crate', 'serde@file:..', '--offline'],
    go: ['https://github.com/a/b', 'github.com/a/../b', 'github.com/a/b@master', '-u', 'localpkg'],
    dotnet: ['Pkg --source evil', 'C:\\pkg.nupkg', 'A@bad'],
  };
  for (const [manager, names] of Object.entries(bad))
    for (const name of names)
      assert.throws(
        () => packageCommand(manager, [name], { projectFile: 'App.csproj' }),
        denied('PACKAGE_SPEC_DENIED'),
        `${manager} ${name}`,
      );
  assert.throws(
    () => packageCommand('dotnet', ['A', 'B'], { projectFile: 'App.csproj' }),
    denied('PACKAGE_SPEC_DENIED'),
  );
});

test('each toolchain keeps its caches in app storage and only installs may reach a registry', () => {
  const storage = path.join(os.tmpdir(), 'chanakya-storage');
  const rustRun = toolchainEnvironment('rust', { storage });
  assert.equal(rustRun.CARGO_NET_OFFLINE, 'true');
  assert.ok(rustRun.CARGO_HOME.startsWith(storage));
  assert.equal(toolchainEnvironment('rust', { storage, install: true }).CARGO_NET_OFFLINE, 'false');

  const goRun = toolchainEnvironment('go', { storage });
  assert.equal(goRun.GOPROXY, 'off');
  assert.equal(goRun.GOTOOLCHAIN, 'local');
  assert.equal(goRun.GOENV, 'off');
  assert.equal(goRun.GOVCS, '*:off');
  assert.equal(
    toolchainEnvironment('go', { storage, install: true }).GOPROXY,
    'https://proxy.golang.org',
  );

  const dotnet = toolchainEnvironment('dotnet', { storage, directory: 'C:\\dotnet', port: 5099 });
  assert.equal(dotnet.DOTNET_CLI_TELEMETRY_OPTOUT, '1');
  assert.equal(dotnet.MSBUILDDISABLENODEREUSE, '1');
  assert.equal(dotnet.ASPNETCORE_URLS, 'http://127.0.0.1:5099');
  assert.ok(dotnet.NUGET_PACKAGES.startsWith(storage));

  assert.deepEqual(managedFiles('cargo'), ['Cargo.toml', 'Cargo.lock']);
  assert.deepEqual(managedFiles('go'), ['go.mod', 'go.sum']);
  assert.deepEqual(managedFiles('dotnet', 'App.csproj'), ['App.csproj']);
});

test('runtime plans route Rust, Go and .NET commands to the detected tools', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chanakya-toolchain-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const tool = (name) => {
    const file = `C:\\tools\\${name}\\${name}.exe`;
    return { available: true, version: name, path: file, bins: { [name]: file } };
  };
  const runtime = new ProjectRuntime({ storage: path.join(root, 'storage') });
  runtime.discover = async () => ({
    node: { available: false, path: null },
    npm: { available: false, path: null },
    python: { available: false, path: null },
    rust: tool('cargo'),
    go: tool('go'),
    dotnet: tool('dotnet'),
    winget: 'C:\\winget.exe',
  });
  const hash = 'a'.repeat(64);
  const files = {
    list: async () => ({ entries: [{ path: 'App.csproj', type: 'file' }] }),
    read: async ({ path: name }) => ({ path: name, version: hash, content: '' }),
  };
  const context = {
    root,
    userId: 'owner',
    workspaceId: 'project',
    files,
    executionPolicy: { commands: true, downloads: true },
  };

  const cargo = await runtime.plan('exec.run', { executable: 'cargo', args: ['build'] }, context);
  assert.equal(cargo.executable, 'C:\\tools\\cargo\\cargo.exe');
  assert.deepEqual(cargo.args, ['build']);
  assert.equal(cargo.environment.CARGO_NET_OFFLINE, 'true');
  assert.ok(cargo.environment.PATH.startsWith('C:\\tools\\cargo'));
  assert.deepEqual(cargo.observedFiles, [{ path: 'Cargo.toml', version: hash }]);

  const dotnetRun = await runtime.plan(
    'exec.start',
    { executable: 'dotnet.exe', args: ['run'], port: 5099 },
    context,
  );
  assert.deepEqual(dotnetRun.args, ['run', '--no-restore', '--no-launch-profile']);
  assert.equal(dotnetRun.environment.ASPNETCORE_URLS, 'http://127.0.0.1:5099');

  const install = await runtime.plan(
    'deps.install',
    { manager: 'go', packages: ['github.com/google/uuid@v1.6.0'] },
    context,
  );
  assert.deepEqual(install.args, ['get', 'github.com/google/uuid@v1.6.0']);
  assert.equal(install.environment.GOPROXY, 'https://proxy.golang.org');
  assert.deepEqual(install.managedFiles, ['go.mod', 'go.sum']);

  const nuget = await runtime.plan(
    'deps.install',
    { manager: 'dotnet', packages: ['Serilog@4.0.0'] },
    context,
  );
  assert.equal(nuget.args[1], 'App.csproj');
  assert.deepEqual(nuget.managedFiles, ['App.csproj']);

  const winget = await runtime.plan('runtime.install', { runtime: 'go' }, context);
  assert.ok(winget.args.includes('GoLang.Go'));
  assert.ok(!winget.args.includes('--scope'));
  assert.match(winget.note, /never elevates/);
  const rust = await runtime.plan('runtime.install', { runtime: 'rust' }, context);
  assert.ok(rust.args.includes('Rustlang.Rustup') && rust.args.includes('user'));

  await assert.rejects(
    runtime.plan('exec.run', { executable: 'cargo', args: ['install', 'x'] }, context),
    denied(),
  );
  await assert.rejects(
    runtime.plan(
      'exec.run',
      { executable: 'go', args: ['build'] },
      { ...context, executionPolicy: { commands: false, downloads: false } },
    ),
    denied('EXECUTION_GRANT_REQUIRED'),
  );
  runtime.discover = async () => ({
    node: { available: false, path: null },
    npm: { available: false, path: null },
    python: { available: false, path: null },
    rust: { available: false, path: null },
    go: { available: false, path: null },
    dotnet: { available: false, path: null },
  });
  await assert.rejects(
    runtime.plan('exec.run', { executable: 'go', args: ['build'] }, context),
    denied('RUNTIME_MISSING'),
  );
});
