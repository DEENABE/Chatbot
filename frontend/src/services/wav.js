/**
 * @module services/wav
 * @description Turns recorded audio into the WAV the Windows speech engine can
 * actually read.
 *
 * MediaRecorder hands back WebM/Opus on Chromium. Labelling that blob
 * "audio/wav" does not change the bytes, so the recogniser was being given a
 * container it cannot decode and simply returned nothing. These helpers decode
 * the recording and re-encode it as 16 kHz mono 16-bit PCM.
 */

/** The sample rate Windows speech recognition expects. */
const TARGET_RATE = 16000;

/**
 * Resample mono float samples to 16 kHz with linear interpolation.
 *
 * @param {Float32Array} samples
 * @param {number} sourceRate
 * @returns {Float32Array}
 */
export function resampleTo16k(samples, sourceRate) {
  if (Math.abs(sourceRate - TARGET_RATE) < 1) return samples;
  const ratio = sourceRate / TARGET_RATE;
  const length = Math.round(samples.length / ratio);
  const output = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const pos = i * ratio;
    const index = Math.floor(pos);
    const frac = pos - index;
    const a = samples[index] || 0;
    const b = samples[Math.min(index + 1, samples.length - 1)] || 0;
    output[i] = a + frac * (b - a);
  }
  return output;
}

/**
 * Encode mono float samples as a 16-bit PCM WAV blob.
 *
 * @param {Float32Array} samples - Mono samples in the -1..1 range.
 * @param {number} sourceRate - Sample rate of `samples`.
 * @returns {Blob}
 */
export function encodeWav(samples, sourceRate) {
  const pcm = resampleTo16k(samples, sourceRate);
  const buffer = new ArrayBuffer(44 + pcm.length * 2);
  const view = new DataView(buffer);

  const writeText = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeText(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length * 2, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true);        // PCM chunk size
  view.setUint16(20, 1, true);         // format: PCM
  view.setUint16(22, 1, true);         // channels: mono
  view.setUint32(24, TARGET_RATE, true);
  view.setUint32(28, TARGET_RATE * 2, true); // byte rate
  view.setUint16(32, 2, true);         // block align
  view.setUint16(34, 16, true);        // bits per sample
  writeText(36, 'data');
  view.setUint32(40, pcm.length * 2, true);

  for (let i = 0; i < pcm.length; i += 1) {
    view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

/**
 * Flatten a multi-channel AudioBuffer to mono by averaging its channels.
 *
 * @param {AudioBuffer} audioBuffer
 * @returns {Float32Array}
 */
function toMono(audioBuffer) {
  const channels = audioBuffer.numberOfChannels;
  if (channels === 1) return audioBuffer.getChannelData(0);

  const length = audioBuffer.length;
  const mono = new Float32Array(length);
  for (let c = 0; c < channels; c += 1) {
    const data = audioBuffer.getChannelData(c);
    for (let i = 0; i < length; i += 1) mono[i] += data[i] / channels;
  }
  return mono;
}

/**
 * Decode any recorded audio blob (WebM/Opus, MP4, …) and re-encode it as a WAV
 * the speech recogniser accepts.
 *
 * @param {Blob} blob - Whatever MediaRecorder produced.
 * @returns {Promise<Blob>} A real 16 kHz mono PCM WAV.
 */
export async function blobToWav(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const context = new (window.AudioContext || window.webkitAudioContext)();
  try {
    const audioBuffer = await context.decodeAudioData(arrayBuffer);
    return encodeWav(toMono(audioBuffer), audioBuffer.sampleRate);
  } finally {
    context.close().catch(() => {});
  }
}
