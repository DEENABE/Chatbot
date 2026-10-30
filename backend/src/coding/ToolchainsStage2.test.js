import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectRuntime } from './ProjectRuntime.js';
import {
  DOWNLOAD_SCRIPT,
  MANAGED_DOWNLOADS,
  TOOLCHAINS,
  TOOLCHAIN_BY_COMMAND,
  candidateSpecs,
  packageCommand,
  toolchainCommand,
  toolchainEnvironment,
} from './Toolchains.js';

const storage = path.join(os.tmpdir(), 'chanakya-stage2');
const denied = { code: 'COMMAND_DENIED' };
const run = (command, args) => toolchainCommand(command, args, { storage });

test('every tool command is registered once and maps back to its toolchain', () => {
  for (const [name, tool] of Object.entries(TOOLCHAINS))
    for (const bin of tool.bins) assert.equal(TOOLCHAIN_BY_COMMAND[bin], name);
  assert.equal(TOOLCHAIN_BY_COMMAND.mvn, 'maven');
  assert.equal(TOOLCHAIN_BY_COMMAND['arm-none-eabi-gcc'], 'arm');
  assert.equal(TOOLCHAINS.vcpkg.install, null);
  assert.equal(TOOLCHAINS.postgres.install, null);
});

test('javac and java refuse plugins, agents, JVM options and outside paths', () => {
  assert.deepEqual(run('javac', ['-d', 'out', 'src/Main.java']), ['-d', 'out', 'src/Main.java']);
  assert.deepEqual(run('java', ['-cp', 'out', 'Main']), ['-cp', 'out', 'Main']);
  for (const args of [
    ['-processorpath', 'x', 'A.java'],
    ['-Xplugin:Evil', 'A.java'],
    ['-J-Xmx1g', 'A.java'],
    ['-d', '..\\out', 'A.java'],
    ['@sources.txt'],
  ])
    assert.throws(() => run('javac', args), denied, args.join(' '));
  for (const args of [
    ['-javaagent:evil.jar', 'Main'],
    ['-agentlib:jdwp=transport=dt_socket', 'Main'],
    ['-XX:OnError=calc', 'Main'],
    ['-Xbootclasspath/a:x.jar', 'Main'],
    ['-cp', 'C:\\libs\\x.jar', 'Main'],
  ])
    assert.throws(() => run('java', args), denied, args.join(' '));
});

test('mvn runs lifecycle phases in batch mode against app-owned settings and repository', () => {
  const args = run('mvn', [
    'clean',
    'test',
    '-q',
    '-DskipTests=false',
    '-pl',
    'app',
    '-Dtest=FooTest',
  ]);
  assert.equal(args[0], '-B');
  assert.ok(args.includes(path.join(storage, 'maven-settings.xml')));
  assert.ok(args.includes(`-Dmaven.repo.local=${path.join(storage, 'm2-repository')}`));
  assert.deepEqual(args.slice(-2), ['clean', 'test']);
  for (const bad of [
    ['exec:java'],
    ['antrun:run'],
    ['install'],
    ['deploy'],
    ['test', '-s', 'evil.xml'],
    ['test', '--settings', 'evil.xml'],
    ['test', '-Dmaven.repo.local=C:\\x'],
    ['test', '-f', '..\\pom.xml'],
    ['test', '-pl', '..\\x'],
    ['-q'],
  ])
    assert.throws(() => run('mvn', bad), denied, bad.join(' '));
});

test('gradle runs without a daemon and refuses init scripts, properties and publishing', () => {
  assert.deepEqual(run('gradle', ['build', '-x', 'test']), [
    '--no-daemon',
    '--console=plain',
    'build',
    '-x',
    'test',
  ]);
  for (const bad of [
    ['-I', 'init.gradle', 'build'],
    ['build', '-Dorg.gradle.jvmargs=-javaagent:x.jar'],
    ['build', '-Pfoo=bar'],
    ['build', '--project-dir', '..'],
    ['publish'],
    ['wrapper'],
    ['build', '--gradle-user-home', 'C:\\x'],
    [],
  ])
    assert.throws(() => run('gradle', bad), denied, bad.join(' '));
});

