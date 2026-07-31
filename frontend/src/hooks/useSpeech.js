import { useCallback, useEffect, useRef, useState } from 'react';
import { pipeline, env } from '@huggingface/transformers';
import { api } from '../lib/api.js';
import { speak as speakAloud } from '../services/speak.js';

// Disable local models fallback to avoid CORS issues if not properly set up;
// Let transformers.js pull directly from HuggingFace cache.
env.allowLocalModels = false;

function isElectron() {
  return navigator.userAgent.toLowerCase().includes('electron');
}

function hasWebSpeechAPI() {
  // Web Speech API doesn't work in Electron (needs Google servers + internet)
  if (isElectron()) return false;
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

export function useSpeech({ onTranscript, onError }) {
  const recorderRef = useRef(null);
  const recognitionRef = useRef(null);
  const transcriberRef = useRef(null);
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const useWebSpeech = hasWebSpeechAPI();
  const supported = useWebSpeech || Boolean(navigator.mediaDevices?.getUserMedia && window.AudioContext);

  // Initialize the local Whisper model in the background
  useEffect(() => {
    if (useWebSpeech) return; // Don't load whisper if native speech is available
    
    let isMounted = true;
    const loadModel = async () => {
      try {
        transcriberRef.current = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en', {
          device: 'webgpu' // Will fallback to wasm if webgpu isn't available
        });
      } catch (err) {
        console.warn("WebGPU not available, falling back to WASM for Whisper", err);
        if (isMounted) {
          transcriberRef.current = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en');
        }
      }
    };
    loadModel();
    return () => { isMounted = false; };
  }, [useWebSpeech]);

  // ── Web Speech API approach (browser only, needs internet) ───────────
  const startWebSpeech = useCallback(() => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';
    recognition.maxAlternatives = 1;

    let finalTranscript = '';
    let interimTranscript = '';

    recognition.onresult = (event) => {
      interimTranscript = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalTranscript += transcript + ' ';
        } else {
          interimTranscript = transcript;
        }
      }
      const combined = (finalTranscript + interimTranscript).trim();
      if (combined) onTranscript(combined);
    };

    recognition.onerror = (event) => {
      if (event.error === 'no-speech') {
        onError?.('No speech detected. Please speak clearly and try again.');
      } else if (event.error === 'not-allowed') {
        onError?.('Microphone permission was denied.');
      } else {
        onError?.(`Speech recognition error: ${event.error}`);
      }
      setListening(false);
    };

    recognition.onend = () => {
      setListening(false);
      const text = finalTranscript.trim();
      if (text) onTranscript(text);
    };

    recognitionRef.current = recognition;
    recognition.start();
    setListening(true);
  }, [onTranscript, onError]);

  const stopWebSpeech = useCallback(() => {
    const recognition = recognitionRef.current;
    if (recognition) {
      recognition.stop();
      recognitionRef.current = null;
    }
    setListening(false);
  }, []);

  // ── Local Whisper AI (Electron / fallback) ────────
  const stopRecording = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    setListening(false);
    setAudioLevel(0);
    recorderRef.current = null;

    recorder.source.disconnect();
    recorder.analyser.disconnect();
    recorder.stream.getTracks().forEach((track) => track.stop());
    await recorder.context.close();

    try {
      setTranscribing(true);
      
      // If the whisper model is loaded, do client-side inference!
      if (transcriberRef.current) {
        // Resample audio directly to 16kHz Float32Array
        const audioData = resampleTo16k(recorder.samples, recorder.sampleRate);
        const result = await transcriberRef.current(audioData, {
          chunk_length_s: 30,
          stride_length_s: 5
        });
        const text = Array.isArray(result) ? result[0].text : result.text;
        if (text?.trim()) onTranscript(text.trim());
        else onError?.('No speech detected. Please speak clearly and try again.');
      } else {
        // Ultimate fallback to backend PowerShell if model hasn't finished loading yet
        const wav = encodeWav(recorder.samples, recorder.sampleRate);
        const data = new FormData();
        data.append('audio', wav, 'speech.wav');
        const { data: result } = await api.post('/transcribe', data);
        if (result.text?.trim()) onTranscript(result.text.trim());
        else onError?.('No speech detected. Please speak clearly and try again.');
      }
    } catch (error) {
      onError?.(error.response?.data?.error || error.message);
    } finally {
      setTranscribing(false);
    }
  }, [onError, onTranscript]);

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      const context = new AudioContext();
      const source = context.createMediaStreamSource(stream);

      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      const updateLevel = () => {
        if (!recorderRef.current) return;
        analyser.getByteFrequencyData(dataArray);
        const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
        setAudioLevel(Math.min(1, avg / 128));
        requestAnimationFrame(updateLevel);
      };

      const processor = context.createScriptProcessor(4096, 1, 1);
      const samples = [];
      processor.onaudioprocess = (event) => {
        samples.push(new Float32Array(event.inputBuffer.getChannelData(0)));
      };
      source.connect(processor);
      processor.connect(context.destination);

      recorderRef.current = {
        stream, context, source, analyser, processor, samples,
        sampleRate: context.sampleRate
      };
      setListening(true);
      updateLevel();
    } catch (error) {
      onError?.(error.name === 'NotAllowedError' ? 'Microphone permission was denied.' : error.message);
    }
  }, [onError]);

  const toggleListening = useCallback(() => {
    if (transcribing) return;

    if (listening) {
      if (useWebSpeech) stopWebSpeech();
      else stopRecording();
    } else {
      if (useWebSpeech) startWebSpeech();
      else startRecording();
    }
  }, [listening, transcribing, useWebSpeech, startWebSpeech, stopWebSpeech, startRecording, stopRecording]);

  // Shared helper: it waits for the voice list before speaking. Firing straight
  // at speechSynthesis drops the utterance silently while voices are still
  // loading, which is why read-aloud produced no sound.
  const speak = useCallback((text) => {
    speakAloud(String(text || '').replace(/\[Source \d+\]/g, ''), { rate: 1, pitch: 1 });
  }, []);

  return { listening, transcribing, supported, audioLevel, toggleListening, speak, useWebSpeech, isModelReady: !!transcriberRef.current };
}

