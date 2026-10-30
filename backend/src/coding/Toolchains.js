import path from 'node:path';
import { fail } from './contracts.js';
import {
  CONTROL,
  flagName,
  outsideProject,
  javacCommand,
  javaCommand,
  mavenCommand,
  gradleCommand,
  cmakeCommand,
  ctestCommand,
  ninjaCommand,
  compilerCommand,
  makeCommand,
  conanCommand,
  sqliteCommand,
  psqlCommand,
} from './ToolchainCommands.js';

/**
 * Toolchain registry and the pure helpers around it: which toolchain a command
 * belongs to, where to look for it, which arguments are accepted and which
 * environment keeps each tool inside the application's own cache directories.
 * Discovery and process launching stay in ProjectRuntime.
 */
const winget = (id, userScope, note) => ({ type: 'winget', id, userScope, note });
const ELEVATION =
  'Windows may show its own administrator prompt for the installer. This app never elevates.';

export const MANAGED_DOWNLOADS = Object.freeze({
  maven: {
    version: '3.9.11',
    directory: 'apache-maven-3.9.11',
    url: 'https://archive.apache.org/dist/maven/maven-3/3.9.11/binaries/apache-maven-3.9.11-bin.zip',
    hashUrl:
      'https://archive.apache.org/dist/maven/maven-3/3.9.11/binaries/apache-maven-3.9.11-bin.zip.sha512',
    algorithm: 'sha512',
  },
  gradle: {
    version: '8.14.3',
    directory: 'gradle-8.14.3',
    url: 'https://services.gradle.org/distributions/gradle-8.14.3-bin.zip',
    hashUrl: 'https://services.gradle.org/distributions/gradle-8.14.3-bin.zip.sha256',
    algorithm: 'sha256',
  },
});

export const TOOLCHAINS = Object.freeze({
  rust: {
    label: 'Rust',
    bins: ['cargo'],
    versionArgs: ['--version'],
    install: winget(
      'Rustlang.Rustup',
      true,
      'Installs rustup for your Windows user. Compiling also needs the MSVC C++ build tools; run "rustup default stable" in a terminal if cargo is still missing afterwards.',
    ),
  },
  go: {
    label: 'Go',
    bins: ['go'],
    versionArgs: ['version'],
    install: winget('GoLang.Go', false, `Installs Go with its official installer. ${ELEVATION}`),
  },
  dotnet: {
    label: '.NET',
    bins: ['dotnet'],
    versionArgs: ['--version'],
    install: winget(
      'Microsoft.DotNet.SDK.10',
      false,
      `Installs the .NET 10 SDK with its official installer. ${ELEVATION}`,
    ),
  },
  java: {
    label: 'Java (JDK)',
    bins: ['javac', 'java'],
    versionArgs: ['-version'],
    install: winget(
      'EclipseAdoptium.Temurin.21.JDK',
      false,
      `Installs Eclipse Temurin JDK 21. ${ELEVATION}`,
    ),
  },
  maven: {
    label: 'Maven',
    bins: ['mvn'],
    requires: ['java'],
    install: {
      type: 'download',
      note: 'Downloads Apache Maven 3.9.11 from archive.apache.org, checks its SHA-512 and unpacks it into the app storage folder. Needs the JDK.',
    },
  },
  gradle: {
    label: 'Gradle',
    bins: ['gradle'],
    requires: ['java'],
    install: {
      type: 'download',
      note: 'Downloads Gradle 8.14.3 from services.gradle.org, checks its SHA-256 and unpacks it into the app storage folder. Needs the JDK.',
    },
  },
  cmake: {
    label: 'CMake',
    bins: ['cmake', 'ctest'],
    versionArgs: ['--version'],
    install: winget('Kitware.CMake', false, `Installs CMake. ${ELEVATION}`),
  },
  ninja: {
    label: 'Ninja',
    bins: ['ninja'],
    versionArgs: ['--version'],
    install: winget(
      'Ninja-build.Ninja',
      true,
      'Installs the Ninja build tool for your Windows user.',
    ),
  },
  mingw: {
    label: 'GCC (MinGW-w64)',
    bins: ['gcc', 'g++', 'mingw32-make'],
    versionArgs: ['--version'],
    install: winget(
      'BrechtSanders.WinLibs.POSIX.UCRT',
      true,
      'Installs the WinLibs GCC toolchain (gcc, g++, make) for your Windows user.',
    ),
  },
  conan: {
    label: 'Conan',
    bins: ['conan'],
    versionArgs: ['--version'],
    install: winget('JFrog.Conan', false, `Installs the Conan package manager. ${ELEVATION}`),
  },
  vcpkg: {
    label: 'vcpkg',
    bins: ['vcpkg'],
    versionArgs: ['version'],
    install: null,
    manual:
      'vcpkg is not distributed through Windows Package Manager. Install it yourself, then set VCPKG_ROOT to its folder and restart the app.',
  },
  sqlite: {
    label: 'SQLite',
    bins: ['sqlite3'],
    versionArgs: ['--version'],
    install: winget(
      'SQLite.SQLite',
      true,
      'Installs the sqlite3 command-line tool for your Windows user.',
    ),
  },
  postgres: {
    label: 'PostgreSQL (psql)',
    bins: ['psql'],
    versionArgs: ['--version'],
    install: null,
    manual:
      'Install PostgreSQL yourself (the installer asks for a superuser password, which this app never handles), run the server on this computer and store the password in pgpass.conf.',
  },
  arm: {
    label: 'Arm GNU (embedded C)',
    bins: ['arm-none-eabi-gcc', 'arm-none-eabi-g++', 'arm-none-eabi-size', 'arm-none-eabi-objcopy'],
    versionArgs: ['--version'],
    install: winget(
      'Arm.GnuArmEmbeddedToolchain',
      false,
      `Installs the Arm GNU embedded toolchain (build only; nothing is flashed to hardware). ${ELEVATION}`,
    ),
  },
});

