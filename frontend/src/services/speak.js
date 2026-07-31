/**
 * @module services/speak
 * @description Text-to-speech that actually produces sound in Electron.
 *
 * `speechSynthesis.getVoices()` is populated asynchronously. Calling speak()
 * before the list arrives is the usual reason nothing is heard: Chromium
 * accepts the utterance and silently drops it. This waits for the voices, picks
 * an English one, and only then speaks.
 */

let voicesPromise = null;

/**
 * Resolve once the browser has loaded its voice list (or we give up waiting).
 * @returns {Promise<SpeechSynthesisVoice[]>}
 */
function loadVoices() {
  if (voicesPromise) return voicesPromise;

  voicesPromise = new Promise((resolve) => {
    const synth = window.speechSynthesis;
    const ready = synth.getVoices();
    if (ready.length) {
      resolve(ready);
      return;
    }

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      synth.removeEventListener('voiceschanged', finish);
      resolve(synth.getVoices());
    };

    synth.addEventListener('voiceschanged', finish);
    // Some builds never fire the event; don't hang on them.
    setTimeout(finish, 1500);
  });

  return voicesPromise;
}

/**
 * Pick the nicest available English voice, falling back to whatever exists.
 * @param {SpeechSynthesisVoice[]} voices
 * @returns {SpeechSynthesisVoice|null}
 */
function pickVoice(voices) {
  if (!voices.length) return null;
  const english = voices.filter((v) => /^en(-|_|$)/i.test(v.lang));
  const pool = english.length ? english : voices;
  // Prefer a natural-sounding local voice over a robotic default.
  return (
    pool.find((v) => /natural|neural|online/i.test(v.name)) ||
    pool.find((v) => v.localService) ||
    pool[0]
  );
}

/**
 * Speak a line out loud. Resolves false when speech is unavailable so callers
 * can tell the difference between "spoke" and "could not".
 *
 * @param {string} text
 * @param {Object} [options]
 * @param {number} [options.rate=1.02]
 * @param {number} [options.pitch=1.05]
 * @returns {Promise<boolean>}
 */
export async function speak(text, { rate = 1.02, pitch = 1.05 } = {}) {
  if (!text) return false;

  // Prefer the Windows engine when running in Electron: its Web Speech API
  // reports zero voices, so speechSynthesis accepts utterances and drops them.
  if (window.electronAPI?.speak) {
    try {
      // Both sides use a speed multiplier where 1 is normal, so `rate` passes
      // straight through.
      const spoke = await window.electronAPI.speak(text, { speed: rate });
      if (spoke) return true;
    } catch {
      // fall through to the browser path
    }
  }

  if (!('speechSynthesis' in window)) return false;

  const synth = window.speechSynthesis;
  const voices = await loadVoices();
  if (!voices.length) return false;

  synth.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = rate;
  utterance.pitch = pitch;

  const voice = pickVoice(voices);
  if (voice) {
    utterance.voice = voice;
    utterance.lang = voice.lang;
  }

  // Resolve when the line actually finishes, not the instant it was queued —
  // callers (the avatar's speaking state) need to know the real duration, and
  // synth.speak() alone returns before a word is spoken.
  return new Promise((resolve) => {
    utterance.onend = () => resolve(true);
    utterance.onerror = () => resolve(false);
    synth.speak(utterance);
  });
}

/** Stop anything currently being spoken, on whichever engine is in use. */
export function stopSpeaking() {
  window.electronAPI?.stopSpeaking?.();
  window.speechSynthesis?.cancel();
}
