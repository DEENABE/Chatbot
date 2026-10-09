import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowUp,
  LoaderCircle,
  Mic,
  Paperclip,
  Square,
  Monitor,
  X,
  Camera,
  Crop,
  Video,
  Wrench,
  FileText,
  Image as ImageIcon,
} from 'lucide-react';
import { useAppStore } from '../stores/useAppStore.js';
import * as apiService from '../services/api.js';
import VoiceRecorder from '../voice/VoiceRecorder.jsx';
import ScreenRecorder from '../screen/ScreenRecorder.jsx';
import { presets } from '../animations/presets.js';
import { ATTACHMENT_ACCEPT, formatBytes } from '../utils/attachments.js';

export default function InputArea() {
  const [showVoicePanel, setShowVoicePanel] = useState(false);
  const [showVideoPanel, setShowVideoPanel] = useState(false);
  const [audioSource, setAudioSource] = useState('mic'); // 'mic' or 'system'
  const [showCameraPreview, setShowCameraPreview] = useState(false);
  const [uploadError, setUploadError] = useState('');
  // Enter pressed while files are still uploading: the message is sent the moment they are ready.
  const [sendQueued, setSendQueued] = useState(false);
  const sendQueuedRef = useRef(false);

  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);

  const isGenerating = useAppStore((state) => state.isGenerating);
  const sendMessage = useAppStore((state) => state.sendMessage);
  const stopGeneration = useAppStore((state) => state.stopGeneration);
  const stageAttachments = useAppStore((state) => state.stageAttachments);
  const pendingAttachments = useAppStore((state) => state.pendingAttachments);
  const removeAttachment = useAppStore((state) => state.removeAttachment);
  const consumeAttachments = useAppStore((state) => state.consumeAttachments);
  const settings = useAppStore((state) => state.settings);
  const setOcrScreenshot = useAppStore((state) => state.setOcrScreenshot);
  const clipboardToastText = useAppStore((state) => state.clipboardToastText);
  const showClipboardToast = useAppStore((state) => state.showClipboardToast);
  const inputText = useAppStore((state) => state.inputText);
  const setInputText = useAppStore((state) => state.setInputText);
  const autoRepairMode = useAppStore((state) => state.autoRepairMode);
  const toggleAutoRepair = useAppStore((state) => state.toggleAutoRepair);

  // Synchronized screen capture in Zustand store
  const pendingScreenCapture = useAppStore((state) => state.pendingScreenCapture);
  const setPendingScreenCapture = useAppStore((state) => state.setPendingScreenCapture);
  const bubbleAction = useAppStore((state) => state.bubbleAction);
  const setBubbleAction = useAppStore((state) => state.setBubbleAction);

  const accent = settings.accentColor || '#3b82f6';
  const isElectron = window.electronAPI !== undefined;

  // Auto adjust textarea height based on typing length
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(150, textareaRef.current.scrollHeight)}px`;
    }
  }, [inputText]);

  // Auto-trigger voice/video panels from bubble quick actions
  useEffect(() => {
    if (bubbleAction === 'voice') {
      setShowVoicePanel(true);
      setShowVideoPanel(false);
      setBubbleAction(null);
    } else if (bubbleAction === 'record') {
      setShowVideoPanel(true);
      setShowVoicePanel(false);
      setBubbleAction(null);
    }
  }, [bubbleAction, setBubbleAction]);

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 480, height: 360 },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
      setShowCameraPreview(true);
    } catch (err) {
      alert('Camera access failed: ' + err);
    }
  };

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    setShowCameraPreview(false);
  };

  const capturePhoto = () => {
    if (videoRef.current) {
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 480;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/png');
        setPendingScreenCapture({ image: dataUrl, windows: [] });
      }
      stopCamera();
    }
  };

  const handleCaptureOcr = async () => {
    if (!isElectron) return;
    try {
      const data = await window.electronAPI.captureScreen();
      if (data && data.image) {
        setOcrScreenshot(data.image);
      }
    } catch (err) {
      console.error('Failed OCR screen capture:', err);
    }
  };

  const hasNewInput = !!inputText.trim() || !!pendingScreenCapture || pendingAttachments.length > 0;
  const showStop = isGenerating && !hasNewInput;
  const hasFailedUpload = pendingAttachments.some((entry) => entry.status === 'error');

  // A notice never lingers: it goes away on its own, and as soon as the failed file is removed.
  useEffect(() => {
    if (uploadError && !hasFailedUpload && !sendQueued) {
      const timer = setTimeout(() => setUploadError(''), 5000);
      return () => clearTimeout(timer);
    }
  }, [uploadError, hasFailedUpload, sendQueued]);
  useEffect(() => {
    if (!hasFailedUpload)
      setUploadError((current) => (/remove it and send again/i.test(current) ? '' : current));
  }, [hasFailedUpload]);

  const waitForUploads = () =>
    new Promise((resolve) => {
      if (!useAppStore.getState().isUploadingAttachments) return resolve();
      const unsubscribe = useAppStore.subscribe((state) => {
        if (!state.isUploadingAttachments) {
          unsubscribe();
          resolve();
        }
      });
    });

  const handleSend = async () => {
    if (!hasNewInput && !isGenerating) return;

    // Nothing new typed while an answer streams: the button / Enter means "stop".
    // With a new question typed, sendMessage interrupts the running answer and asks it.
    if (isGenerating && !hasNewInput) {
      stopGeneration();
      return;
    }

    if (sendQueuedRef.current) return;
    // Files still uploading: wait for them and send automatically instead of refusing.
    if (useAppStore.getState().isUploadingAttachments) {
      sendQueuedRef.current = true;
      setSendQueued(true);
      setUploadError('');
      try {
        await waitForUploads();
      } finally {
        sendQueuedRef.current = false;
        setSendQueued(false);
      }
    }
    const fresh = useAppStore.getState();
    const failed = fresh.pendingAttachments.find((entry) => entry.status !== 'ready');
    if (failed) {
      setUploadError(
        `${failed.name}: ${failed.error || 'could not be uploaded'} — remove it and send again.`,
      );
      return;
    }
    setUploadError('');
    const typed = fresh.inputText.trim();
    const screenCapture = fresh.pendingScreenCapture;
    if (!typed && !screenCapture && !fresh.pendingAttachments.length) return;
    const attachments = consumeAttachments();
    const content = typed || (attachments.length ? 'Summarize the attached documents.' : '');
    setInputText('');
    const capture = screenCapture ? { ...screenCapture } : undefined;
    setPendingScreenCapture(null);

    await sendMessage(content, capture, null, attachments);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleCaptureScreen = async () => {
    if (!isElectron) return;
    try {
      const data = await window.electronAPI.captureScreen();
      setPendingScreenCapture(data);
    } catch (err) {
      console.error('Failed screen capture:', err);
    }
  };

  const handleUploadFile = async (e) => {
    if (e.target.files && e.target.files.length > 0) {
      try {
        setUploadError('');
        await stageAttachments(e.target.files);
      } catch (err) {
        setUploadError(err.message || 'Files could not be uploaded.');
      }
    }
    e.target.value = '';
  };

  const handleTranscriptionSuccess = (text) => {
    setInputText(inputText + (inputText ? ' ' : '') + text);
    setShowVoicePanel(false);
  };

  return (
    <div className="shrink-0 px-3 pb-3 sm:px-4 sm:pb-4">
      <div className="mx-auto max-w-2xl flex flex-col gap-2">
        {/* Floating Clipboard Explainer Notification */}
        <AnimatePresence>
          {clipboardToastText && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 10 }}
              className="p-3 rounded-2xl border border-white/5 bg-[#121214]/95 backdrop-blur-md shadow-2xl flex items-center justify-between gap-3 text-xs"
            >
              <div className="flex-1 min-w-0">
                <span className="text-stone-500 font-bold uppercase tracking-wider text-[9px] block">
                  Clipboard Text Detected
                </span>
                <p className="text-stone-300 truncate text-[11px] mt-0.5">"{clipboardToastText}"</p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    setInputText(`Explain this clipboard content:\n\n${clipboardToastText}`);
                    showClipboardToast(null);
                  }}
                  className="rounded-xl px-2.5 py-1 text-[10px] font-bold text-black hover:scale-105 active:scale-95 transition-all shadow-md cursor-pointer"
                  style={{ backgroundColor: accent }}
                >
                  Explain with AI
                </button>
                <button
                  onClick={() => showClipboardToast(null)}
                  className="p-1 rounded-lg hover:bg-white/5 text-stone-500 hover:text-stone-300 transition-colors cursor-pointer"
                >
                  <X size={12} />
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Inline Drawer Panels: Voice / Video Screen Recorder */}
        <AnimatePresence mode="wait">
          {showVoicePanel && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="overflow-hidden"
            >
              <VoiceRecorder
                audioSource={audioSource}
                onTranscription={handleTranscriptionSuccess}
              />
            </motion.div>
          )}

          {showVideoPanel && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 320, opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              style={{ maxHeight: '40vh' }}
              className="overflow-y-auto overflow-x-hidden border border-white/5 rounded-2xl bg-[#0c0c0e]/90 backdrop-blur-md shadow-2xl"
            >
              <ScreenRecorder onClose={() => setShowVideoPanel(false)} />
            </motion.div>
          )}
        </AnimatePresence>

        {/* Main Input Text Area */}
        <div
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes('Files')) event.preventDefault();
          }}
          onDrop={async (event) => {
            if (!event.dataTransfer.files?.length) return;
            event.preventDefault();
            setUploadError('');
            try {
              await stageAttachments(event.dataTransfer.files);
            } catch (error) {
              setUploadError(error.message);
            }
          }}
          className="rounded-2xl border bg-[#121214]/90 p-2 shadow-2xl transition-colors duration-300"
          style={{ borderColor: 'rgba(255, 255, 255, 0.05)' }}
        >
          {pendingAttachments.length > 0 && (
            <div
              className="flex max-h-28 flex-wrap gap-2 overflow-y-auto px-2 pt-2 pb-1"
              aria-live="polite"
            >
              {pendingAttachments.map((entry) => (
                <div
                  key={entry.clientId}
                  className="max-w-full flex items-start gap-2 rounded-xl border border-white/10 bg-white/[0.03] p-2 text-xs"
                >
                  {entry.mediaType === 'image' ||
                  /^image\//.test(entry.mimeType || '') ||
                  /\.(png|jpe?g|webp)$/i.test(entry.name) ? (
                    <ImageIcon size={16} className="mt-0.5 shrink-0 text-stone-400" />
                  ) : (
                    <FileText size={16} className="mt-0.5 shrink-0 text-stone-400" />
                  )}
                  <div className="min-w-0 max-w-[240px]">
                    <div className="truncate text-stone-200" title={entry.name}>
                      {entry.name}
                    </div>
                    <div
                      className={
                        entry.error ? 'text-red-300 text-[10px]' : 'text-stone-500 text-[10px]'
                      }
                    >
                      {entry.error ||
                        (entry.status === 'ready'
                          ? `${formatBytes(entry.size)} · Ready for this message`
                          : entry.status === 'queued'
                            ? 'Waiting to upload'
                            : entry.progress >= 99
                              ? 'Reading document…'
                              : `Uploading ${entry.progress}%`)}
                    </div>
                    {entry.warning && (
                      <div className="text-amber-300 text-[10px]">{entry.warning}</div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => removeAttachment(entry.clientId)}
                    aria-label={`Remove ${entry.name}`}
                    className="shrink-0 rounded p-1 text-stone-400 hover:text-white"
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {sendQueued && (
            <p role="status" className="px-3 py-1 text-xs text-stone-400">
              Uploading your file… the message will be sent as soon as it is ready.
            </p>
          )}
          {uploadError && !sendQueued && (
            <p role="alert" className="px-3 py-1 text-xs text-red-300">
              {uploadError}
            </p>
          )}
          {/* Screenshot/Vision Preview */}
          <AnimatePresence>
            {pendingScreenCapture && (
              <motion.div
                initial={{ opacity: 0, scale: 0.95, height: 0 }}
                animate={{ opacity: 1, scale: 1, height: 'auto' }}
                exit={{ opacity: 0, scale: 0.95, height: 0 }}
                className="px-2 pb-2"
              >
                <div className="relative inline-block group">
                  <img
                    src={pendingScreenCapture.image}
                    alt="Screen Share Preview"
                    className="h-16 w-28 rounded-lg object-cover border border-white/10"
                  />
                  <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity rounded-lg flex items-center justify-center pointer-events-none">
                    <span className="text-[9px] text-stone-300 font-semibold uppercase tracking-wider">
                      Vision active
                    </span>
                  </div>
                  <button
                    onClick={() => setPendingScreenCapture(null)}
                    type="button"
                    className="absolute -right-2 -top-2 rounded-full bg-[#09090a] p-1 text-stone-400 hover:text-white border border-white/10 shadow-md cursor-pointer"
                  >
                    <X size={10} />
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Camera Viewfinder Preview */}
          <AnimatePresence>
            {showCameraPreview && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="px-2 pb-2 flex flex-col items-center gap-2"
              >
                <div className="relative border border-white/10 rounded-xl overflow-hidden bg-black max-w-sm w-full shadow-2xl">
                  <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    className="w-full h-auto max-h-40 object-cover transform -scale-x-100"
                  />
                  <div className="absolute bottom-2 left-2 right-2 flex justify-between gap-2">
                    <button
                      onClick={capturePhoto}
                      className="rounded-lg px-2.5 py-1 text-[10px] font-bold text-black shadow-md hover:scale-105 transition-all cursor-pointer"
                      style={{ backgroundColor: accent }}
                    >
                      Snap Photo
                    </button>
                    <button
                      onClick={stopCamera}
                      className="rounded-lg px-2.5 py-1 text-[10px] font-bold bg-zinc-800 text-white border border-white/5 shadow-md hover:bg-zinc-700 transition-all cursor-pointer"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Textbox Input */}
          <textarea
            ref={textareaRef}
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            placeholder={
              isGenerating
                ? 'Chanakya is reasoning… type a new question and press Enter to interrupt'
                : autoRepairMode
                  ? 'Describe the PC problem to auto-fix — e.g. "bluetooth is off, turn it on"'
                  : pendingAttachments.length === 1
                    ? 'Ask about this document…'
                    : pendingAttachments.length > 1
                      ? 'Ask about these documents…'
                      : 'Message Chanakya AI...'
            }
            className="max-h-40 min-h-[44px] w-full resize-none bg-transparent px-3 py-2 text-xs text-stone-200 outline-none placeholder:text-stone-600 border-0 focus:ring-0 leading-5"
          />

          {/* Buttons bar */}
          <div className="flex items-center justify-between gap-2 px-1 pb-1">
            <div className="flex flex-wrap items-center gap-1">
              {/* Auto-Repair mode toggle */}
              <button
                type="button"
                onClick={toggleAutoRepair}
                title={
                  autoRepairMode
                    ? 'Auto-Repair ON — describe a PC problem and it will diagnose & fix automatically'
                    : 'Turn on Auto-Repair (autonomous diagnose & fix)'
                }
                className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-[10px] font-semibold transition-colors cursor-pointer"
                style={{
                  color: autoRepairMode ? '#000' : '#78716c',
                  background: autoRepairMode ? accent : 'transparent',
                }}
              >
                <Wrench size={14} />
                {autoRepairMode && <span>Auto-Repair</span>}
              </button>

              {/* File Upload Attachment */}
              <label
                role="button"
                tabIndex={0}
                aria-label="Attach files to this chat message"
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    fileInputRef.current?.click();
                  }
                }}
                className="rounded-lg p-2 text-stone-500 hover:bg-white/5 hover:text-white transition-colors cursor-pointer"
                title="Attach files to this chat message"
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept={ATTACHMENT_ACCEPT}
                  onChange={handleUploadFile}
                  className="hidden"
                />
                <Paperclip size={15} />
              </label>

              {/* Camera Trigger */}
              <button
                onClick={showCameraPreview ? stopCamera : startCamera}
                title="Use webcam photo"
                className="rounded-lg p-2 hover:bg-white/5 transition-colors cursor-pointer"
                style={{ color: showCameraPreview ? accent : '#78716c' }}
              >
                <Camera size={15} />
              </button>

              {/* Screenshot capture */}
              {isElectron && (
                <button
                  onClick={handleCaptureScreen}
                  title="Snap active desktop window"
                  className="rounded-lg p-2 text-stone-500 hover:bg-white/5 hover:text-white transition-colors cursor-pointer"
                >
                  <Monitor size={15} />
                </button>
              )}

              {/* Screen OCR / Markup Cropper */}
              {isElectron && (
                <button
                  onClick={handleCaptureOcr}
                  title="Crop selection & Markup screenshot"
                  className="rounded-lg p-2 text-stone-500 hover:bg-white/5 hover:text-white transition-colors cursor-pointer"
                >
                  <Crop size={15} />
                </button>
              )}

              {/* Screen Recorder trigger */}
              {isElectron && (
                <button
                  onClick={() => {
                    setShowVideoPanel(!showVideoPanel);
                    setShowVoicePanel(false);
                  }}
                  title="Record screen feed video"
                  className="rounded-lg p-2 hover:bg-white/5 transition-colors cursor-pointer"
                  style={{ color: showVideoPanel ? accent : '#78716c' }}
                >
                  <Video size={15} />
                </button>
              )}

              {/* Voice Speech panel trigger */}
              <button
                type="button"
                onClick={() => {
                  setShowVoicePanel(!showVoicePanel);
                  setShowVideoPanel(false);
                }}
                className="relative rounded-lg p-2 hover:bg-white/5 transition-colors cursor-pointer"
                style={{ color: showVoicePanel ? accent : '#78716c' }}
                title="Open Voice recorder"
              >
                <Mic size={15} />
              </button>

              {/* Audio recording source selector (mic vs system loopback) */}
              {isElectron && showVoicePanel && (
                <div className="relative flex items-center bg-white/[0.03] border border-white/5 rounded-lg px-1 py-0.5">
                  <select
                    value={audioSource}
                    onChange={(e) => setAudioSource(e.target.value)}
                    className="appearance-none bg-transparent text-[9px] text-stone-400 outline-none pr-3 cursor-pointer"
                    title="Choose Voice recording feed"
                  >
                    <option value="mic">Mic</option>
                    <option value="system">System</option>
                  </select>
                  <span className="pointer-events-none absolute right-1 text-[8px] text-stone-500">
                    ▼
                  </span>
                </div>
              )}
            </div>

            {/* Send Message Button */}
            <button
              onClick={handleSend}
              aria-label={showStop ? 'Stop generation' : 'Send message'}
              disabled={!showStop && (hasFailedUpload || sendQueued || !hasNewInput)}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-xl text-black hover:scale-105 active:scale-95 transition-all disabled:opacity-30 disabled:hover:scale-100 disabled:cursor-not-allowed cursor-pointer"
              style={{ background: accent }}
            >
              {showStop ? (
                <Square size={11} fill="currentColor" />
              ) : (
                <ArrowUp size={15} strokeWidth={2.5} />
              )}
            </button>
          </div>
        </div>

        <p className="text-center text-[9px] text-stone-700 select-none [@media(max-height:640px)]:hidden">
          Chanakya AI calculations run 100% offline. Local responses may occasionally vary.
        </p>
      </div>
    </div>
  );
}
