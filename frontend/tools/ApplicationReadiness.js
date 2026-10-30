import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { execFile } from './ExecutionContext.js';

const GUI_APPLICATIONS = new Set([
  'notepad',
  'calc',
  'mspaint',
  'explorer',
  'chrome',
  'firefox',
  'msedge',
  'winword',
  'excel',
  'vlc',
  'spotify',
  'discord',
  'teams',
  'zoom',
  'code',
  'wt',
  'taskmgr',
  'control',
]);
export function supportsWindowReadiness(command) {
  return (
    typeof command === 'string' &&
    GUI_APPLICATIONS.has(
      path.win32
        .basename(command)
        .toLowerCase()
        .replace(/\.exe$/, ''),
    )
  );
}
export function parseTasklistWindow(text, pid) {
  for (const line of text.split(/\r?\n/)) {
    // tasklist /FO CSV quotes every field and doubles embedded quotes.
    const fields = [...line.matchAll(/"((?:[^"]|"")*)"(?:,|$)/g)].map((m) =>
      m[1].replace(/""/g, '"'),
    );
    if (fields.length !== 9 || Number(fields[1]) !== pid) continue;
    const title = fields[8].trim();
    return {
      ready: fields[5] === 'Running' && !!title && title !== 'N/A',
      title,
      processStatus: fields[5],
    };
  }
  return { ready: false, title: '', processStatus: 'not_observed' };
}
export function probeWindow(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return Promise.reject(new Error('Invalid process ID'));
  return new Promise((resolve, reject) =>
    execFile(
      'tasklist.exe',
      ['/FI', `PID eq ${pid}`, '/V', '/FO', 'CSV', '/NH'],
      {
        windowsHide: true,
        timeout: 750,
        maxBuffer: 1024 * 1024,
        encoding: 'utf8',
      },
      (error, stdout) => (error ? reject(error) : resolve(parseTasklistWindow(stdout, pid))),
    ),
  );
}

/** Read-only bounded evidence about the exact spawned process. Never relaunch. */
export async function checkApplicationReadiness({
  child,
  command,
  signal,
  platform = process.platform,
  probe = probeWindow,
  now = Date.now,
  wait = delay,
  timeoutMs = 3000,
}) {
  const base = {
    pid: child.pid,
    criterion: 'responding_window',
    profile: 'windows-gui-v1',
  };
  signal?.throwIfAborted();
  if (platform !== 'win32' || !supportsWindowReadiness(command))
    return {
      ...base,
      status: 'unsupported',
      reason: 'No supported application readiness profile.',
    };
  const deadline = now() + Math.min(Math.max(timeoutMs, 0), 3000);
  let last = { processStatus: 'not_observed', title: '' };
  while (now() < deadline) {
    signal?.throwIfAborted();
    if (child.exitCode != null || child.signalCode != null)
      return {
        ...base,
        status: 'not_ready',
        reason: 'Launched process exited; a handoff cannot be verified.',
      };
    try {
      last = await probe(child.pid);
    } catch (error) {
      signal?.throwIfAborted();
      last = { processStatus: 'probe_failed', title: '' };
    }
    signal?.throwIfAborted();
    if (child.exitCode != null || child.signalCode != null) continue;
    if (last.ready === true && now() <= deadline)
      return {
        ...base,
        status: 'ready',
        windowTitle: last.title,
        observedAt: new Date(now()).toISOString(),
      };
    await wait(Math.min(100, Math.max(0, deadline - now())), undefined, {
      signal,
    });
  }
  return {
    ...base,
    status: 'not_ready',
    reason: 'No responding application window observed before the deadline.',
    processStatus: last.processStatus,
  };
}
