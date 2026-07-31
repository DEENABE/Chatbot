/**
 * @module services/TextToSpeech
 * @description Speaks text through the Windows speech engine.
 *
 * Electron's Web Speech API reports zero voices on this platform, so
 * `speechSynthesis.speak()` accepts an utterance and silently discards it.
 * Windows itself has working SAPI voices, so we drive those directly through a
 * short PowerShell call instead.
 */

import { spawn } from 'child_process';

let current = null;

/**
 * Speak a line. Any line already being spoken is cut off first, so hovering
 * repeatedly does not stack voices on top of each other.
 *
 * @param {string} text - The line to speak.
 * @param {Object} [options]
 * @param {number} [options.rate=1] - SAPI rate, -10 (slow) to 10 (fast).
 * @param {number} [options.volume=100] - 0 to 100.
 * @returns {boolean} Whether speech was started.
 */
export function speak(text, { rate = 1, volume = 100 } = {}) {
  const line = String(text || '').trim();
  if (!line) return false;

  stop();

  // Single-quoted PowerShell string: only the quote itself needs escaping, and
  // this keeps the greeting text out of any expression context.
  const escaped = line.replace(/'/g, "''");
  const script =
    'Add-Type -AssemblyName System.Speech; ' +
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ' +
    `$s.Rate = ${Math.max(-10, Math.min(10, Math.round(rate)))}; ` +
    `$s.Volume = ${Math.max(0, Math.min(100, Math.round(volume)))}; ` +
    `$s.Speak('${escaped}')`;

  try {
    current = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, stdio: 'ignore' }
    );
    current.on('close', () => { current = null; });
    current.on('error', () => { current = null; });
    return true;
  } catch {
    current = null;
    return false;
  }
}

/** Stop whatever is being spoken. */
export function stop() {
  if (!current) return;
  try { current.kill(); } catch { /* already gone */ }
  current = null;
}