test('cmake, ctest and ninja stay inside the project and refuse script and launcher options', () => {
  assert.deepEqual(
    run('cmake', ['-S', '.', '-B', 'build', '-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release']),
    ['-S', '.', '-B', 'build', '-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release'],
  );
  assert.deepEqual(run('cmake', ['--build', 'build', '--config', 'Release', '--', '-j4']), [
    '--build',
    'build',
    '--config',
    'Release',
    '--',
    '-j4',
  ]);
  for (const bad of [
    ['-E', 'env', 'calc'],
    ['-P', 'script.cmake'],
    ['--install', 'build'],
    ['-S', '..', '-B', 'build'],
    ['-B', 'C:\\build'],
    ['-DCMAKE_C_COMPILER_LAUNCHER=calc'],
    ['-DCMAKE_CROSSCOMPILING_EMULATOR=calc'],
    ['-DCMAKE_PROJECT_INCLUDE=x.cmake'],
    ['--build', 'build', '--', '-f', 'evil'],
  ])
    assert.throws(() => run('cmake', bad), denied, bad.join(' '));
  assert.deepEqual(run('ctest', ['--test-dir', 'build', '--output-on-failure']), [
    '--test-dir',
    'build',
    '--output-on-failure',
  ]);
  assert.throws(() => run('ctest', ['-D', 'Experimental']), denied);
  assert.throws(() => run('ctest', ['--test-dir', '..\\build']), denied);
  assert.deepEqual(run('ninja', ['-C', 'build', '-j', '4']), ['-C', 'build', '-j', '4']);
  assert.throws(() => run('ninja', ['-t', 'commands']), denied);
  assert.throws(() => run('ninja', ['-C', 'C:\\build']), denied);
});

test('gcc, g++ and the Arm compiler refuse plugins, wrappers and specs files but may read system headers', () => {
  assert.deepEqual(run('gcc', ['-O2', '-I', 'C:\\SDK\\include', '-o', 'app.exe', 'main.c']), [
    '-O2',
    '-I',
    'C:\\SDK\\include',
    '-o',
    'app.exe',
    'main.c',
  ]);
  assert.deepEqual(
    run('arm-none-eabi-gcc', ['-mcpu=cortex-m4', '-specs=nano.specs', '-Tlink.ld', 'main.c'])
      .length,
    4,
  );
  for (const bad of [
    ['-wrapper', 'calc', 'main.c'],
    ['-fplugin=evil.dll', 'main.c'],
    ['-Bc:\\evil', 'main.c'],
    ['-specs=evil.specs', 'main.c'],
    ['-Wl,-plugin,evil.dll', 'main.c'],
    ['-o', '..\\main.exe', 'main.c'],
    ['-o', 'C:\\main.exe', 'main.c'],
    ['@opts.txt'],
  ])
    assert.throws(() => run('gcc', bad), denied, bad.join(' '));
  assert.throws(() => run('arm-none-eabi-gcc', ['-specs=picolibc_evil.specs', 'a.c']), denied);
  assert.deepEqual(run('mingw32-make', ['-C', 'build', '-j', '4', 'all']), [
    '-C',
    'build',
    '-j',
    '4',
    'all',
  ]);
  assert.throws(() => run('mingw32-make', ['-f', '..\\Makefile']), denied);
  assert.throws(() => run('mingw32-make', ['--eval=$(shell calc)']), denied);
});

test('conan builds and inspects but cannot add remotes or install packages', () => {
  assert.deepEqual(run('conan', ['profile', 'detect']), ['profile', 'detect']);
  assert.deepEqual(run('conan', ['build', '.']), ['build', '.']);
  for (const bad of [
    ['install', '.'],
    ['remote', 'add', 'x', 'https://evil'],
    ['upload', '*'],
    ['build', '.', '-r', 'evil'],
    ['profile', 'update', 'x'],
    ['create', '.'],
  ])
    assert.throws(() => run('conan', bad), denied, bad.join(' '));
});