export const TOOLCHAIN_BY_COMMAND = Object.freeze(
  Object.fromEntries(
    Object.entries(TOOLCHAINS).flatMap(([name, tool]) => tool.bins.map((bin) => [bin, name])),
  ),
);
export const TOOLCHAIN_BY_MANAGER = Object.freeze({
  cargo: 'rust',
  go: 'go',
  dotnet: 'dotnet',
  maven: 'maven',
  gradle: 'gradle',
  conan: 'conan',
  vcpkg: 'vcpkg',
});
/** The command each package manager runs. */
export const MANAGER_COMMAND = Object.freeze({
  cargo: 'cargo',
  go: 'go',
  dotnet: 'dotnet',
  maven: 'mvn',
  gradle: 'gradle',
  conan: 'conan',
  vcpkg: 'vcpkg',
});
/** Tools whose builds fetch dependencies themselves, so they need download permission. */
export const ONLINE_COMMANDS = new Set(['mvn', 'gradle']);
/** Tool folders put on PATH together, so cmake finds its generator and compiler. */
export const PATH_GROUPS = Object.freeze({
  cpp: ['cmake', 'ninja', 'mingw', 'conan', 'vcpkg', 'arm'],
  java: ['java'],
});

const SUBCOMMANDS = {
  cargo: new Set(['build', 'check', 'test', 'run', 'clippy', 'fmt', 'doc', 'clean', 'bench']),
  go: new Set(['build', 'run', 'test', 'vet', 'fmt', 'version']),
  dotnet: new Set(['build', 'run', 'test', 'clean', 'format', 'publish']),
};
// Flags that name a program to execute, a file or directory outside the project,
// or another package source. Compared without leading dashes and any =value.
const DENIED_FLAGS = {
  cargo: new Set([
    'manifest-path',
    'config',
    'target-dir',
    'artifact-dir',
    'out-dir',
    'lockfile-path',
    'registry',
    'index',
    'token',
    'git',
    'path',
  ]),
  go: new Set([
    'toolexec',
    'exec',
    'vettool',
    'modfile',
    'overlay',
    'pkgdir',
    'c',
    'ldflags',
    'gcflags',
    'asmflags',
    'gccgoflags',
    'work',
  ]),
  dotnet: new Set([
    'source',
    's',
    'configfile',
    'property',
    'p',
    't',
    'target',
    'l',
    'logger',
    'fl',
    'filelogger',
    'flp',
    'fileloggerparameters',
    'dl',
    'distributedlogger',
    'bl',
    'binarylogger',
    'restore',
    'pp',
    'preprocess',
    'graph',
    'graphbuild',
    'toolsversion',
    'tv',
    'getproperty',
    'getitem',
    'gettargetresult',
    'ipe',
    'ignoreprojectextensions',
    'interactive',
    'settings',
    'test-adapter-path',
    'e',
    'environment',
  ]),
};

