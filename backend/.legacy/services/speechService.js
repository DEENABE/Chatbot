import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const runFile = promisify(execFile);
const scriptPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'scripts',
  'transcribe.ps1'
);

export async function transcribeLocalWav(audioPath) {
  if (process.platform !== 'win32') {
    throw new Error('Local speech recognition currently requires Windows.');
  }
  try {
    const { stdout } = await runFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        '-AudioPath',
        audioPath
      ],
      { timeout: 60000, windowsHide: true, maxBuffer: 1024 * 1024 }
    );
    const output = stdout.trim();
    if (!output) return '';
    return JSON.parse(output).text || '';
  } catch (error) {
    const detail = error.stderr?.trim() || error.message;
    throw new Error(`Windows local speech recognition failed: ${detail}`);
  }
}
