import path from 'node:path';
import { fail } from './contracts.js';

/**
 * Argument validation for the Java, C/C++, embedded C and SQL tools. Each
 * validator takes the model's argv and returns the argv to run, or throws
 * COMMAND_DENIED. They keep commands inside the project and refuse flags that
 * execute other programs, load plugins, change package sources or write outside
 * the workspace. Like every project command this is not an OS sandbox: the
 * project's own build files can still run code once the user approves.
 */
export const CONTROL = /[\x00-\x1f]/;

export const outsideProject = (token) =>
  /^[A-Za-z]:/.test(token) ||
  path.win32.isAbsolute(token) ||
  token.startsWith('\\\\') ||
  /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(token);

export function flagName(token) {
  const match = /^(?:-{1,2}|\/)([A-Za-z][\w-]*)/.exec(token);
  return match ? match[1].toLowerCase() : null;
}

const deny = (message) => {
  throw fail('COMMAND_DENIED', message, 403);
};

/** Control characters and response files (@file) are never accepted. */
function checkPlain(tokens) {
  for (const token of tokens)
    if (CONTROL.test(token) || token.startsWith('@'))
      deny('Arguments cannot contain control characters or response files.');
}

/**
 * Rejects denied flags and any path argument that leaves the project. Flags in
 * `readOnly` only read what they name (include and library directories), so
 * they may point at toolchain folders outside the project.
 */
function checkTokens(tokens, { denied = new Set(), readOnly = null } = {}) {
  let skipNext = false;
  for (const token of tokens) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (/^(?:-|\/)/.test(token)) {
      const name = flagName(token);
      if (name && denied.has(name))
        deny(`${token.split(/[=:]/)[0]} is not allowed in project commands.`);
      const read = readOnly?.exec(token);
      if (read) {
        // "-I dir" takes its value from the next token; "-Idir" carries it inline.
        skipNext = read[0].length === token.length;
        continue;
      }
      const value = token.includes('=') ? token.slice(token.indexOf('=') + 1) : '';
      if (value && outsideProject(value)) deny('Paths must stay inside the project.');
      continue;
    }
    if (outsideProject(token)) deny('Paths must stay inside the project.');
  }
}

const subcommandOf = (args, allowed, label) => {
  if (!allowed.has(args[0])) deny(`${label} supports: ${[...allowed].join(', ')}.`);
};

/* ----------------------------- Java ----------------------------- */

export function javacCommand(args) {
  checkPlain(args);
  if (args.some((token) => /^-J/.test(token))) deny('Passing options to the JVM is not allowed.');
  checkTokens(args, {
    denied: new Set([
      'processor',
      'processorpath',
      'processor-path',
      'processor-module-path',
      'xplugin',
    ]),
  });
  return [...args];
}

export function javaCommand(args) {
  checkPlain(args);
  for (const token of args)
    if (
      /^-XX:[+-]?(?:OnError|OnOutOfMemoryError|ErrorFile|HeapDumpPath|Flags|VMOptionsFile)/i.test(
        token,
      )
    )
      deny('This JVM option can run commands or write outside the project.');
  checkTokens(args, {
    denied: new Set([
      'javaagent',
      'agentlib',
      'agentpath',
      'xbootclasspath',
      'xrun',
      'xrunjdwp',
      'xdebug',
      'patch-module',
      'upgrade-module-path',
    ]),
  });
  return [...args];
}

const MAVEN_PHASES = new Set([
  'clean',
  'validate',
  'compile',
  'test-compile',
  'test',
  'package',
  'verify',
]);
const MAVEN_PROPERTIES = new Set([
  'skipTests',
  'maven.test.skip',
  'test',
  'failIfNoTests',
  'surefire.failIfNoSpecifiedTests',
  'maven.javadoc.skip',
]);