/**
 * Validates an exec.run / exec.start / tests.run command for a toolchain and
 * returns the final argv. Dependency downloads are not available here: builds
 * run offline and use packages fetched earlier through deps.install.
 */
export function toolchainCommand(command, args, context = {}) {
  if (!SUBCOMMANDS[command]) return extendedCommand(command, args, context);
  const subcommand = args[0];
  if (!SUBCOMMANDS[command].has(subcommand))
    throw fail(
      'COMMAND_DENIED',
      `${command} supports: ${[...SUBCOMMANDS[command]].join(', ')}. Use deps.install for packages.`,
      403,
    );
  // Arguments after a literal "--" belong to the program being run or tested.
  const separator = args.indexOf('--');
  const own = separator < 0 ? args.slice(1) : args.slice(1, separator);
  const passed = separator < 0 ? [] : args.slice(separator + 1);
  for (const token of [...own, ...passed])
    if (CONTROL.test(token) || token.startsWith('@'))
      throw fail(
        'COMMAND_DENIED',
        'Arguments cannot contain control characters or response files.',
      );
  for (const token of own) {
    const name = flagName(token);
    if (name && DENIED_FLAGS[command].has(name))
      throw fail(
        'COMMAND_DENIED',
        `${token.split(/[=:]/)[0]} is not allowed in project commands.`,
        403,
      );
    if (command === 'cargo' && /^-Z/.test(token))
      throw fail('COMMAND_DENIED', 'Unstable cargo flags are not allowed.', 403);
    const value = token.includes('=') ? token.slice(token.indexOf('=') + 1) : token;
    if (outsideProject(value))
      throw fail('COMMAND_DENIED', 'Paths must stay inside the project.', 403);
  }
  const extra = [];
  if (command === 'dotnet') {
    if (
      ['build', 'run', 'test', 'publish', 'format'].includes(subcommand) &&
      !own.includes('--no-restore')
    )
      extra.push('--no-restore');
    if (subcommand === 'run' && !own.includes('--no-launch-profile'))
      extra.push('--no-launch-profile');
  }
  return separator < 0
    ? [...args, ...extra]
    : [...args.slice(0, separator), ...extra, ...args.slice(separator)];
}

const crate = /^[A-Za-z_][A-Za-z0-9_-]{0,63}(?:@[\^~=]?\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?)?$/;
const goModule =
  /^[A-Za-z0-9][A-Za-z0-9._~-]*(?:\/[A-Za-z0-9._~-]+)+(?:@(?:latest|v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+incompatible)?))?$/;
const nugetId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const nugetVersion = /^\d+(?:\.\d+){1,3}(?:-[0-9A-Za-z.-]+)?$/;
const NUGET_SOURCE = 'https://api.nuget.org/v3/index.json';

/**
 * argv for deps.install with a Rust, Go or .NET package manager. Only named
 * registry packages are accepted: no URLs, git sources, local paths or flags.
 * With no packages the project's own manifest is restored instead.
 */
