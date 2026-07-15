import React, { useRef, useState, useEffect } from 'react';
import Tesseract from 'tesseract.js';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Crop, LoaderCircle, Pencil, Square, Type, RotateCcw, Send, Check } from 'lucide-react';
import { useAppStore } from '../stores/useAppStore.js';
import { presets } from '../animations/presets.js';

export default function OcrCropModal({ onSuccess }) {
  const ocrScreenshot = useAppStore((state) => state.ocrScreenshot);
  const setOcrScreenshot = useAppStore((state) => state.setOcrScreenshot);
  const isOcrProcessing = useAppStore((state) => state.isOcrProcessing);
  const setOcrProcessing = useAppStore((state) => state.setOcrProcessing);
  const setPendingScreenCapture = useAppStore((state) => state.setPendingScreenCapture);
  const toggleExpand = useAppStore((state) => state.toggleExpand);
  const isExpanded = useAppStore((state) => state.isExpanded);
  const settings = useAppStore((state) => state.settings);

  // Tool Modes: 'crop' (OCR), 'draw' (Brush), 'rect' (Bounding Box), 'text' (Text label)
  const [tool, setTool] = useState('crop');
  const [color, setColor] = useState('#ef4444'); // Red default
  const [selection, setSelection] = useState(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  
  // Canvas Annotation States
  const [markups, setMarkups] = useState([]); // Array of { type, points, x, y, w, h, text, color }
  const [currentPath, setCurrentPath] = useState(null);
  const [textInput, setTextInput] = useState({ visible: false, x: 0, y: 0, val: '' });

  const containerRef = useRef(null);
  const imageRef = useRef(null);
  const canvasRef = useRef(null);
  const textInputRef = useRef(null);

  const accent = settings.accentColor || '#3b82f6';

  // Synchronize overlay canvas dimensions with image client width/height
  const syncCanvasSize = () => {
    if (imageRef.current && canvasRef.current) {
      canvasRef.current.width = imageRef.current.clientWidth;
      canvasRef.current.height = imageRef.current.clientHeight;
      drawMarkups();
    }
  };

  useEffect(() => {
    window.addEventListener('resize', syncCanvasSize);
    return () => window.removeEventListener('resize', syncCanvasSize);
  }, [markups]);

  // Redraw the transparent canvas markups
  const drawMarkups = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw previous markups
    markups.forEach((m) => {
      ctx.strokeStyle = m.color;
      ctx.fillStyle = m.color;
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      if (m.type === 'draw' && m.points.length > 1) {
        ctx.beginPath();
        ctx.moveTo(m.points[0].x, m.points[0].y);
        for (let i = 1; i < m.points.length; i++) {
          ctx.lineTo(m.points[i].x, m.points[i].y);
        }
        ctx.stroke();
      } else if (m.type === 'rect') {
        ctx.strokeRect(m.x, m.y, m.w, m.h);
      } else if (m.type === 'text') {
        ctx.font = '16px Outfit, Inter, sans-serif';
        ctx.fillText(m.text, m.x, m.y);
      }
    });

    // Draw active drawing path
    if (currentPath && currentPath.points.length > 1) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(currentPath.points[0].x, currentPath.points[0].y);
      for (let i = 1; i < currentPath.points.length; i++) {
        ctx.lineTo(currentPath.points[i].x, currentPath.points[i].y);
      }
      ctx.stroke();
    }
  };

  useEffect(() => {
    drawMarkups();
  }, [markups, currentPath, color]);

  // Focus text input when visible
  useEffect(() => {
    if (textInput.visible && textInputRef.current) {
      textInputRef.current.focus();
    }
  }, [textInput.visible]);

  const handleMouseDown = (e) => {
    if (isOcrProcessing || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (tool === 'crop') {
      setSelection({ startX: x, startY: y, endX: x, endY: y });
      setIsDrawing(true);
    } else if (tool === 'draw') {
      setCurrentPath({ type: 'draw', points: [{ x, y }], color });
      setIsDrawing(true);
    } else if (tool === 'rect') {
      setCurrentPath({ type: 'rect', startX: x, startY: y, x, y, w: 0, h: 0, color });
      setIsDrawing(true);
    } else if (tool === 'text') {
      if (textInput.visible) {
        saveTextMarkup();
      } else {
        setTextInput({ visible: true, x, y, val: '' });
      }
    }
  };

  const handleMouseMove = (e) => {
    if (!isDrawing || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const y = Math.max(0, Math.min(rect.height, e.clientY - rect.top));

    if (tool === 'crop' && selection) {
      setSelection((prev) => ({ ...prev, endX: x, endY: y }));
    } else if (tool === 'draw' && currentPath) {
      setCurrentPath((prev) => ({
        ...prev,
        points: [...prev.points, { x, y }]
      }));
    } else if (tool === 'rect' && currentPath) {
      const startX = currentPath.startX;
      const startY = currentPath.startY;
      const w = x - startX;
      const h = y - startY;
      setCurrentPath((prev) => ({
        ...prev,
        x: w < 0 ? x : startX,
        y: h < 0 ? y : startY,
        w: Math.abs(w),
        h: Math.abs(h)
      }));
    }
  };

  const handleMouseUp = () => {
    setIsDrawing(false);
    if (tool === 'draw' && currentPath) {
      setMarkups((prev) => [...prev, currentPath]);
      setCurrentPath(null);
    } else if (tool === 'rect' && currentPath) {
      if (currentPath.w > 4 && currentPath.h > 4) {
        setMarkups((prev) => [...prev, currentPath]);
      }
      setCurrentPath(null);
    }
  };

  const saveTextMarkup = () => {
    if (textInput.val.trim()) {
      setMarkups((prev) => [
        ...prev,
        {
          type: 'text',
          x: textInput.x,
          y: textInput.y,
          text: textInput.val,
          color
        }
      ]);
    }
    setTextInput({ visible: false, x: 0, y: 0, val: '' });
  };

  const handleTextKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveTextMarkup();
    } else if (e.key === 'Escape') {
      setTextInput({ visible: false, x: 0, y: 0, val: '' });
    }
  };

  // Perform Local OCR on Cropped Area
  const performOcr = async () => {
    if (!selection || !ocrScreenshot || !imageRef.current) return;

    const x1 = Math.min(selection.startX, selection.endX);
    const y1 = Math.min(selection.startY, selection.endY);
    const x2 = Math.max(selection.startX, selection.endX);
    const y2 = Math.max(selection.startY, selection.endY);

    const width = x2 - x1;
    const height = y2 - y1;

    if (width < 10 || height < 10) {
      alert('Please select a larger screen area to crop.');
      return;
    }

    setOcrProcessing(true);
    setStatusMessage('Cropping selection...');

    const img = new Image();
    img.src = ocrScreenshot;
    img.onload = async () => {
      try {
        const displayW = imageRef.current.clientWidth;
        const displayH = imageRef.current.clientHeight;

        const scaleX = img.naturalWidth / displayW;
        const scaleY = img.naturalHeight / displayH;

        const cropX = x1 * scaleX;
        const cropY = y1 * scaleY;
        const cropW = width * scaleX;
        const cropH = height * scaleY;

        const canvas = document.createElement('canvas');
        canvas.width = cropW;
        canvas.height = cropH;
        const ctx = canvas.getContext('2d');

        if (!ctx) throw new Error('Canvas context could not be created.');
        ctx.drawImage(img, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

        const croppedDataUrl = canvas.toDataURL('image/png');
        setStatusMessage('Extracting text offline...');
        
        const result = await Tesseract.recognize(
          croppedDataUrl,
          'eng',
          {
            langPath: 'http://127.0.0.1:3001/ocr',
            logger: (m) => {
              if (m.status === 'recognizing text') {
                setStatusMessage(`Recognizing: ${Math.round(m.progress * 100)}%`);
              }
            }
          }
        );

        const parsedText = result.data.text?.trim();
        if (parsedText) {
          onSuccess(parsedText);
          setOcrScreenshot(null);
        } else {
          alert('No text detected in selected area.');
        }
      } catch (err) {
        console.error('OCR failed:', err);
        alert('OCR processing error: ' + err.message);
      } finally {
        setOcrProcessing(false);
        setSelection(null);
      }
    };
  };

  // Compile Annotations and Send to AI Chat
  const handleSendToAI = () => {
    if (!ocrScreenshot || !imageRef.current) return;
    setOcrProcessing(true);
    setStatusMessage('Rendering annotations...');

    const img = new Image();
    img.src = ocrScreenshot;
    img.onload = () => {
      try {
        const displayW = imageRef.current.clientWidth;
        const displayH = imageRef.current.clientHeight;

        const scaleX = img.naturalWidth / displayW;
        const scaleY = img.naturalHeight / displayH;

        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');

        if (!ctx) throw new Error('Canvas export failed');

        // 1. Draw base screenshot
        ctx.drawImage(img, 0, 0);

        // 2. Draw annotations scaled to natural dimensions
        markups.forEach((m) => {
          ctx.strokeStyle = m.color;
          ctx.fillStyle = m.color;
          ctx.lineWidth = 3 * scaleX; // Scale line width proportionally
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';

          if (m.type === 'draw' && m.points.length > 1) {
            ctx.beginPath();
            ctx.moveTo(m.points[0].x * scaleX, m.points[0].y * scaleY);
            for (let i = 1; i < m.points.length; i++) {
              ctx.lineTo(m.points[i].x * scaleX, m.points[i].y * scaleY);
            }
            ctx.stroke();
          } else if (m.type === 'rect') {
            ctx.strokeRect(m.x * scaleX, m.y * scaleY, m.w * scaleX, m.h * scaleY);
          } else if (m.type === 'text') {
            const fontS = Math.round(18 * scaleX);
            ctx.font = `bold ${fontS}px Outfit, Inter, sans-serif`;
            ctx.fillText(m.text, m.x * scaleX, m.y * scaleY);
          }
        });

        // 3. Compile base64
        const dataUrl = canvas.toDataURL('image/png');
        setPendingScreenCapture({ image: dataUrl, windows: [] });
        
        // 4. Close and expand
        setOcrScreenshot(null);
        if (!isExpanded) {
          toggleExpand();
        }
      } catch (err) {
        console.error('Markup composition failed:', err);
        alert('Could not compose marked up screenshot.');
      } finally {
        setOcrProcessing(false);
      }
    };
  };

  const handleCancel = () => {
    setOcrScreenshot(null);
    setSelection(null);
    setMarkups([]);
    setOcrProcessing(false);
  };

  if (!ocrScreenshot) return null;

  const boxX = selection ? Math.min(selection.startX, selection.endX) : 0;
  const boxY = selection ? Math.min(selection.startY, selection.endY) : 0;
  const boxW = selection ? Math.abs(selection.startX - selection.endX) : 0;
  const boxH = selection ? Math.abs(selection.startY - selection.endY) : 0;

  return (
    <div className="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-black/90 select-none font-sans">
      {/* Top Floating Toolbar */}
      <div className="absolute top-4 left-4 right-4 flex items-center justify-between z-50 bg-[#121214]/90 border border-white/10 backdrop-blur-md px-4 py-2.5 rounded-2xl max-w-4xl mx-auto shadow-2xl">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 border-r border-white/10 pr-3">
            <button
              onClick={() => { setTool('crop'); setSelection(null); }}
              className={`flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-[11px] font-bold transition-all ${tool === 'crop' ? 'bg-white/10 text-white' : 'text-stone-400 hover:text-stone-200'}`}
            >
              <Crop size={14} style={{ color: tool === 'crop' ? accent : undefined }} />
              OCR Crop
            </button>
            <button
              onClick={() => { setTool('draw'); setSelection(null); }}
              className={`flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-[11px] font-bold transition-all ${tool === 'draw' ? 'bg-white/10 text-white' : 'text-stone-400 hover:text-stone-200'}`}
            >
              <Pencil size={14} style={{ color: tool === 'draw' ? accent : undefined }} />
              Draw Pencil
            </button>
            <button
              onClick={() => { setTool('rect'); setSelection(null); }}
              className={`flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-[11px] font-bold transition-all ${tool === 'rect' ? 'bg-white/10 text-white' : 'text-stone-400 hover:text-stone-200'}`}
            >
              <Square size={14} style={{ color: tool === 'rect' ? accent : undefined }} />
              Box outline
            </button>
            <button
              onClick={() => { setTool('text'); setSelection(null); }}
              className={`flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-[11px] font-bold transition-all ${tool === 'text' ? 'bg-white/10 text-white' : 'text-stone-400 hover:text-stone-200'}`}
            >
              <Type size={14} style={{ color: tool === 'text' ? accent : undefined }} />
              Text label
            </button>
          </div>

          {/* Color Palettes (only for markups) */}
          {tool !== 'crop' && (
            <div className="flex items-center gap-1.5">
              {['#ef4444', '#3b82f6', '#10b981', '#f59e0b', '#ffffff'].map((c) => (
                <button
                  key={c}
                  onClick={() => setColor(c)}
                  className={`w-4 h-4 rounded-full border transition-transform ${color === c ? 'scale-125 border-white' : 'border-transparent hover:scale-110'}`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          )}
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-2.5">
          {tool === 'crop' && selection && boxW > 15 && !isOcrProcessing && (
            <button
              onClick={performOcr}
              className="flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-[11px] font-bold text-black hover:scale-105 active:scale-95 transition-all shadow-md"
              style={{ backgroundColor: accent }}
            >
              <Check size={13} />
              Extract Text
            </button>
          )}

          {markups.length > 0 && (
            <>
              <button
                onClick={() => setMarkups([])}
                className="flex items-center gap-1 rounded-xl px-2.5 py-1.5 text-[11px] font-bold border border-white/10 hover:bg-white/5 text-stone-400 hover:text-stone-200 transition-all"
              >
                <RotateCcw size={13} />
                Clear
              </button>
              <button
                onClick={handleSendToAI}
                className="flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-[11px] font-bold text-black hover:scale-105 active:scale-95 transition-all shadow-md animate-pulse"
                style={{ backgroundColor: accent }}
              >
                <Send size={13} />
                Send image to AI
              </button>
            </>
          )}

          <button
            onClick={handleCancel}
            disabled={isOcrProcessing}
            className="flex h-8 w-8 items-center justify-center rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 text-stone-400 hover:text-white transition-colors"
          >
            <X size={15} />
          </button>
        </div>
      </div>

      {/* Main capture overlay container */}
      <div 
        ref={containerRef}
        className="relative max-w-[92vw] max-h-[82vh] border border-white/10 rounded-xl overflow-hidden shadow-2xl select-none"
      >
        <img 
          ref={imageRef}
          src={ocrScreenshot} 
          alt="Screenshot Capture" 
          onLoad={syncCanvasSize}
          className="max-w-full max-h-[80vh] object-contain pointer-events-none" 
        />

        {/* Backdrop overlay except selection area (for crop mode) */}
        {tool === 'crop' && selection && (
          <div className="absolute inset-0 pointer-events-none">
            <div className="absolute bg-black/50" style={{ top: 0, left: 0, right: 0, height: boxY }} />
            <div className="absolute bg-black/50" style={{ top: boxY, left: 0, width: boxX, height: boxH }} />
            <div className="absolute bg-black/50" style={{ top: boxY, right: 0, left: boxX + boxW, height: boxH }} />
            <div className="absolute bg-black/50" style={{ top: boxY + boxH, left: 0, right: 0, bottom: 0 }} />

            <div 
              className="absolute pointer-events-none"
              style={{
                top: boxY,
                left: boxX,
                width: boxW,
                height: boxH,
                border: `2px solid ${accent}`,
                boxShadow: `0 0 10px ${accent}40`,
                background: 'rgba(255, 255, 255, 0.05)'
              }}
            />
          </div>
        )}

        {/* Interactive Annotation Canvas */}
        <canvas 
          ref={canvasRef}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          className={`absolute inset-0 z-30 ${tool === 'crop' ? 'cursor-crosshair' : 'cursor-default'}`}
        />

        {/* Inline typing text box overlay */}
        {textInput.visible && (
          <div 
            className="absolute z-40 p-1 bg-black/80 border border-white/10 rounded shadow-lg"
            style={{ left: textInput.x, top: textInput.y - 12 }}
          >
            <input
              ref={textInputRef}
              type="text"
              value={textInput.val}
              onChange={(e) => setTextInput((prev) => ({ ...prev, val: e.target.value }))}
              onKeyDown={handleTextKeyDown}
              onBlur={saveTextMarkup}
              placeholder="Type label..."
              className="bg-transparent border-none outline-none focus:ring-0 text-white text-xs px-1 w-32 py-0.5"
            />
          </div>
        )}
      </div>

      {/* OCR Loader Status Overlay */}
      <AnimatePresence>
        {isOcrProcessing && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-black/80 backdrop-blur-sm"
          >
            <div className="bg-[#121214] border border-white/5 p-6 rounded-2xl flex flex-col items-center gap-4 text-center max-w-xs shadow-2xl">
              <LoaderCircle size={32} className="animate-spin" style={{ color: accent }} />
              <div>
                <h3 className="text-xs font-semibold text-white">Chanakya Image Processing</h3>
                <p className="text-[11px] text-stone-500 mt-1">{statusMessage}</p>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