// ── Audio Resampling & WAV encoding ────────────
function resampleTo16k(buffers, sourceRate) {
  const source = mergeBuffers(buffers);
  const targetRate = 16000;
  if (Math.abs(sourceRate - targetRate) < 1) return source;
  const ratio = sourceRate / targetRate;
  const length = Math.round(source.length / ratio);
  const output = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const pos = i * ratio;
    const index = Math.floor(pos);
    const frac = pos - index;
    const a = source[index] || 0;
    const b = source[Math.min(index + 1, source.length - 1)] || 0;
    output[i] = a + frac * (b - a);
  }
  return output;
}

function encodeWav(buffers, sourceRate) {
  const output = resampleTo16k(buffers, sourceRate);
  const buffer = new ArrayBuffer(44 + output.length * 2);
  const view = new DataView(buffer);
  const targetRate = 16000;
  writeText(view, 0, 'RIFF'); view.setUint32(4, 36 + output.length * 2, true); writeText(view, 8, 'WAVE');
  writeText(view, 12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, targetRate, true); view.setUint32(28, targetRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  writeText(view, 36, 'data'); view.setUint32(40, output.length * 2, true);
  output.forEach((sample, index) => view.setInt16(44 + index * 2, Math.max(-1, Math.min(1, sample)) * 0x7fff, true));
  return new Blob([buffer], { type: 'audio/wav' });
}

function mergeBuffers(buffers) {
  const output = new Float32Array(buffers.reduce((total, buffer) => total + buffer.length, 0));
  let offset = 0;
  buffers.forEach((buffer) => { output.set(buffer, offset); offset += buffer.length; });
  return output;
}

function writeText(view, offset, text) {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
}