export function packageCommand(
  manager,
  packages,
  { projectFile, settings, repository, triplet } = {},
) {
  const denied = () =>
    fail(
      'PACKAGE_SPEC_DENIED',
      manager === 'cargo'
        ? 'Use crates.io crate names with an optional @version.'
        : manager === 'go'
          ? 'Use Go module paths such as github.com/owner/repo with an optional @version.'
          : manager === 'vcpkg'
            ? 'Use lowercase vcpkg port names.'
            : 'Use a NuGet package id with an optional @version.',
    );
  if (packages.length > 30) throw denied();
  if (manager === 'cargo') {
    if (packages.some((name) => !crate.test(name))) throw denied();
    return packages.length
      ? {
          args: ['add', '--registry', 'crates-io', ...packages],
          display: `cargo add ${packages.join(' ')} · crates.io only`,
        }
      : { args: ['fetch'], display: 'cargo fetch · download the crates listed in Cargo.toml' };
  }
  if (manager === 'go') {
    if (packages.some((name) => !goModule.test(name) || name.includes('..'))) throw denied();
    return packages.length
      ? { args: ['get', ...packages], display: `go get ${packages.join(' ')}` }
      : { args: ['mod', 'download'], display: 'go mod download · modules listed in go.mod' };
  }
  if (manager === 'dotnet') {
    if (!projectFile) throw denied();
    if (packages.length > 1)
      throw fail('PACKAGE_SPEC_DENIED', 'Add one NuGet package per deps.install call.');
    if (!packages.length)
      return {
        args: ['restore', projectFile, '--source', NUGET_SOURCE],
        display: `dotnet restore ${projectFile} · nuget.org only`,
      };
    const [id, version] = packages[0].split('@');
    if (!nugetId.test(id) || (version !== undefined && !nugetVersion.test(version))) throw denied();
    return {
      args: [
        'add',
        projectFile,
        'package',
        id,
        ...(version ? ['--version', version] : []),
        '--source',
        NUGET_SOURCE,
      ],
      display: `dotnet add package ${id}${version ? ` ${version}` : ''} · nuget.org only`,
    };
  }
  if (['maven', 'gradle', 'conan'].includes(manager)) {
    if (packages.length)
      throw fail(
        'PACKAGE_SPEC_DENIED',
        manager === 'maven'
          ? 'Add dependencies to pom.xml, then call deps.install without packages.'
          : manager === 'gradle'
            ? 'Add dependencies to the Gradle build file, then call deps.install without packages.'
            : 'List requirements in conanfile.txt or conanfile.py, then call deps.install without packages.',
      );
    if (manager === 'maven')
      return {
        args: [
          '-B',
          '-s',
          settings,
          '-gs',
          settings,
          `-Dmaven.repo.local=${repository}`,
          'dependency:go-offline',
        ],
        display: 'mvn dependency:go-offline · download the dependencies and plugins in pom.xml',
      };
    if (manager === 'gradle')
      return {
        args: ['--no-daemon', '--console=plain', 'classes', 'testClasses'],
        display: 'gradle classes testClasses · download and compile dependencies',
      };
    return {
      args: ['install', '.', '--build=missing', '--output-folder', 'build'],
      display: 'conan install . --build=missing · ConanCenter packages from conanfile',
    };
  }
  if (manager === 'vcpkg') {
    if (packages.some((name) => !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name))) throw denied();
    return packages.length
      ? { args: ['add', 'port', ...packages], display: `vcpkg add port ${packages.join(' ')}` }
      : {
          args: [
            'install',
            '--x-install-root=vcpkg_installed',
            ...(triplet ? ['--triplet', triplet] : []),
          ],
          display: 'vcpkg install · ports listed in vcpkg.json',
        };
  }
  throw fail(
    'PACKAGE_MANAGER_UNSUPPORTED',
    'Choose npm, pip, cargo, go, dotnet, maven, gradle, conan or vcpkg.',
  );
}

/** Files each package manager rewrites, relative to the project directory. */
export function managedFiles(manager, projectFile) {
  if (manager === 'npm') return ['package.json', 'package-lock.json'];
  if (manager === 'cargo') return ['Cargo.toml', 'Cargo.lock'];
  if (manager === 'go') return ['go.mod', 'go.sum'];
  if (manager === 'dotnet' && projectFile) return [projectFile];
  if (manager === 'vcpkg') return ['vcpkg.json'];
  return [];
}

/**
 * Environment for one toolchain: caches live in the application's storage, user
 * and machine config files are ignored, telemetry is off, and only the install
 * phase may reach a package registry.
 */