test('sqlite3 always runs batch, bail and safe, on a project database', () => {
  assert.deepEqual(run('sqlite3', ['app.db', 'select 1;']), [
    '-batch',
    '-bail',
    '-safe',
    'app.db',
    'select 1;',
  ]);
  assert.deepEqual(run('sqlite3', ['-header', '-csv', ':memory:', 'select 1;']).slice(0, 5), [
    '-batch',
    '-bail',
    '-safe',
    '-header',
    '-csv',
  ]);
  for (const bad of [
    ['-unsafe-testing', 'app.db'],
    ['-cmd', '.shell calc', 'app.db'],
    ['-init', 'x.sql', 'app.db'],
    ['..\\other.db', 'select 1'],
    ['C:\\other.db', 'select 1'],
    ['file:///c:/x.db', 'select 1'],
    ['app.db', '.shell calc'],
    ['app.db', '.read evil.sql'],
    ['app.db', '.system calc'],
    [],
  ])
    assert.throws(() => run('sqlite3', bad), denied, bad.join(' '));
  assert.ok(run('sqlite3', ['app.db', '.tables']).includes('.tables'));
});

test('psql connects to this computer only and never runs meta-commands', () => {
  const args = run('psql', ['-U', 'dev', '-d', 'appdb', '-c', 'select now();']);
  assert.deepEqual(args.slice(0, 4), ['-X', '-w', '-v', 'ON_ERROR_STOP=1']);
  assert.ok(args.includes('127.0.0.1'));
  assert.ok(run('psql', ['-h', 'localhost', '-f', 'schema.sql']).includes('schema.sql'));
  for (const bad of [
    ['-h', 'db.example.com', '-c', 'select 1'],
    ['-d', 'postgresql://evil/db', '-c', 'select 1'],
    ['-d', 'host=evil dbname=x', '-c', 'select 1'],
    ['-c', '\\! calc'],
    ['-c', 'select 1 \\o | calc'],
    ['-f', '..\\evil.sql'],
    ['-W', '-c', 'select 1'],
    ['-L', 'C:\\log.txt', '-c', 'select 1'],
    [],
  ])
    assert.throws(() => run('psql', bad), denied, bad.join(' '));
});

test('package commands cover Maven, Gradle, Conan and vcpkg without package names for build files', () => {
  const settings = path.join(storage, 'maven-settings.xml');
  const repository = path.join(storage, 'm2-repository');
  const maven = packageCommand('maven', [], { settings, repository });
  assert.ok(maven.args.includes('dependency:go-offline') && maven.args.includes('-B'));
  assert.ok(packageCommand('gradle', [], {}).args.includes('classes'));
  assert.deepEqual(packageCommand('conan', [], {}).args.slice(0, 3), [
    'install',
    '.',
    '--build=missing',
  ]);
  for (const manager of ['maven', 'gradle', 'conan'])
    assert.throws(() => packageCommand(manager, ['junit'], {}), { code: 'PACKAGE_SPEC_DENIED' });
  assert.deepEqual(packageCommand('vcpkg', ['fmt', 'zlib'], {}).args, [
    'add',
    'port',
    'fmt',
    'zlib',
  ]);
  assert.deepEqual(packageCommand('vcpkg', [], { triplet: 'x64-mingw-static' }).args.slice(-2), [
    '--triplet',
    'x64-mingw-static',
  ]);
  for (const bad of ['Fmt', 'fmt --triplet x', '../fmt', 'fmt@1'])
    assert.throws(() => packageCommand('vcpkg', [bad], {}), { code: 'PACKAGE_SPEC_DENIED' });
});

