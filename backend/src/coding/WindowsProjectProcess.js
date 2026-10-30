import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fail } from './contracts.js';

const helper = fileURLToPath(new URL('./ProjectProcessHost.cs', import.meta.url));
const source = readFileSync(helper);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const initialDigest = digest(source);
const bootstrap = String.raw`$ErrorActionPreference='Stop';[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:CHANAKYA_PROJECT_HOST_SOURCE))) -ReferencedAssemblies @('System.Web.Extensions.dll');[ChanakyaCoding.ProjectProcessHost]::Run()`;

export async function startProjectProcess(
  plan,
  { signal, onOutput = () => {}, timeoutMs = 300000, maxOutputBytes = 1024 * 1024 } = {},
) {
  signal?.throwIfAborted();
  if (process.platform !== 'win32')
    throw fail(
      'LOCAL_EXECUTION_UNAVAILABLE',
      'Supervised project commands currently require Windows.',
    );
  const identity = await fs.lstat(helper);
  if (
    !identity.isFile() ||
    identity.isSymbolicLink() ||
    identity.nlink !== 1 ||
    digest(await fs.readFile(helper)) !== initialDigest
  )
    throw fail(
      'HELPER_INTEGRITY_FAILED',
      'The project process supervisor changed. Restart the application.',
    );
  const windows = process.env.SystemRoot;
  if (!windows || !path.win32.isAbsolute(windows))
    throw fail('LOCAL_EXECUTION_UNAVAILABLE', 'The Windows runtime path is unavailable.');
  const child = spawn(
    path.win32.join(windows, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command', bootstrap],
    {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        SystemRoot: windows,
        WINDIR: windows,
        TEMP: process.env.TEMP || path.join(windows, 'Temp'),
        TMP: process.env.TMP || path.join(windows, 'Temp'),
        PSModulePath: path.join(windows, 'System32/WindowsPowerShell/v1.0/Modules'),
        CHANAKYA_PROJECT_HOST_SOURCE: source.toString('base64'),
      },
    },
  );
  let resolveStarted, rejectStarted, resolveDone;
  const started = new Promise((resolve, reject) => {
    resolveStarted = resolve;
    rejectStarted = reject;
  });
  const completion = new Promise((resolve) => {
    resolveDone = resolve;
  });
  let buffer = '',
    hostError = '',
    outputBytes = 0,
    exit,
    pid,
    stopped,
    finished = false,
    forcedTimer;
  const stop = (reason = 'CANCELLED') => {
    if (finished || stopped) return;
    stopped = reason;
    if (child.stdin.writable) child.stdin.write('stop\n');
    forcedTimer = setTimeout(() => child.kill(), 5000);
    forcedTimer.unref?.();
  };
  const abort = () => stop('CANCELLED');
  signal?.addEventListener('abort', abort, { once: true });
  const startupTimer = setTimeout(() => stop('PROCESS_START_TIMEOUT'), 30000);
  let deadline = null;
  const finish = (code, error) => {
    if (finished) return;
    finished = true;
    clearTimeout(startupTimer);
    clearTimeout(deadline);
    clearTimeout(forcedTimer);
    signal?.removeEventListener('abort', abort);
    const result = {
      exitCode: exit ?? code ?? null,
      code: stopped || (error ? 'COMMAND_START_FAILED' : null),
      error: error?.message || hostError || null,
      cancelled: stopped === 'CANCELLED',
    };
    if (!pid)
      rejectStarted(
        fail(
          result.code || 'COMMAND_START_FAILED',
          result.error || 'The project command could not start.',
        ),
      );
    resolveDone(result);
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    if (buffer.length > 128 * 1024) {
      stop('OUTPUT_LIMIT');
      buffer = '';
      return;
    }
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        hostError = 'The project supervisor returned invalid output.';
        stop('INVALID_PROCESS_RESULT');
        continue;
      }
      if (event.type === 'started' && Number.isInteger(event.pid)) {
        pid = event.pid;
        clearTimeout(startupTimer);
        if (timeoutMs) deadline = setTimeout(() => stop('COMMAND_TIMEOUT'), timeoutMs);
        resolveStarted({ pid, stop, completion });
      } else if (['stdout', 'stderr'].includes(event.type) && typeof event.text === 'string') {
        outputBytes += Buffer.byteLength(event.text);
        if (outputBytes > maxOutputBytes) {
          stop('OUTPUT_LIMIT');
          continue;
        }
        onOutput(event.type, event.text);
      } else if (event.type === 'exit' && Number.isInteger(event.exitCode)) exit = event.exitCode;
      else if (event.type === 'error')
        hostError = String(event.message || 'The project supervisor failed.').slice(0, 2000);
    }
  });
  child.stderr.on('data', (chunk) => {
    hostError = (hostError + chunk).slice(0, 4000);
  });
  child.on('error', (error) => finish(null, error));
  child.on('close', (code) =>
    finish(
      code,
      code && exit === undefined
        ? new Error(hostError || 'Project supervisor stopped unexpectedly.')
        : null,
    ),
  );
  child.stdin.on('error', () => {});
  child.stdin.write(
    JSON.stringify({
      executable: plan.executable,
      args: plan.args,
      cwd: plan.cwd,
      environment: plan.environment,
    }) + '\n',
  );
  if (signal?.aborted) abort();
  try {
    return await started;
  } catch (error) {
    await completion;
    throw error;
  }
}
