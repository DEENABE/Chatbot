import { spawn, execFile } from 'node:child_process';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { root } from './config.mjs';

export function runPowerShell(request, { timeout = 30000, signal, spawnImpl = spawn } = {}) {
  if (process.platform !== 'win32' && spawnImpl === spawn) return Promise.resolve({ ok: false, error: { code: 'WINDOWS_REQUIRED', message: 'This adapter requires Windows.' } });
  return new Promise(resolve => {
    const windows = process.env.SystemRoot || 'C:\\Windows';
    const executable = path.win32.join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'PROGRAMDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'PSModulePath'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
    env.PATH = `${windows}\\System32;${windows}\\System32\\WindowsPowerShell\\v1.0`;
    env.PATHEXT = '.COM;.EXE;.BAT;.CMD';
    let child, timer, stopped = false, terminating = false, size = 0, output = '', errors = '';
    const stdoutDecoder = new StringDecoder('utf8'), stderrDecoder = new StringDecoder('utf8');
    const finish = result => { if (stopped) return; stopped = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve(result); };
    const fail = (code, message) => finish({ ok: false, error: { code, message, outcomeUnknown: ['TIMEOUT', 'CANCELLED', 'OUTPUT_LIMIT', 'TOOL_PROTOCOL_ERROR'].includes(code) } });
    const terminate = (code, message) => {
      if (stopped || terminating) return;
      terminating = true;
      // Kill the whole process tree before releasing the global execution lock.
      if (child?.pid && process.platform === 'win32') {
        execFile(path.win32.join(windows, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, () => fail(code, message));
      } else { child?.kill(); fail(code, message); }
    };
    const abort = () => terminate('CANCELLED', 'Operation cancelled; re-inspect before retrying a write.');
    if (signal?.aborted) return finish({ ok: false, error: { code: 'CANCELLED', message: 'Request cancelled before execution.', outcomeUnknown: false } });
    try {
      child = spawnImpl(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', path.join(root, 'scripts', 'Dispatch.ps1')], { shell: false, windowsHide: true, cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
      child.on('error', err => fail('SPAWN_FAILED', err.message));
      child.stdin.on('error', () => {});
      const consume = (chunk, stderr) => {
        size += chunk.length;
        if (size > 1024 * 1024) return terminate('OUTPUT_LIMIT', 'Tool exceeded its output budget.');
        if (stderr) errors += stderrDecoder.write(chunk); else output += stdoutDecoder.write(chunk);
      };
      child.stdout.on('data', c => consume(c, false));
      child.stderr.on('data', c => consume(c, true));
      child.on('close', code => {
        if (stopped || terminating) return;
        output += stdoutDecoder.end(); errors += stderrDecoder.end();
        try {
          const parsed = JSON.parse(output.trim().replace(/^\uFEFF/, ''));
          if (typeof parsed.ok !== 'boolean') throw new Error('Invalid tool envelope');
          if (code !== 0 && parsed.ok) throw new Error('Tool reported success with a nonzero exit code');
          finish(parsed);
        } catch { fail('TOOL_PROTOCOL_ERROR', `PowerShell exited ${code}. ${errors.slice(0, 1500) || 'No valid JSON result.'}`); }
      });
      timer = setTimeout(() => terminate('TIMEOUT', 'Tool deadline exceeded; a change may have been applied. Re-inspect state.'), timeout);
      signal?.addEventListener('abort', abort, { once: true });
      child.stdin.end(JSON.stringify(request));
    } catch (err) { fail('SPAWN_FAILED', err.message); }
  });
}
