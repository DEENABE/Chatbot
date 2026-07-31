import React, { useRef, useState, useEffect } from 'react';
import { motion, AnimatePresence, useSpring, useMotionValue } from 'framer-motion';
import { useAppStore } from '../stores/useAppStore.js';
import { presets } from '../animations/presets.js';
import { Mic, Monitor, Crop, Video, Minus } from 'lucide-react';
import chanakyaDefault from '../assets/chanakya_default.png';
import chanakyaHover from '../assets/chanakya_hover.png';
import { nextLine, firstNameOf } from './greetings.js';
import { speak, stopSpeaking } from '../services/speak.js';

/** Don't speak the greeting again within this window (ms). */
const VOICE_COOLDOWN = 90_000;

// Labels are what the user reads to decide — say what the action does, not what
// the feature is called internally.
const quickActions = [
  { id: 'mic', icon: Mic, label: 'Speak to Chanakya', electronOnly: false },
  { id: 'capture', icon: Monitor, label: 'Capture Screen', electronOnly: true },
  { id: 'ocr', icon: Crop, label: 'Read Screen Text', electronOnly: true },
  { id: 'record', icon: Video, label: 'Record Screen', electronOnly: true },
  { id: 'minimize', icon: Minus, label: 'Hide', electronOnly: true },
];

