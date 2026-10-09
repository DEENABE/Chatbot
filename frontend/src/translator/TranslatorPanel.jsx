import React, { useRef, useState } from 'react';
import { Languages, ArrowLeftRight, Copy, Check, Eraser, AlertCircle, Loader2 } from 'lucide-react';
import { useAppStore } from '../stores/useAppStore.js';
import { translate as translateApi } from '../services/api.js';

// FLORES-200-style codes, mirroring backend/src/services/languageRegistry.js
// (the server is the authority on what's actually supported — this list
// only drives the dropdowns' display).
const LANGUAGES = [
  { code: 'eng_Latn', label: 'English', native: 'English' },
  { code: 'hin_Deva', label: 'Hindi', native: 'हिन्दी' },
  { code: 'tam_Taml', label: 'Tamil', native: 'தமிழ்' },
  { code: 'kan_Knda', label: 'Kannada', native: 'ಕನ್ನಡ' },
  { code: 'tel_Telu', label: 'Telugu', native: 'తెలుగు' },
  { code: 'mal_Mlym', label: 'Malayalam', native: 'മലയാളം' },
];

// Only ever valid as a *source* — there is no such thing as an
// auto-detected destination language.
const AUTO_SOURCE = { code: 'auto', label: 'Auto Detect', native: '—' };
const SOURCE_LANGUAGES = [AUTO_SOURCE, ...LANGUAGES];

// Mirrors the backend's TRANSLATE_MAX_CHARS default. Cosmetic guard only —
// the server enforces its own cap regardless.
const MAX_CHARS = 5000;

const selectClasses =
  'w-full appearance-none rounded-xl border border-white/10 bg-[#0c0c0e] px-3 py-2 text-xs font-semibold text-stone-200 ' +
  'focus-visible:ring-2 focus-visible:ring-offset-0 cursor-pointer transition-colors hover:border-white/20';