export function toolchainEnvironment(
  runtime,
  { storage, directory, install = false, port = null },
) {
  const join = (...parts) => path.join(storage, ...parts);
  if (runtime === 'rust')
    return {
      CARGO_HOME: join('cargo-home'),
      CARGO_NET_OFFLINE: install ? 'false' : 'true',
      CARGO_REGISTRIES_CRATES_IO_PROTOCOL: 'sparse',
      CARGO_TERM_COLOR: 'never',
      CARGO_TERM_PROGRESS_WHEN: 'never',
    };
  if (runtime === 'go')
    return {
      GOPATH: join('go-path'),
      GOMODCACHE: join('go-path', 'pkg', 'mod'),
      GOCACHE: join('go-cache'),
      GOENV: 'off',
      GOTOOLCHAIN: 'local',
      GO111MODULE: 'on',
      GOVCS: '*:off',
      GOPROXY: install ? 'https://proxy.golang.org' : 'off',
      GOFLAGS: install ? '-mod=mod' : '-mod=readonly',
    };
  if (runtime === 'dotnet')
    return {
      ...(directory ? { DOTNET_ROOT: directory } : {}),
      DOTNET_CLI_HOME: join('dotnet-home'),
      NUGET_PACKAGES: join('nuget-packages'),
      NUGET_HTTP_CACHE_PATH: join('nuget-http'),
      DOTNET_NOLOGO: '1',
      DOTNET_CLI_TELEMETRY_OPTOUT: '1',
      DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
      DOTNET_GENERATE_ASPNET_CERTIFICATE: 'false',
      DOTNET_CLI_UI_LANGUAGE: 'en',
      // No build servers left running after the command finishes.
      MSBUILDDISABLENODEREUSE: '1',
      DOTNET_CLI_USE_MSBUILD_SERVER: '0',
      UseSharedCompilation: 'false',
      ...(port ? { ASPNETCORE_URLS: `http://127.0.0.1:${port}` } : {}),
    };
  if (runtime === 'java' || runtime === 'maven' || runtime === 'gradle')
    return {
      ...(directory ? { JAVA_HOME: directory } : {}),
      GRADLE_USER_HOME: join('gradle-home'),
    };
  if (runtime === 'conan') return { CONAN_HOME: join('conan-home') };
  if (runtime === 'vcpkg')
    return {
      ...(directory ? { VCPKG_ROOT: directory } : {}),
      VCPKG_DISABLE_METRICS: '1',
      VCPKG_DEFAULT_BINARY_CACHE: join('vcpkg-cache'),
    };
  if (runtime === 'postgres') return { PGCONNECT_TIMEOUT: '10' };
  return {};
}

/**
 * Validation for the tools added after Rust, Go and .NET. `context.storage` is
 * the app storage folder that holds the Maven settings and local repository.
 */
function extendedCommand(command, args, context) {
  const storage = context.storage || '';
  switch (command) {
    case 'javac':
      return javacCommand(args);
    case 'java':
      return javaCommand(args);
    case 'mvn':
      return mavenCommand(args, {
        settings: path.join(storage, 'maven-settings.xml'),
        repository: path.join(storage, 'm2-repository'),
      });
    case 'gradle':
      return gradleCommand(args);
    case 'cmake':
      return cmakeCommand(args);
    case 'ctest':
      return ctestCommand(args);
    case 'ninja':
      return ninjaCommand(args);
    case 'gcc':
    case 'g++':
    case 'arm-none-eabi-gcc':
    case 'arm-none-eabi-g++':
    case 'arm-none-eabi-size':
    case 'arm-none-eabi-objcopy':
      return compilerCommand(args);
    case 'mingw32-make':
      return makeCommand(args);
    case 'conan':
      return conanCommand(args);
    case 'sqlite3': {
      const { flags, database, sql } = sqliteCommand(args);
      return [
        '-batch',
        '-bail',
        '-safe',
        ...flags.filter((flag) => !['-batch', '-bail', '-safe'].includes(flag)),
        database,
        ...sql,
      ];
    }
    case 'psql':
      return psqlCommand(args).args;
    default:
      throw fail('COMMAND_DENIED', `${command} is not a supported project tool.`, 403);
  }
}

/**
 * Where to look for a tool's executable on Windows. Strings are file paths; an
 * object names a folder whose sub-folders (starting with `prefix`) each hold
 * `relative`. PATH entries are searched too by the caller.
 */