export default function FloatingBubble() {
  const toggleExpand = useAppStore((state) => state.toggleExpand);
  const settings = useAppStore((state) => state.settings);
  const user = useAppStore((state) => state.user);
  const setOcrScreenshot = useAppStore((state) => state.setOcrScreenshot);
  const setPendingScreenCapture = useAppStore((state) => state.setPendingScreenCapture);
  const setBubbleAction = useAppStore((state) => state.setBubbleAction);

  const [isHovered, setIsHovered] = useState(false);
  const [showToolbar, setShowToolbar] = useState(false);
  const [greeting, setGreeting] = useState('');
  // Which screen edge the window grew away from, so the column lines up with
  // the avatar's old position instead of centring in the widened window.
  const [hoverSide, setHoverSide] = useState('right');

  const bubbleRef = useRef(null);
  const dragThreshold = useRef({ isDragging: false, startX: 0, startY: 0 });
  const hoverTimeoutRef = useRef(null);
  const leaveTimeoutRef = useRef(null);
  const hasGreetedRef = useRef(false);
  const lastSpokenAtRef = useRef(0);

  // Spring values for the Magnetic Pull effect
  const mX = useMotionValue(0);
  const mY = useMotionValue(0);
  const bubbleX = useSpring(mX, { stiffness: 220, damping: 18 });
  const bubbleY = useSpring(mY, { stiffness: 220, damping: 18 });

  // Spring values for the Eye-Tracking pupil effect
  const pX = useMotionValue(0);
  const pY = useMotionValue(0);
  const pupilX = useSpring(pX, { stiffness: 350, damping: 16 });
  const pupilY = useSpring(pY, { stiffness: 350, damping: 16 });

  const isElectron = !!window.electronAPI;

  // Filter actions based on environment
  const visibleActions = quickActions.filter(a => !a.electronOnly || isElectron);

  // Cleanup timeouts on unmount
  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
      if (leaveTimeoutRef.current) clearTimeout(leaveTimeoutRef.current);
      stopSpeaking();
    };
  }, []);

  /**
   * Say the greeting out loud. Opt-in, and rate-limited — a voice on every
   * hover would be unbearable, and the speech bubble already carries the text.
   */
  const speakGreeting = (text) => {
    if (!settings.voiceGreeting) return;
    const now = Date.now();
    if (now - lastSpokenAtRef.current < VOICE_COOLDOWN) return;
    lastSpokenAtRef.current = now;
    speak(text);
  };

  const handleMouseMove = (e) => {
    if (!bubbleRef.current || dragThreshold.current.isDragging) return;
    const rect = bubbleRef.current.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const dx = e.clientX - centerX;
    const dy = e.clientY - centerY;

    const pullFactor = 0.28;
    mX.set(Math.max(-10, Math.min(10, dx * pullFactor)));
    mY.set(Math.max(-10, Math.min(10, dy * pullFactor)));

    const eyeFactor = 0.15;
    pX.set(Math.max(-4, Math.min(4, dx * eyeFactor)));
    pY.set(Math.max(-4, Math.min(4, dy * eyeFactor)));
  };

  const handleMouseEnter = () => {
    setIsHovered(true);
    // Cancel a pending collapse. This is also what rescues the greeting from
    // the spurious mouseleave the window resize fires: the re-enter lands
    // before the timeout runs.
    if (leaveTimeoutRef.current) {
      clearTimeout(leaveTimeoutRef.current);
      leaveTimeoutRef.current = null;
    }
    if (!user || greeting) return;

    // Ask for the bigger window and show the line in the same tick. Awaiting the
    // IPC first meant the resize could fire a mouseleave that wiped the greeting
    // before it ever rendered.
    if (isElectron) {
      window.electronAPI
        .setToolbarMode(true)
        .then((result) => result?.side && setHoverSide(result.side))
        .catch((err) => console.warn('Hover mode failed:', err));
    }

    const line = nextLine({
      isFirstHover: !hasGreetedRef.current,
      displayName: firstNameOf(user),
      previous: greeting,
    });
    hasGreetedRef.current = true;
    setGreeting(line);
    speakGreeting(line);

    hoverTimeoutRef.current = setTimeout(() => setShowToolbar(true), 350);
  };

  const handleMouseLeave = () => {
    setIsHovered(false);
    // Cancel any pending expand
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
    stopSpeaking();

    // Everything tears down inside the delayed callback, never straight away:
    // resizing the window makes the cursor cross element boundaries, so an
    // immediate clear would blank the greeting the moment it appeared.
    leaveTimeoutRef.current = setTimeout(async () => {
      setGreeting('');
      setShowToolbar(false);
      if (isElectron) {
        try { await window.electronAPI.setToolbarMode(false); } catch (err) {
          console.warn('Hover collapse failed:', err);
        }
      }
    }, 500);

    // Reset magnetic/pupil springs
    mX.set(0);
    mY.set(0);
    pX.set(0);
    pY.set(0);
  };

  const handleMouseDown = (e) => {
    if (e.button !== 0) return;
    dragThreshold.current = {
      isDragging: false,
      startX: e.screenX,
      startY: e.screenY
    };

    if (isElectron) window.electronAPI.dragStart();

    const handleMouseMoveWindow = (moveEvent) => {
      const deltaX = Math.abs(moveEvent.screenX - dragThreshold.current.startX);
      const deltaY = Math.abs(moveEvent.screenY - dragThreshold.current.startY);

      if (deltaX > 5 || deltaY > 5) {
        dragThreshold.current.isDragging = true;
        mX.set(0);
        mY.set(0);
        pX.set(0);
        pY.set(0);
        // Collapse toolbar during drag
        if (showToolbar) {
          if (isElectron) window.electronAPI.setToolbarMode(false).catch(() => {});
          setShowToolbar(false);
        }
      }

      if (isElectron) window.electronAPI.dragMove();
    };

    const handleMouseUpWindow = () => {
      window.removeEventListener('mousemove', handleMouseMoveWindow);
      window.removeEventListener('mouseup', handleMouseUpWindow);

      if (isElectron) window.electronAPI.dragEnd();

      // Click (not drag) → open chat
      if (!dragThreshold.current.isDragging) {
        if (showToolbar) {
          if (isElectron) window.electronAPI.setToolbarMode(false).catch(() => {});
          setShowToolbar(false);
        }
        toggleExpand();
      }
    };

    window.addEventListener('mousemove', handleMouseMoveWindow);
    window.addEventListener('mouseup', handleMouseUpWindow);
  };

  const handleActionClick = async (actionId, e) => {
    e.stopPropagation();
    e.preventDefault();

    // Clear pending timeouts
    if (hoverTimeoutRef.current) { clearTimeout(hoverTimeoutRef.current); hoverTimeoutRef.current = null; }
    if (leaveTimeoutRef.current) { clearTimeout(leaveTimeoutRef.current); leaveTimeoutRef.current = null; }

    const collapseToolbar = async () => {
      if (isElectron) {
        try { await window.electronAPI.setToolbarMode(false); } catch {}
      }
      setShowToolbar(false);
      setIsHovered(false);
    };

    switch (actionId) {
      case 'mic':
        setBubbleAction('voice');
        await collapseToolbar();
        setTimeout(() => toggleExpand(), 150);
        break;
      case 'capture':
        if (isElectron) {
          const data = await window.electronAPI.captureScreen();
          if (data) setPendingScreenCapture(data);
        }
        await collapseToolbar();
        setTimeout(() => toggleExpand(), 150);
        break;
      case 'ocr':
        if (isElectron) {
          const data = await window.electronAPI.captureScreen();
          if (data?.image) setOcrScreenshot(data.image);
        }
        await collapseToolbar();
        break;
      case 'record':
        setBubbleAction('record');
        await collapseToolbar();
        setTimeout(() => toggleExpand(), 150);
        break;
      case 'minimize':
        await collapseToolbar();
        // Bubble stays on screen (coin size) — never fully hidden
        break;
    }
  };

  const accent = settings.accentColor || '#3b82f6';

  return (
    <div
      // Enter and leave both live here so they stay symmetric. Hanging enter off
      // the avatar alone meant moving up to the speech bubble or the actions
      // counted as leaving, and re-entering the avatar re-rolled the greeting.
      className={`w-screen h-screen flex flex-col justify-end select-none px-[6px] ${
        showToolbar || greeting
          ? hoverSide === 'right'
            ? 'items-end'
            : 'items-start'
          : 'items-center'
      }`}
      onMouseMove={handleMouseMove}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {/* Speech bubble — Chanakya says what it can help with, so the user does
          not have to open the chat to find out. */}
      <AnimatePresence>
        {greeting && user && (
          <motion.div
            key="greeting"
            initial={{ opacity: 0, y: 10, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.95 }}
            transition={{ type: 'spring', stiffness: 420, damping: 26 }}
            className={`relative mb-3 max-w-[260px] px-3.5 py-2.5 rounded-2xl ${
              hoverSide === 'right' ? 'rounded-br-md' : 'rounded-bl-md'
            }`}
            style={{
              background: 'linear-gradient(135deg, rgba(24, 24, 30, 0.96), rgba(14, 14, 17, 0.98))',
              border: `1px solid ${accent}35`,
              boxShadow: `0 6px 22px rgba(0,0,0,0.55), 0 0 18px ${accent}20`,
              backdropFilter: 'blur(10px)',
              WebkitBackdropFilter: 'blur(10px)',
            }}
          >
            <p className="text-[11.5px] leading-snug text-stone-200 text-center font-medium">
              {greeting}
            </p>
            {/* Tail pointing down at the avatar, on whichever side it sits */}
            <div
              className={`absolute -bottom-[5px] w-2.5 h-2.5 rotate-45 ${
                hoverSide === 'right' ? 'right-[22px]' : 'left-[22px]'
              }`}
              style={{
                background: 'rgba(14, 14, 17, 0.98)',
                borderRight: `1px solid ${accent}35`,
                borderBottom: `1px solid ${accent}35`,
              }}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Quick Actions Toolbar - slides in above the avatar when logged in & hovered */}
      <AnimatePresence>
        {showToolbar && user && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="flex flex-col items-center gap-2 mb-2"
          >
            {visibleActions.map((action, i) => (
              <motion.button
                key={action.id}
                initial={{ opacity: 0, scale: 0.3, y: 15 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.3, y: 8 }}
                transition={{ delay: i * 0.05, type: 'spring', stiffness: 500, damping: 22 }}
                onClick={(e) => handleActionClick(action.id, e)}
                onMouseDown={(e) => e.stopPropagation()}
                onMouseEnter={() => {
                  // Cancel collapse when hovering action buttons
                  if (leaveTimeoutRef.current) {
                    clearTimeout(leaveTimeoutRef.current);
                    leaveTimeoutRef.current = null;
                  }
                }}
                title={action.label}
                // A labelled pill, not a bare icon: five unnamed glyphs gave no
                // clue that one of them starts voice input.
                className="w-[168px] h-[38px] pl-3 pr-4 rounded-full flex items-center gap-2.5 cursor-pointer group relative"
                style={{
                  background: 'linear-gradient(135deg, rgba(22, 22, 28, 0.94), rgba(12, 12, 14, 0.98))',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                  boxShadow: '0 3px 10px rgba(0, 0, 0, 0.4)',
                  backdropFilter: 'blur(8px)',
                  WebkitBackdropFilter: 'blur(8px)',
                }}
              >
                <motion.div
                  whileTap={{ scale: 0.85 }}
                  className="flex items-center justify-center shrink-0"
                >
                  <action.icon
                    size={15}
                    className="text-stone-400 group-hover:text-white transition-colors duration-200"
                  />
                </motion.div>
                <span className="text-[11px] font-medium text-stone-400 group-hover:text-white transition-colors duration-200 whitespace-nowrap">
                  {action.label}
                </span>
                {/* Hover glow ring */}
                <div
                  className="absolute inset-0 rounded-full opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none"
                  style={{
                    boxShadow: `0 0 14px ${accent}40, inset 0 0 8px ${accent}15`,
                    border: `1px solid ${accent}50`,
                  }}
                />
              </motion.button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Main Avatar Bubble */}
      <motion.div
        ref={bubbleRef}
        onMouseDown={handleMouseDown}
        className="w-[68px] h-[68px] rounded-full flex items-center justify-center cursor-grab active:cursor-grabbing relative"
        style={{
          x: settings.animationsEnabled ? bubbleX : 0,
          y: settings.animationsEnabled ? bubbleY : 0,
          background: `linear-gradient(135deg, rgba(20, 20, 25, 0.82), rgba(10, 10, 12, 0.95))`,
          border: `1.5px solid ${isHovered ? accent : 'rgba(255, 255, 255, 0.12)'}`,
          boxShadow: isHovered
            ? `0 0 20px ${accent}60, 0 8px 20px rgba(0, 0, 0, 0.6)`
            : '0 4px 12px rgba(0, 0, 0, 0.5)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          marginBottom: '12px',
        }}
        animate={settings.animationsEnabled && isHovered ? { scale: 1.08 } : { scale: 1 }}
        transition={presets.appleBounce}
      >
        {/* Glow Ring outer pulse */}
        {isHovered && settings.animationsEnabled && (
          <motion.div
            className="absolute inset-0 rounded-full pointer-events-none"
            style={{
              border: `1.5px solid ${accent}`,
              opacity: 0.7,
            }}
            animate={{
              scale: [1, 1.25, 1],
              opacity: [0.5, 0, 0.5],
            }}
            transition={{
              duration: 2.0,
              repeat: Infinity,
              ease: 'easeInOut',
            }}
          />
        )}

        {/* Dashed outer circular accent line */}
        <div
          className="absolute inset-[3px] rounded-full border border-dashed opacity-20 pointer-events-none animate-[spin_40s_linear_infinite]"
          style={{ borderColor: accent }}
        />

        {/* Cartoon Avatar with responsive eye-tracking look parallax */}
        <motion.div
          className="w-[50px] h-[50px] rounded-full relative pointer-events-none overflow-hidden border border-white/10 bg-zinc-950/80 flex items-center justify-center shadow-inner"
          style={{
            x: settings.animationsEnabled ? pupilX : 0,
            y: settings.animationsEnabled ? pupilY : 0,
          }}
        >
          <img
            src={chanakyaDefault}
            alt="Chanakya Default"
            className="absolute inset-0 w-full h-full object-cover"
          />
          <motion.img
            src={chanakyaHover}
            alt="Chanakya Smiling"
            className="absolute inset-0 w-full h-full object-cover"
            initial={{ opacity: 0 }}
            animate={{ opacity: isHovered ? 1 : 0 }}
            transition={presets.fade}
          />
        </motion.div>

        {/* Floating particles around it */}
        {isHovered && settings.animationsEnabled && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            {[...Array(3)].map((_, i) => (
              <motion.div
                key={i}
                className="absolute w-[6px] h-[6px] rounded-full opacity-60"
                style={{ backgroundColor: accent }}
                initial={{ scale: 0, opacity: 0.8 }}
                animate={{
                  scale: 2.0,
                  opacity: 0,
                  x: (i === 0 ? -22 : i === 1 ? 22 : 0),
                  y: (i === 2 ? -22 : 6),
                }}
                transition={{
                  duration: 1.4,
                  repeat: Infinity,
                  delay: i * 0.3,
                  ease: 'easeOut',
                }}
              />
            ))}
          </div>
        )}

        {/* Online indicator dot when logged in */}
        {user && (
          <div
            className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 z-10"
            style={{
              backgroundColor: '#22c55e',
              borderColor: '#0c0c0e',
            }}
          />
        )}
      </motion.div>
    </div>
  );
}
