/**
 * @module services/transcriber
 * @description Speech-to-text for recorded audio.
 *
 * Two engines, in order of preference:
 *
 *  1. Whisper (transformers.js), running locally in the renderer. Far more
 *     accurate than the Windows recogniser — that one turned "show me the
 *     network settings" into "Surely the network settings" on clean synthetic
 *     speech, and tends to return nothing at all for ordinary talking.
 *     The model must already be installed locally; no implicit download occurs.
 *
 *  2. The backend's Windows Speech Recognition route, used when Whisper cannot
 *     load — most likely a first run with no internet.
 */

import { pipeline, env } from '@huggingface/transformers';
import { blobToPcm16k, encodeWav } from './wav.js';
import * as apiService from './api.js';

// Voice remains offline on first run. Optional Whisper assets may be provided
// in public/models; Windows speech is retained when those assets are absent.
env.allowLocalModels = true;
env.allowRemoteModels = false;
env.localModelPath = new URL('models/', window.location.href).href;

let transcriberPromise = null;

/**
 * Load (once) the local Whisper pipeline. Resolves null when it cannot be
 * loaded, so callers can fall back rather than fail.
 *
 * @returns {Promise<Function|null>}
 */
function loadWhisper() {
  if (transcriberPromise) return transcriberPromise;

  transcriberPromise = (async () => {
    try {
      return await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en', {
        device: 'webgpu',
      });
    } catch {
      try {
        // WebGPU is not always available; WASM works everywhere, just slower.
        return await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en');
      } catch (err) {
        console.warn('Whisper unavailable, falling back to Windows speech:', err?.message);
        return null;
      }
    }
  })();

  return transcriberPromise;
}

/** Start fetching the model ahead of the first recording. */
export function warmUpTranscriber() {
  loadWhisper();
}

/**
 * Transcribe a recording.
 *
 * @param {Blob} recording - Whatever MediaRecorder produced.
 * @returns {Promise<{text: string, engine: 'whisper'|'windows'}>}
 */
export async function transcribe(recording) {
  const samples = await blobToPcm16k(recording);

  const whisper = await loadWhisper();
  if (whisper) {
    const result = await whisper(samples, {
      chunk_length_s: 30,
      stride_length_s: 5,
    });
    const text = (Array.isArray(result) ? result[0]?.text : result?.text) || '';
    return { text: text.trim(), engine: 'whisper' };
  }

  // Fallback: hand a real WAV to the backend's Windows recogniser.
  const formData = new FormData();
  formData.append('audio', encodeWav(samples, 16000), 'audio.wav');
  const response = await apiService.transcribe.audio(formData);
  return { text: (response.data?.text || '').trim(), engine: 'windows' };
}