export function candidateSpecs(runtime, bin, env) {
  const { home, programs, programsX86, local, javaHome, vcpkgRoot } = env;
  const exe = `${bin}.exe`;
  const links = path.join(local, 'Microsoft', 'WinGet', 'Links');
  const packages = path.join(local, 'Microsoft', 'WinGet', 'Packages');
  switch (runtime) {
    case 'rust':
      return [path.join(home, '.cargo', 'bin', exe)];
    case 'go':
      return [
        path.join(programs, 'Go', 'bin', exe),
        path.join(local, 'Programs', 'Go', 'bin', exe),
      ];
    case 'dotnet':
      return [path.join(programs, 'dotnet', exe), path.join(local, 'Microsoft', 'dotnet', exe)];
    case 'java':
      return [
        javaHome && path.join(javaHome, 'bin', exe),
        ...[
          path.join(programs, 'Eclipse Adoptium'),
          path.join(programs, 'Microsoft'),
          path.join(programs, 'Java'),
        ].map((dir) => ({ dir, prefix: 'jdk', relative: path.join('bin', exe) })),
      ].filter(Boolean);
    case 'cmake':
      return [path.join(programs, 'CMake', 'bin', exe)];
    case 'ninja':
      return [path.join(links, exe), { dir: packages, prefix: 'Ninja-build.Ninja', relative: exe }];
    case 'mingw':
      return [
        {
          dir: packages,
          prefix: 'BrechtSanders.WinLibs',
          relative: path.join('mingw64', 'bin', exe),
        },
        path.join('C:\\msys64', 'ucrt64', 'bin', exe),
        path.join('C:\\mingw64', 'bin', exe),
      ];
    case 'conan':
      return [path.join(programs, 'Conan', 'conan', exe)];
    case 'vcpkg':
      return [vcpkgRoot && path.join(vcpkgRoot, exe)].filter(Boolean);
    case 'sqlite':
      return [path.join(links, exe), { dir: packages, prefix: 'SQLite.SQLite', relative: exe }];
    case 'postgres':
      return [
        { dir: path.join(programs, 'PostgreSQL'), prefix: '', relative: path.join('bin', exe) },
      ];
    case 'arm':
      return [
        {
          dir: path.join(programsX86, 'Arm GNU Toolchain arm-none-eabi'),
          prefix: '',
          relative: path.join('bin', exe),
        },
        {
          dir: path.join(programs, 'Arm GNU Toolchain arm-none-eabi'),
          prefix: '',
          relative: path.join('bin', exe),
        },
      ];
    default:
      return [];
  }
}

/**
 * Turns a validated tool command into the process to start. Maven and Gradle are
 * launched through the JDK's java.exe, so no .cmd shell is involved.
 */
export function launchCommand(command, args, { runtimes, cwd }) {
  const javaPath = runtimes.java?.bins?.java;
  if (command === 'mvn') {
    const home = runtimes.maven.path;
    return {
      executable: javaPath,
      args: [
        '-classpath',
        runtimes.maven.jar,
        `-Dclassworlds.conf=${path.join(home, 'bin', 'm2.conf')}`,
        `-Dmaven.home=${home}`,
        `-Dmaven.multiModuleProjectDirectory=${cwd}`,
        'org.codehaus.plexus.classworlds.launcher.Launcher',
        ...args,
      ],
    };
  }
  if (command === 'gradle')
    return {
      executable: javaPath,
      args: ['-classpath', runtimes.gradle.jar, 'org.gradle.launcher.GradleMain', ...args],
    };
  return {
    executable:
      TOOLCHAINS[TOOLCHAIN_BY_COMMAND[command]] &&
      runtimes[TOOLCHAIN_BY_COMMAND[command]].bins?.[command],
    args,
  };
}

/** Settings file that keeps Maven away from the user's own ~/.m2/settings.xml. */
export const MAVEN_SETTINGS = `<?xml version="1.0" encoding="UTF-8"?>
<settings xmlns="http://maven.apache.org/SETTINGS/1.2.0"/>
`;

// Runs under node: downloads a pinned archive, checks the checksum published next
// to it, and unpacks it with the Windows tar. Nothing here comes from the model.
export const DOWNLOAD_SCRIPT = `
const fs = require('fs'), path = require('path'), crypto = require('crypto'), cp = require('child_process');
(async () => {
  const [url, hashUrl, algorithm, destination] = process.argv.slice(1);
  const get = async (target) => {
    const response = await fetch(target, { redirect: 'follow' });
    if (!response.ok) throw new Error('HTTP ' + response.status + ' for ' + target);
    return response;
  };
  const expected = (await (await get(hashUrl)).text()).trim().split(/\\s+/)[0].toLowerCase();
  const bytes = Buffer.from(await (await get(url)).arrayBuffer());
  const actual = crypto.createHash(algorithm).update(bytes).digest('hex');
  if (actual !== expected) throw new Error('Checksum mismatch; the download was discarded.');
  fs.mkdirSync(destination, { recursive: true });
  const archive = path.join(destination, 'download.zip');
  fs.writeFileSync(archive, bytes);
  cp.execFileSync(path.join(process.env.SystemRoot, 'System32', 'tar.exe'), ['-xf', archive, '-C', destination], { stdio: 'inherit' });
  fs.unlinkSync(archive);
  console.log('Verified ' + algorithm + ' ' + actual.slice(0, 16) + '... and unpacked into ' + destination);
})().catch((error) => { console.error(error.message); process.exit(1); });
`;