test('environments isolate Java, Conan and vcpkg state and keep telemetry off', () => {
  const java = toolchainEnvironment('maven', { storage, directory: 'C:\\jdk' });
  assert.equal(java.JAVA_HOME, 'C:\\jdk');
  assert.ok(java.GRADLE_USER_HOME.startsWith(storage));
  assert.ok(toolchainEnvironment('conan', { storage }).CONAN_HOME.startsWith(storage));
  const vcpkg = toolchainEnvironment('vcpkg', { storage, directory: 'C:\\vcpkg' });
  assert.equal(vcpkg.VCPKG_DISABLE_METRICS, '1');
  assert.equal(vcpkg.VCPKG_ROOT, 'C:\\vcpkg');
});

test('managed downloads are pinned to https vendor hosts with a published checksum', () => {
  for (const spec of Object.values(MANAGED_DOWNLOADS)) {
    assert.match(spec.url, /^https:\/\/(?:archive\.apache\.org|services\.gradle\.org)\//);
    assert.ok(spec.hashUrl.startsWith(spec.url));
    assert.ok(['sha256', 'sha512'].includes(spec.algorithm));
  }
  assert.match(DOWNLOAD_SCRIPT, /Checksum mismatch/);
  assert.match(DOWNLOAD_SCRIPT, /tar\.exe/);
  const specs = candidateSpecs('mingw', 'gcc', {
    home: 'C:\\Users\\a',
    programs: 'C:\\Program Files',
    programsX86: 'C:\\Program Files (x86)',
    local: 'C:\\Users\\a\\AppData\\Local',
  });
  assert.ok(
    specs.some((spec) => typeof spec === 'object' && spec.prefix === 'BrechtSanders.WinLibs'),
  );
});

test('runtime plans launch Maven and Gradle through java, and group C/C++ tools on PATH', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chanakya-stage2-plan-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bin = (name, directory = name) => `C:\\t\\${directory}\\${name}.exe`;
  const entry = (name, bins = [name], directory = name) => ({
    available: true,
    version: name,
    path: bin(bins[0], directory),
    bins: Object.fromEntries(bins.map((item) => [item, bin(item, directory)])),
  });
  const missing = { available: false, path: null, bins: {} };
  const runtime = new ProjectRuntime({ storage: path.join(root, 'storage') });
  const discovery = {
    node: { available: true, path: 'C:/t/node/node.exe' },
    npm: { available: false, path: null },
    python: { available: false, path: null },
    rust: missing,
    go: missing,
    dotnet: missing,
    java: entry('javac', ['javac', 'java'], 'jdk\\bin'),
    maven: {
      available: true,
      version: '3.9.11',
      path: 'C:\\m\\maven',
      jar: 'C:\\m\\maven\\boot\\cw.jar',
      bins: {},
    },
    gradle: {
      available: true,
      version: '8.14.3',
      path: 'C:\\g',
      jar: 'C:\\g\\lib\\gl.jar',
      bins: {},
    },
    cmake: entry('cmake', ['cmake', 'ctest']),
    ninja: entry('ninja'),
    mingw: entry('gcc', ['gcc', 'g++', 'mingw32-make'], 'mingw'),
    conan: entry('conan'),
    vcpkg: missing,
    sqlite: entry('sqlite3'),
    postgres: entry('psql'),
    arm: entry('arm-none-eabi-gcc', ['arm-none-eabi-gcc'], 'arm'),
    winget: 'C:\\winget.exe',
  };
  runtime.discover = async () => discovery;
  const hash = 'b'.repeat(64);
  const sources = new Map([
    ['schema.sql', 'create table t(a);'],
    ['bad.sql', '\\! calc'],
  ]);
  const context = {
    root,
    userId: 'owner',
    workspaceId: 'project',
    files: {
      list: async () => ({ entries: [] }),
      read: async ({ path: name }) => {
        const base = path.posix.basename(name);
        if (/pom\.xml|build\.gradle|conanfile/.test(base) || sources.has(base))
          return { path: name, version: hash, content: sources.get(base) ?? '' };
        throw Object.assign(new Error('missing'), { code: 'FILE_NOT_FOUND' });
      },
    },
    executionPolicy: { commands: true, downloads: true },
  };

  const mvn = await runtime.plan('exec.run', { executable: 'mvn', args: ['test'] }, context);
  assert.equal(mvn.executable, 'C:\\t\\jdk\\bin\\java.exe');
  assert.equal(mvn.args[0], '-classpath');
  assert.ok(mvn.args.includes('org.codehaus.plexus.classworlds.launcher.Launcher'));
  assert.ok(mvn.args.includes('-Dmaven.home=C:\\m\\maven'));
  assert.equal(mvn.args.at(-1), 'test');
  assert.ok(mvn.environment.JAVA_HOME.endsWith('jdk'));
  assert.deepEqual(mvn.observedFiles, [{ path: 'pom.xml', version: hash }]);

  const gradle = await runtime.plan('exec.run', { executable: 'gradle', args: ['build'] }, context);
  assert.ok(gradle.args.includes('org.gradle.launcher.GradleMain'));
  assert.ok(gradle.args.includes('--no-daemon'));

  await assert.rejects(
    runtime.plan(
      'exec.run',
      { executable: 'mvn', args: ['test'] },
      { ...context, executionPolicy: { commands: true, downloads: false } },
    ),
    { code: 'DOWNLOAD_GRANT_REQUIRED' },
  );

  const cmake = await runtime.plan(
    'exec.run',
    { executable: 'cmake', args: ['--build', 'build'] },
    context,
  );
  const pathEntries = cmake.environment.PATH.split(path.delimiter);
  for (const directory of ['C:\\t\\cmake', 'C:\\t\\ninja', 'C:\\t\\mingw', 'C:\\t\\arm'])
    assert.ok(pathEntries.includes(directory), directory);

  const install = await runtime.plan('deps.install', { manager: 'maven' }, context);
  assert.ok(install.args.includes('dependency:go-offline'));
  assert.equal(install.environment.GRADLE_USER_HOME.startsWith(path.join(root, 'storage')), true);
  await assert.rejects(
    runtime.plan('deps.install', { manager: 'maven', packages: ['junit'] }, context),
    {
      code: 'PACKAGE_SPEC_DENIED',
    },
  );
  await assert.rejects(runtime.plan('deps.install', { manager: 'vcpkg' }, context), {
    code: 'RUNTIME_MISSING',
  });

  const sqlite = await runtime.plan(
    'exec.run',
    { executable: 'sqlite3', args: ['app.db', 'schema.sql'] },
    context,
  );
  assert.deepEqual(sqlite.args, ['-batch', '-bail', '-safe', 'app.db', 'create table t(a);']);
  assert.deepEqual(sqlite.observedFiles, [{ path: 'schema.sql', version: hash }]);

  const psql = await runtime.plan(
    'exec.run',
    { executable: 'psql', args: ['-f', 'schema.sql'] },
    context,
  );
  assert.ok(psql.args.includes('127.0.0.1'));
  await assert.rejects(
    runtime.plan('exec.run', { executable: 'psql', args: ['-f', 'bad.sql'] }, context),
    denied,
  );

  const download = await runtime.plan('runtime.install', { runtime: 'maven' }, context);
  assert.equal(download.args[0], '-e');
  assert.equal(download.args[2], MANAGED_DOWNLOADS.maven.url);
  assert.equal(download.args[5], path.join(root, 'storage', 'tools'));
  const jdk = await runtime.plan('runtime.install', { runtime: 'java' }, context);
  assert.ok(jdk.args.includes('EclipseAdoptium.Temurin.21.JDK') && !jdk.args.includes('--scope'));
  const ninja = await runtime.plan('runtime.install', { runtime: 'ninja' }, context);
  assert.ok(ninja.args.includes('--scope'));
  await assert.rejects(runtime.plan('runtime.install', { runtime: 'vcpkg' }, context), {
    code: 'RUNTIME_INSTALL_UNAVAILABLE',
  });
});