/** Maven runs in batch mode against app-owned settings and repository. */
export function mavenCommand(args, { settings, repository } = {}) {
  checkPlain(args);
  const goals = [];
  const flags = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (MAVEN_PHASES.has(token)) goals.push(token);
    else if (
      ['-q', '-e', '-X', '-U', '-o', '-B', '--quiet', '--errors', '--batch-mode'].includes(token)
    )
      flags.push(token);
    else if (['-pl', '-T', '-P'].includes(token)) {
      const value = args[++i] ?? '';
      if (!/^[\w.:,!@/+-]{1,200}$/.test(value) || value.includes('..'))
        deny(`${token} needs a simple project, thread or profile value.`);
      flags.push(token, value);
    } else if (token === '-am' || token === '--also-make') flags.push(token);
    else if (/^-D[\w.]+(?:=[\w.*,#!-]*)?$/.test(token)) {
      if (!MAVEN_PROPERTIES.has(token.slice(2).split('=')[0]))
        deny('Only test-selection and skip properties are accepted for Maven.');
      flags.push(token);
    } else
      deny(
        'Maven accepts lifecycle phases (clean, compile, test-compile, test, package, verify) with -q, -e, -X, -U, -o, -pl, -am, -T, -P and -DskipTests/-Dtest.',
      );
  }
  if (!goals.length) deny('Name a Maven phase such as compile, test or package.');
  return [
    '-B',
    '-s',
    settings,
    '-gs',
    settings,
    `-Dmaven.repo.local=${repository}`,
    ...flags,
    ...goals,
  ];
}

const GRADLE_TASKS = /^(?::?[A-Za-z][\w-]*)(?::[A-Za-z][\w-]*)*$/;
const GRADLE_BLOCKED_TASKS = /publish|upload|deploy|release|sign|install|exec|wrapper|init/i;

/** Gradle runs without a daemon, plain console and an app-owned user home. */
export function gradleCommand(args) {
  checkPlain(args);
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (
      ['-q', '-i', '--info', '--stacktrace', '--continue', '--quiet', '--offline'].includes(token)
    )
      out.push(token);
    else if (token === '-x' || token === '--exclude-task' || token === '--tests') {
      const value = args[++i] ?? '';
      if (!/^[\w.:*#-]{1,200}$/.test(value)) deny(`${token} needs a simple task or test pattern.`);
      out.push(token, value);
    } else if (!token.startsWith('-') && GRADLE_TASKS.test(token)) {
      if (GRADLE_BLOCKED_TASKS.test(token)) deny(`The ${token} task is not allowed.`);
      out.push(token);
    } else
      deny(
        'Gradle accepts task names (build, test, run, assemble, ...) with -q, -i, --stacktrace, --continue, --offline, -x and --tests.',
      );
  }
  if (!out.some((token) => !token.startsWith('-')))
    deny('Name a Gradle task such as build or test.');
  return ['--no-daemon', '--console=plain', ...out];
}

/* --------------------------- C / C++ ---------------------------- */

const CMAKE_DENIED_VARIABLE = /LAUNCHER|EMULATOR|PROJECT_INCLUDE|_COMMAND$|^CMAKE_COMMAND$/i;
const CMAKE_PASSTHROUGH = /^(?:-j\d*|-k\d*|-v|-n|\d+)$/;

export function cmakeCommand(args) {
  checkPlain(args);
  const out = [];
  let building = false;
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (building && token === '--') {
      const rest = args.slice(i + 1);
      if (rest.some((item) => !CMAKE_PASSTHROUGH.test(item)))
        deny('Only -j, -k, -v and -n may be passed to the build tool.');
      out.push('--', ...rest);
      break;
    }
    const name = flagName(token);
    if (token === '--build') {
      building = true;
      out.push(token);
      continue;
    }
    if (
      [
        '-S',
        '-B',
        '-G',
        '-A',
        '-T',
        '--preset',
        '--config',
        '--target',
        '--parallel',
        '-j',
      ].includes(token)
    ) {
      const value = args[++i] ?? '';
      if (!value || (outsideProject(value) && !['-G', '-A', '-T'].includes(token)))
        deny(`${token} needs a value inside the project.`);
      out.push(token, value);
      continue;
    }
    if (token === '-D' || /^-D./.test(token)) {
      const definition = token === '-D' ? (args[++i] ?? '') : token.slice(2);
      const variable = definition.split(/[:=]/)[0];
      const value = definition.includes('=') ? definition.slice(definition.indexOf('=') + 1) : '';
      if (!/^[A-Za-z_][\w.]*$/.test(variable) || CMAKE_DENIED_VARIABLE.test(variable))
        deny('This CMake variable can run other programs and is not allowed.');
      if (value && outsideProject(value)) deny('CMake paths must stay inside the project.');
      out.push(`-D${definition}`);
      continue;
    }
    if (
      [
        '--fresh',
        '--clean-first',
        '-v',
        '--verbose',
        '--list-presets',
        '--version',
        '-Wno-dev',
        '-Wdev',
      ].includes(token) ||
      /^--(?:parallel|config|target|preset)=[\w.+-]+$/.test(token)
    ) {
      out.push(token);
      continue;
    }
    if (name === 'e' || name === 'p' || name === 'c' || name === 'install' || name === 'workflow')
      deny(`${token} can run scripts or write outside the project and is not allowed.`);
    if (!token.startsWith('-') && building && !outsideProject(token)) {
      out.push(token);
      continue;
    }
    deny(
      'CMake accepts configure (-S -B -G -D), --build <dir> [--config --target --parallel --clean-first] and --preset.',
    );
  }
  if (!out.length) deny('Provide CMake arguments.');
  return out;
}

export function ctestCommand(args) {
  checkPlain(args);
  const allowedFlags = new Set([
    '--output-on-failure',
    '--rerun-failed',
    '--stop-on-failure',
    '-V',
    '-VV',
    '--verbose',
  ]);
  const withValue = new Set(['--test-dir', '-C', '-j', '--parallel', '-R', '-E', '--timeout']);
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (allowedFlags.has(token)) out.push(token);
    else if (withValue.has(token)) {
      const value = args[++i] ?? '';
      if (!value || (token === '--test-dir' && outsideProject(value)))
        deny(`${token} needs a value inside the project.`);
      out.push(token, value);
    } else deny('ctest accepts --test-dir, -C, -j, -R, -E, --timeout and --output-on-failure.');
  }
  return out;
}