export default function TranslatorPanel() {
  const settings = useAppStore((state) => state.settings);
  const accent = settings.accentColor || '#3b82f6';

  const [sourceLanguage, setSourceLanguage] = useState('auto');
  const [targetLanguage, setTargetLanguage] = useState('tam_Taml');
  const [text, setText] = useState('');
  const [translation, setTranslation] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  // Guards against double submission beyond the disabled button (e.g. a
  // queued Ctrl+Enter landing before React re-renders the disabled state).
  const inFlightRef = useRef(false);

  const trimmed = text.trim();
  const canTranslate = trimmed.length > 0 && text.length <= MAX_CHARS && !isLoading;

  const handleTranslate = async () => {
    if (!canTranslate || inFlightRef.current) return;
    inFlightRef.current = true;
    setIsLoading(true);
    setError('');
    setCopied(false);
    try {
      const response = await translateApi.text({
        text,
        sourceLanguage,
        targetLanguage,
      });
      setTranslation(response.data?.translation ?? '');
    } catch (err) {
      // The backend only ever returns deliberately-authored safe messages in
      // `error`; anything else (network down, etc.) gets a generic line.
      const serverMessage = err?.response?.data?.error;
      setError(
        typeof serverMessage === 'string'
          ? serverMessage
          : 'Translation failed. Check that the local server is running and try again.',
      );
      setTranslation('');
    } finally {
      inFlightRef.current = false;
      setIsLoading(false);
    }
  };

  const handleSwap = () => {
    // Swapping "Auto Detect" into the target slot makes no sense — there
    // is nothing to swap it with (see AUTO_SOURCE above).
    if (isLoading || sourceLanguage === 'auto') return;
    setSourceLanguage(targetLanguage);
    setTargetLanguage(sourceLanguage);
    // If there is a result, continue from it in the other direction.
    if (translation) {
      setText(translation);
      setTranslation('');
    }
    setError('');
    setCopied(false);
  };

  const handleCopy = async () => {
    if (!translation) return;
    try {
      await navigator.clipboard.writeText(translation);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setError('Could not access the clipboard.');
    }
  };

  const handleClear = () => {
    if (isLoading) return;
    setText('');
    setTranslation('');
    setError('');
    setCopied(false);
  };

  const handleKeyDown = (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      handleTranslate();
    }
  };

  const overLimit = text.length > MAX_CHARS;

  return (
    <div className="w-full h-full flex flex-col p-4 overflow-y-auto select-none">
      <div className="mx-auto max-w-2xl w-full flex-1 flex flex-col space-y-4">
        <div>
          <h2 className="text-sm font-bold text-stone-200 flex items-center gap-2">
            <Languages size={15} style={{ color: accent }} aria-hidden="true" />
            Translator
          </h2>
          <p className="text-[10px] text-stone-500 mt-0.5">
            Translate between English, Hindi, Tamil, Kannada, Telugu, and Malayalam — processed
            entirely on this machine.
          </p>
        </div>

        {/* Language selectors + swap */}
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <label
              htmlFor="translator-source"
              className="block text-[10px] font-bold uppercase tracking-wider text-stone-600 mb-1"
            >
              From
            </label>
            <select
              id="translator-source"
              value={sourceLanguage}
              onChange={(event) => {
                setSourceLanguage(event.target.value);
                setError('');
              }}
              disabled={isLoading}
              className={selectClasses}
              style={{ '--tw-ring-color': accent }}
            >
              {SOURCE_LANGUAGES.map((lang) => (
                <option key={lang.code} value={lang.code}>
                  {lang.label} · {lang.native}
                </option>
              ))}
            </select>
          </div>

          <button
            type="button"
            onClick={handleSwap}
            disabled={isLoading || sourceLanguage === 'auto'}
            aria-label="Swap source and target languages"
            title={
              sourceLanguage === 'auto'
                ? 'Pick a specific source language to swap'
                : 'Swap languages'
            }
            className="shrink-0 rounded-xl border border-white/10 bg-white/[0.02] p-2.5 text-stone-400 transition-all hover:bg-white/[0.06] hover:text-white focus-visible:ring-2 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            style={{ '--tw-ring-color': accent }}
          >
            <ArrowLeftRight size={14} aria-hidden="true" />
          </button>

          <div className="flex-1">
            <label
              htmlFor="translator-target"
              className="block text-[10px] font-bold uppercase tracking-wider text-stone-600 mb-1"
            >
              To
            </label>
            <select
              id="translator-target"
              value={targetLanguage}
              onChange={(event) => {
                setTargetLanguage(event.target.value);
                setError('');
              }}
              disabled={isLoading}
              className={selectClasses}
              style={{ '--tw-ring-color': accent }}
            >
              {LANGUAGES.map((lang) => (
                <option key={lang.code} value={lang.code}>
                  {lang.label} · {lang.native}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Input */}
        <div className="space-y-1">
          <label
            htmlFor="translator-input"
            className="block text-[10px] font-bold uppercase tracking-wider text-stone-600"
          >
            Text to translate
          </label>
          <textarea
            id="translator-input"
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setError('');
            }}
            onKeyDown={handleKeyDown}
            rows={5}
            maxLength={MAX_CHARS + 1000}
            placeholder="Type or paste text here… (Ctrl+Enter to translate)"
            aria-describedby="translator-count"
            className="w-full resize-y rounded-2xl border border-white/10 bg-[#09090a]/60 p-3 text-xs leading-relaxed text-stone-200 placeholder:text-stone-600 focus-visible:ring-2 select-text"
            style={{ '--tw-ring-color': accent }}
          />
          <div className="flex items-center justify-between">
            <span
              id="translator-count"
              aria-live="polite"
              className={`text-[10px] font-mono ${overLimit ? 'font-bold text-red-400' : 'text-stone-600'}`}
            >
              {text.length.toLocaleString()} / {MAX_CHARS.toLocaleString()}
              {overLimit && ' — too long'}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleClear}
                disabled={isLoading || (!text && !translation && !error)}
                className="flex items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1.5 text-[10px] font-semibold text-stone-400 transition-all hover:bg-white/[0.04] hover:text-white focus-visible:ring-2 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                style={{ '--tw-ring-color': accent }}
              >
                <Eraser size={11} aria-hidden="true" />
                Clear
              </button>
              <button
                type="button"
                onClick={handleTranslate}
                disabled={!canTranslate}
                aria-busy={isLoading}
                className="flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-[10px] font-bold text-white transition-all focus-visible:ring-2 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                style={{
                  background: `linear-gradient(135deg, ${accent}, ${accent}b0)`,
                  '--tw-ring-color': accent,
                }}
              >
                {isLoading ? (
                  <>
                    <Loader2 size={11} className="animate-spin" aria-hidden="true" />
                    Translating…
                  </>
                ) : (
                  <>
                    <Languages size={11} aria-hidden="true" />
                    Translate
                  </>
                )}
              </button>
            </div>
          </div>
        </div>

        {/* Error — icon + text, not color alone */}
        {error && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-xl border border-red-500/25 bg-red-500/10 p-3 text-xs text-red-300"
          >
            <AlertCircle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>Error: {error}</span>
          </div>
        )}

        {/* Output */}
        <div className="flex-1 flex flex-col min-h-0 space-y-1">
          <div className="flex items-center justify-between">
            <h3 className="text-[10px] font-bold uppercase tracking-wider text-stone-600">
              Translation
            </h3>
            {translation && (
              <button
                type="button"
                onClick={handleCopy}
                className="flex items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1.5 text-[10px] font-semibold text-stone-400 transition-all hover:bg-white/[0.04] hover:text-white focus-visible:ring-2 cursor-pointer"
                style={{ '--tw-ring-color': accent }}
              >
                {copied ? (
                  <>
                    <Check size={11} className="text-emerald-400" aria-hidden="true" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy size={11} aria-hidden="true" />
                    Copy
                  </>
                )}
              </button>
            )}
          </div>

          {/* aria-live so screen readers announce results; rendered strictly
              as a plain text node (React-escaped) — the translated output is
              untrusted and is never inserted as HTML. */}
          <div aria-live="polite" className="flex-1 min-h-[120px]">
            {isLoading ? (
              <div className="h-full min-h-[120px] rounded-2xl border border-white/[0.06] shimmer-bg flex items-center justify-center">
                <span className="text-[10px] uppercase tracking-widest text-stone-500">
                  Translating…
                </span>
              </div>
            ) : translation ? (
              <div className="h-full rounded-2xl border border-white/[0.08] bg-white/[0.02] p-3 text-xs leading-relaxed text-stone-200 whitespace-pre-wrap select-text overflow-y-auto">
                {translation}
              </div>
            ) : (
              <div className="h-full min-h-[120px] rounded-2xl border border-white/[0.04] bg-[#121214]/25 flex flex-col items-center justify-center p-6 text-center">
                <Languages size={22} className="text-stone-700 mb-2" aria-hidden="true" />
                <div className="text-xs font-medium text-stone-500">No translation yet</div>
                <div className="text-[10px] text-stone-600 mt-0.5">
                  Pick your languages, enter text above, and press Translate.
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
