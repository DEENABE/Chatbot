import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Video, Square, Play, Pause, Download, Upload, Monitor, X, RefreshCw } from 'lucide-react';
import { useAppStore } from '../stores/useAppStore.js';
import { presets } from '../animations/presets.js';

export default function ScreenRecorder({ onClose }) {
  const settings = useAppStore((state) => state.settings);
  const uploadDocuments = useAppStore((state) => state.uploadDocuments);
  const fetchDocuments = useAppStore((state) => state.fetchDocuments);

  const [sources, setSources] = useState([]);
  const [selectedSource, setSelectedSource] = useState(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [recordedChunks, setRecordedChunks] = useState([]);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [timer, setTimer] = useState(0);
  const [isCapturingSources, setIsCapturingSources] = useState(false);
  const [isUploading, setIsUploading] = useState(false);

  const mediaRecorderRef = useRef(null);
  const streamRef = useRef(null);
  const timerIntervalRef = useRef(null);
  const accent = settings.accentColor || '#3b82f6';

  // Load screen capture sources on mount
  useEffect(() => {
    fetchSources();
    return () => {
      stopTracks();
      clearTimer();
    };
  }, []);

  const fetchSources = async () => {
    if (!window.electronAPI) return;
    setIsCapturingSources(true);
    try {
      const srcList = await window.electronAPI.getScreenSources();
      setSources(srcList);
    } catch (err) {
      console.error('Failed to get screen sources:', err);
    } finally {
      setIsCapturingSources(false);
    }
  };

  const stopTracks = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  };

  // Timer utilities
  const startTimer = () => {
    clearTimer();
    setTimer(0);
    timerIntervalRef.current = setInterval(() => {
      setTimer((t) => t + 1);
    }, 1000);
  };

  const clearTimer = () => {
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
  };

  const formatTime = (secs) => {
    const mins = Math.floor(secs / 60);
    const s = secs % 60;
    return `${mins}:${s < 10 ? '0' : ''}${s}`;
  };

  // Start recording the selected source
  const handleStartRecording = async (source) => {
    setSelectedSource(source);
    setPreviewUrl(null);
    setRecordedChunks([]);
    
    try {
      // Get capture stream
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false, // system audio defaults to false to avoid capture locks
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: source.id
          }
        }
      });

      streamRef.current = stream;
      
      const recorder = new MediaRecorder(stream, { mimeType: 'video/webm; codecs=vp9' });
      mediaRecorderRef.current = recorder;

      const chunks = [];
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          chunks.push(e.data);
        }
      };

      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: 'video/webm' });
        setRecordedChunks(chunks);
        const url = URL.createObjectURL(blob);
        setPreviewUrl(url);
        stopTracks();
        clearTimer();
        setIsRecording(false);
        setIsPaused(false);
      };

      recorder.start(1000); // chunk every 1 sec
      setIsRecording(true);
      setIsPaused(false);
      startTimer();
    } catch (err) {
      console.error('Failed to start screen recording:', err);
      alert('Could not start screen capture: ' + err.message);
    }
  };

  const handlePauseRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.pause();
      setIsPaused(true);
      clearTimer();
    }
  };

  const handleResumeRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.resume();
      setIsPaused(false);
      // Resume timer
      timerIntervalRef.current = setInterval(() => {
        setTimer((t) => t + 1);
      }, 1000);
    }
  };

  const handleStopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
    }
  };

  // Convert blob chunks to Base64 and prompt save dialog
  const handleSaveFile = async () => {
    if (recordedChunks.length === 0) return;
    const blob = new Blob(recordedChunks, { type: 'video/webm' });
    
    const reader = new FileReader();
    reader.readAsDataURL(blob);
    reader.onloadend = async () => {
      const base64 = reader.result.split(',')[1];
      if (window.electronAPI) {
        const defaultName = `nova_screen_rec_${Date.now()}.webm`;
        const res = await window.electronAPI.saveFile(defaultName, base64);
        if (res && res.success) {
          window.electronAPI.showNotification('Recording Saved', `File saved successfully to ${res.filePath}`);
        }
      }
    };
  };

  // Upload video blob to AI local memory
  const handleUploadToAI = async () => {
    if (recordedChunks.length === 0) return;
    const blob = new Blob(recordedChunks, { type: 'video/webm' });
    const file = new File([blob], `screen_rec_${Date.now()}.webm`, { type: 'video/webm' });
    
    setIsUploading(true);
    try {
      await uploadDocuments([file]);
      fetchDocuments(); // Refresh knowledge base
      if (window.electronAPI) {
        window.electronAPI.showNotification('AI Memory Added', 'Screen recording uploaded and indexed by local RAG.');
      }
      alert('Screen recording uploaded successfully to your offline knowledge base.');
    } catch (err) {
      console.error('Failed to upload screen recording:', err);
      alert('Upload failed: ' + err.message);
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-[#0c0c0e]/95 text-stone-200 select-none overflow-y-auto">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-white/5 p-4 shrink-0">
        <div className="flex items-center gap-2">
          <Video size={16} style={{ color: accent }} className={isRecording ? 'animate-pulse' : ''} />
          <span className="text-xs font-bold uppercase tracking-wider text-stone-300">Chanakya Screen Recorder</span>
        </div>
        <button
          onClick={onClose}
          className="p-1 rounded-lg hover:bg-white/5 text-stone-500 hover:text-stone-300 transition-colors"
        >
          <X size={15} />
        </button>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 p-4 flex flex-col gap-4 min-h-0">
        
        {/* State 1: Active recording overlay */}
        {isRecording && (
          <div className="flex-grow flex flex-col items-center justify-center bg-black/40 border border-white/5 rounded-2xl p-6 text-center gap-4">
            <div className="relative">
              <div className="w-16 h-16 rounded-full flex items-center justify-center bg-red-500/10 border-2 border-red-500/20">
                <div className={`w-6 h-6 rounded-full bg-red-500 ${isPaused ? 'opacity-50' : 'animate-ping'}`} />
              </div>
              {!isPaused && (
                <div className="absolute inset-0 w-16 h-16 rounded-full bg-red-500 opacity-20 animate-pulse pointer-events-none" />
              )}
            </div>

            <div>
              <div className="text-xl font-mono font-bold tracking-widest text-white">{formatTime(timer)}</div>
              <div className="text-[10px] text-stone-500 mt-1 uppercase tracking-widest">
                {isPaused ? 'Recording Paused' : `Recording: ${selectedSource?.name}`}
              </div>
            </div>

            <div className="flex items-center gap-3">
              {isPaused ? (
                <button
                  onClick={handleResumeRecording}
                  className="flex items-center gap-1.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-stone-200 border border-white/10 px-3 py-1.5 text-xs font-bold transition-all"
                >
                  <Play size={12} />
                  Resume
                </button>
              ) : (
                <button
                  onClick={handlePauseRecording}
                  className="flex items-center gap-1.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-stone-200 border border-white/10 px-3 py-1.5 text-xs font-bold transition-all"
                >
                  <Pause size={12} />
                  Pause
                </button>
              )}
              <button
                onClick={handleStopRecording}
                className="flex items-center gap-1.5 rounded-xl bg-red-600 hover:bg-red-500 text-white px-4 py-1.5 text-xs font-bold transition-all"
              >
                <Square size={11} fill="currentColor" />
                Stop
              </button>
            </div>
          </div>
        )}

        {/* State 2: Preview of recorded clip */}
        {!isRecording && previewUrl && (
          <div className="flex-grow flex flex-col gap-3 min-h-0">
            <div className="relative border border-white/10 bg-black rounded-2xl overflow-hidden flex-1 flex items-center justify-center">
              <video
                src={previewUrl}
                controls
                className="max-w-full max-h-full object-contain"
              />
            </div>
            
            <div className="flex items-center gap-3 shrink-0">
              <button
                onClick={() => { setPreviewUrl(null); setSelectedSource(null); }}
                className="flex-1 rounded-xl bg-zinc-800 hover:bg-zinc-700 border border-white/10 text-stone-300 py-2 text-xs font-bold transition-all"
              >
                Discard
              </button>
              <button
                onClick={handleSaveFile}
                className="flex-1 flex items-center justify-center gap-1.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 border border-white/10 text-stone-300 py-2 text-xs font-bold transition-all"
              >
                <Download size={13} />
                Save Local
              </button>
              <button
                onClick={handleUploadToAI}
                disabled={isUploading}
                className="flex-1 flex items-center justify-center gap-1.5 rounded-xl text-black py-2 text-xs font-bold transition-all disabled:opacity-40"
                style={{ backgroundColor: accent }}
              >
                {isUploading ? (
                  <RefreshCw size={13} className="animate-spin" />
                ) : (
                  <Upload size={13} />
                )}
                Index to AI
              </button>
            </div>
          </div>
        )}

        {/* State 3: Display captures source grid for selection */}
        {!isRecording && !previewUrl && (
          <div className="flex-grow flex flex-col gap-3 min-h-0">
            <div className="flex items-center justify-between shrink-0">
              <span className="text-[10px] uppercase font-bold text-stone-500 tracking-wider">Choose screen or window</span>
              <button
                onClick={fetchSources}
                disabled={isCapturingSources}
                className="text-[10px] text-stone-400 hover:text-white flex items-center gap-1"
              >
                <RefreshCw size={10} className={isCapturingSources ? 'animate-spin' : ''} />
                Refresh
              </button>
            </div>

            {isCapturingSources ? (
              <div className="flex-1 flex items-center justify-center">
                <RefreshCw size={24} className="animate-spin text-stone-600" />
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto pr-1">
                {sources.length === 0 ? (
                  <div className="text-center text-xs text-stone-500 py-10">No capture feeds found.</div>
                ) : (
                  <div className="grid grid-cols-2 gap-3 pb-2">
                    {sources.map((src) => (
                      <motion.div
                        key={src.id}
                        onClick={() => handleStartRecording(src)}
                        className="group border border-white/5 bg-[#141416] hover:border-white/15 rounded-xl p-2 cursor-pointer transition-colors flex flex-col gap-2 relative overflow-hidden"
                        whileHover={{ scale: 1.02 }}
                        transition={presets.appleBounce}
                      >
                        {/* Thumbnail preview */}
                        <div className="aspect-video w-full rounded-lg overflow-hidden border border-white/5 bg-black relative">
                          <img
                            src={src.thumbnail}
                            alt={src.name}
                            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                          />
                          <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                            <Play size={20} className="text-white fill-white drop-shadow-md" />
                          </div>
                        </div>
                        
                        {/* Source details */}
                        <div className="flex items-center gap-1.5 min-w-0">
                          <Monitor size={10} className="text-stone-500 shrink-0" />
                          <span className="text-[10px] font-medium text-stone-300 truncate w-full">
                            {src.name}
                          </span>
                        </div>
                      </motion.div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