export function ninjaCommand(args) {
  checkPlain(args);
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (['-v', '-n', '--verbose'].includes(token)) out.push(token);
    else if (['-C', '-f', '-j', '-k', '-l'].includes(token)) {
      const value = args[++i] ?? '';
      if (!value || (['-C', '-f'].includes(token) && outsideProject(value)))
        deny(`${token} needs a value inside the project.`);
      out.push(token, value);
    } else if (/^[\w./+-]+$/.test(token) && !token.startsWith('-') && !outsideProject(token))
      out.push(token);
    else deny('ninja accepts -C <dir>, -j, -k, -v and target names.');
  }
  return out;
}

const READ_PATH = /^(?:-I|-L|-isystem|-idirafter|-iquote|-include|-imacros|--sysroot)/;
const SAFE_SPECS = new Set(['nano.specs', 'nosys.specs', 'rdimon.specs', 'picolibc.specs']);

/** gcc, g++ and the arm-none-eabi compilers. */
export function compilerCommand(args) {
  checkPlain(args);
  for (const token of args) {
    if (/^-Wl,.*plugin/i.test(token)) deny('Linker plugins are not allowed.');
    if (/^-B(?!static$|dynamic$|symbolic$)/.test(token))
      deny('-B can point the compiler at other programs.');
    const specs = /^-specs=(.*)$/.exec(token);
    if (specs && !SAFE_SPECS.has(specs[1]))
      deny('Only the built-in nano, nosys, rdimon and picolibc specs are allowed.');
  }
  checkTokens(args, {
    denied: new Set(['wrapper', 'fplugin', 'b', 'fuse-ld', 'plugin', 'specs-file']),
    readOnly: READ_PATH,
  });
  if (args.some((token) => /^-fplugin/.test(token))) deny('Compiler plugins are not allowed.');
  return [...args];
}

export function makeCommand(args) {
  checkPlain(args);
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (['-j', '-C', '-f'].includes(token)) {
      const value = args[++i] ?? '';
      if (!value || (token !== '-j' && outsideProject(value)))
        deny(`${token} needs a value inside the project.`);
      out.push(token, value);
    } else if (
      ['-k', '-n', '-s', '-B', '--keep-going', '--dry-run'].includes(token) ||
      /^-j\d+$/.test(token)
    )
      out.push(token);
    else if (/^[A-Za-z_][\w]*=[\w./+:-]*$/.test(token) && !outsideProject(token.split('=')[1]))
      out.push(token);
    else if (/^[\w./+-]+$/.test(token) && !token.startsWith('-') && !outsideProject(token))
      out.push(token);
    else deny('make accepts -C, -f, -j, -k, -n, -s, VAR=value and target names.');
  }
  return out;
}

