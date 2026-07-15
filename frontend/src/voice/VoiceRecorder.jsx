import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Mic, Square, Pause, Play, LoaderCircle, RefreshCw } from 'lucide-react';
import { useAppStore } from '../stores/useAppStore.js';
import * as apiService from '../services/api.js';

export default function VoiceRecorder({ onTranscription, audioSource = 'mic' }) {
  const settings = useAppStore((state) => state.settings);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [timer, setTimer] = useState(0);

  const mediaRecorderRef = useRef(null);
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const animationRef = useRef(null);
  const timerIntervalRef = useRef(null);
  const chunksRef = useRef([]);

  const canvasRef = useRef(null);
  const accent = settings.accentColor || '#3b82f6';
  const isElectron = window.electronAPI !== undefined;

  useEffect(() => {
    return () => {
      stopRecordingImmediate();
    };
  }, []);

  const formatTimer = (secs) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  const startTimer = () => {
    setTimer(0);
    timerIntervalRef.current = setInterval(() => {
      setTimer((t) => t + 1);
    }, 1000);
  };

  const stopTimer = () => {
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
  };

  // Immediate cleanup
  const stopRecordingImmediate = () => {
    stopTimer();
    if (animationRef.current) {
      cancelAnimationFrame(animationRef.current);
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
    }
  };

  const startRecording = async () => {
    chunksRef.current = [];
    try {
      let stream;
      if (audioSource === 'system' && isElectron) {
        const sources = await window.electronAPI.getScreenSources();
        const screenSource = sources.find(src => src.id.startsWith('screen:')) || sources[0];
        if (!screenSource) throw new Error('No system audio source found.');

        const rawStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: screenSource.id
            }
          },
          video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: screenSource.id
            }
          }
        });
        
        // Keep audio track only
        const audioTracks = rawStream.getAudioTracks();
        if (audioTracks.length === 0) {
          rawStream.getTracks().forEach(track => track.stop());
          throw new Error('No system audio track detected.');
        }
        rawStream.getVideoTracks().forEach(track => track.stop());
        stream = new MediaStream(audioTracks);
      } else {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }

      // Initialize Web Audio API Analyser for Waveform drawing
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 64; // Fast, lightweight frequency bins
      source.connect(analyser);

      audioContextRef.current = audioCtx;
      analyserRef.current = analyser;

      // Start Media Recorder
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };

      recorder.onstop = async () => {
        stopTimer();
        if (animationRef.current) cancelAnimationFrame(animationRef.current);
        
        // Stop all media tracks
        stream.getTracks().forEach(t => t.stop());
        if (audioCtx) audioCtx.close().catch(() => {});

        if (chunksRef.current.length === 0) {
          setIsRecording(false);
          return;
        }

        const blob = new Blob(chunksRef.current, { type: 'audio/wav' });
        const formData = new FormData();
        formData.append('audio', blob, 'audio.wav');

        setIsTranscribing(true);
        try {
          const res = await apiService.transcribe.audio(formData);
          if (res.data && res.data.text) {
            onTranscription(res.data.text);
          }
        } catch (err) {
          console.error('Speech recognition route failed:', err);
        } finally {
          setIsTranscribing(false);
          setIsRecording(false);
        }
      };

      recorder.start();
      setIsRecording(true);
      startTimer();
      
      // Start painting frequencies
      setTimeout(drawWaveform, 100);

    } catch (err) {
      console.error('Microphone capture failed:', err);
      alert('Microphone setup failed: ' + err.message);
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
    }
  };

  // Waveform Renderer
  const drawWaveform = () => {
    if (!canvasRef.current || !analyserRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const analyser = analyserRef.current;
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const draw = () => {
      if (!canvasRef.current) return;
      animationRef.current = requestAnimationFrame(draw);

      analyser.getByteFrequencyData(dataArray);

      const width = canvas.width;
      const height = canvas.height;
      ctx.clearRect(0, 0, width, height);

      const centerY = height / 2;
      const barWidth = (width / bufferLength) * 1.5;
      let x = 0;

      // Enable a glowing shadow effect matching current accent
      ctx.shadowBlur = 6;
      ctx.shadowColor = accent;

      for (let i = 0; i < bufferLength; i++) {
        // Normalize frequency values
        const percent = dataArray[i] / 255;
        const barHeight = Math.max(3, percent * centerY * 0.85);

        // Gradient color for premium feel
        const gradient = ctx.createLinearGradient(0, centerY - barHeight, 0, centerY + barHeight);
        gradient.addColorStop(0, accent);
        gradient.addColorStop(0.5, '#ffffff');
        gradient.addColorStop(1, accent);

        ctx.fillStyle = gradient;

        // Draw symmetrical rounded bars
        const rx = x;
        const ry = centerY - barHeight;
        const rw = barWidth - 1.5;
        const rh = barHeight * 2;

        ctx.beginPath();
        if (ctx.roundRect) {
          ctx.roundRect(rx, ry, rw, rh, 2);
        } else {
          ctx.rect(rx, ry, rw, rh);
        }
        ctx.fill();

        x += barWidth;
      }
    };

    draw();
  };

  return (
    <div className="flex flex-col items-center gap-3 w-full bg-[#121214]/95 border border-white/5 rounded-2xl p-4 shadow-2xl relative overflow-hidden">
      {/* Waveform Canvas */}
      <div className="w-full h-14 relative flex items-center justify-center bg-black/20 rounded-xl overflow-hidden px-2">
        {isRecording ? (
          <canvas ref={canvasRef} width={280} height={56} className="w-full h-full block" />
        ) : isTranscribing ? (
          <div className="flex items-center gap-2 text-xs text-stone-400">
            <LoaderCircle size={14} className="animate-spin" style={{ color: accent }} />
            <span>Decoding voice capture offline...</span>
          </div>
        ) : (
          <span className="text-[11px] text-stone-500 font-medium">Ready to capture voice input</span>
        )}
      </div>

      {/* Control Row */}
      <div className="flex items-center justify-between w-full">
        <div className="flex items-center gap-2">
          <div className={`w-2.5 h-2.5 rounded-full ${isRecording ? 'bg-red-500 animate-pulse' : 'bg-stone-600'}`} />
          <span className="text-[10px] font-bold text-stone-400 tracking-wider uppercase">
            {isRecording ? `REC (${formatTimer(timer)})` : 'OFFLINE mic'}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {isRecording ? (
            <button
              onClick={stopRecording}
              className="flex items-center gap-1 bg-red-600 hover:bg-red-500 text-white rounded-xl px-3 py-1.5 text-[11px] font-bold transition-all shadow-md"
            >
              <Square size={11} fill="currentColor" />
              Stop Recording
            </button>
          ) : (
            <button
              onClick={startRecording}
              disabled={isTranscribing}
              className="flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-[11px] font-bold text-black transition-all shadow-md disabled:opacity-40"
              style={{ backgroundColor: accent }}
            >
              <Mic size={12} />
              Start Speak
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
