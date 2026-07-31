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
  if (!text || !('speechSynthesis' in window)) return false;

  const synth = window.speechSynthesis;
  const voices = await loadVoices();

  synth.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = rate;
  utterance.pitch = pitch;

  const voice = pickVoice(voices);
  if (voice) {
    utterance.voice = voice;
    utterance.lang = voice.lang;
  }

  synth.speak(utterance);
  return true;
}

/** Stop anything currently being spoken. */
export function stopSpeaking() {
  window.speechSynthesis?.cancel();
}