const CONAN_SUBCOMMANDS = new Set(['build', 'profile', 'list', 'inspect']);
export function conanCommand(args) {
  checkPlain(args);
  subcommandOf(args, CONAN_SUBCOMMANDS, 'conan');
  checkTokens(args.slice(1), {
    denied: new Set(['r', 'remote', 'pr', 'profile', 'lockfile-out', 'u', 'update']),
  });
  if (args[0] === 'profile' && !['detect', 'show', 'list', 'path'].includes(args[1]))
    deny('conan profile supports detect, show, list and path.');
  return [...args];
}

/* ------------------------------ SQL ----------------------------- */

const SQLITE_FLAGS = new Set([
  '-header',
  '-noheader',
  '-csv',
  '-column',
  '-json',
  '-line',
  '-list',
  '-markdown',
  '-table',
  '-box',
  '-echo',
  '-readonly',
  '-bail',
  '-batch',
  '-safe',
]);

/**
 * sqlite3 always runs batch, bail and safe: safe mode blocks .shell, .read,
 * ATTACH, writefile() and extensions. The first positional is the database
 * (inside the project, or :memory:); the rest is SQL text or a .sql file that
 * the runtime inlines.
 */
export function sqliteCommand(args) {
  if (args.some((token) => token.includes('\0'))) deny('Arguments cannot contain NUL.');
  const flags = [];
  let index = 0;
  while (index < args.length && args[index].startsWith('-')) {
    if (!SQLITE_FLAGS.has(args[index])) deny(`${args[index]} is not allowed for sqlite3.`);
    flags.push(args[index++]);
  }
  const database = args[index++];
  if (!database) deny('Name the database file, or :memory:.');
  if (
    database !== ':memory:' &&
    (database.startsWith('-') || outsideProject(database) || /^file:/i.test(database))
  )
    deny('The database must be a file inside the project.');
  const sql = args.slice(index);
  if (
    sql.some(
      (statement) =>
        /^\s*\./.test(statement) &&
        !/^\s*\.(?:headers|mode|tables|schema|indexes|width|timer|nullvalue|bail|echo)\b/i.test(
          statement,
        ),
    )
  )
    deny(
      'Only the .tables, .schema, .indexes, .headers, .mode, .width and .timer dot-commands are allowed.',
    );
  return { flags, database, sql };
}

const PSQL_META =
  /\\(?:!|o\b|g\b|gx|gexec|gset|w\b|i\b|ir\b|include|c\b|connect|cd\b|copy|setenv|out\b|lo_|sf\b|ef\b|e\b|s\b|r\b|\\)/;
export const PSQL_FILE_DENIED = PSQL_META;

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
export function psqlCommand(args) {
  checkPlain(args);
  const out = ['-X', '-w', '-v', 'ON_ERROR_STOP=1'];
  let file = null;
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (
      [
        '-A',
        '-t',
        '-q',
        '-x',
        '-1',
        '--no-align',
        '--tuples-only',
        '--quiet',
        '--single-transaction',
      ].includes(token)
    )
      out.push(token);
    else if (['-h', '--host'].includes(token)) {
      const host = args[++i] ?? '';
      if (!LOOPBACK.has(host))
        deny('psql may only connect to this computer (127.0.0.1, localhost or ::1).');
      out.push(token, host);
    } else if (['-p', '-U', '-d', '-F'].includes(token)) {
      const value = args[++i] ?? '';
      if (!value || value.startsWith('-') || (token === '-d' && /[=:/\\]/.test(value)))
        deny(`${token} needs a plain value.`);
      if (token === '-p' && !/^\d{2,5}$/.test(value)) deny('-p needs a port number.');
      out.push(token, value);
    } else if (token === '-c') {
      const command = args[++i] ?? '';
      if (!command || PSQL_META.test(command)) deny('psql meta-commands are not allowed in -c.');
      out.push(token, command);
    } else if (['-f', '--file'].includes(token)) {
      file = args[++i] ?? '';
      if (!file || outsideProject(file) || file === '-')
        deny('-f needs a script file inside the project.');
      out.push('-f', file);
    } else deny('psql accepts -h, -p, -U, -d, -c, -f, -A, -t, -q, -x and -1.');
  }
  if (!out.includes('-c') && !file) deny('Provide -c "<sql>" or -f <script.sql>.');
  if (!out.includes('-h')) out.push('-h', '127.0.0.1');
  return { args: out, file };
}
