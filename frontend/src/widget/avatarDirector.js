/**
 * @module widget/avatarDirector
 * @description Decides how the avatar should behave, as a small deterministic
 * state machine driven by real app signals (recording, generating, speaking) —
 * not an LLM call. Emotion/gesture/expression is a spec for what the *visual
 * layer* renders; see the honesty note below on what that layer can actually
 * do with the current assets.
 *
 * IMPORTANT — current avatar assets: chanakya_default.png / chanakya_hover.png
 * are two flat 1024x1024 photographs, not a rig. There is no independently
 * movable head, eyes, mouth, or hands to animate. So this module produces the
 * full state contract (useful as a stable target if the avatar is ever
 * replaced with a rigged SVG/Lottie/3D asset), but the renderer
 * (FloatingBubble.jsx) only maps the subset that is honestly renderable today:
 *   - breathing, blink   -> CSS opacity/scale pulses
 *   - headMovement       -> subtle rotate/translate of the whole photo
 *   - eyeFocus           -> the existing cursor-tracking pupil offset, retargeted
 *   - emotion/intensity  -> glow colour and strength
 *   - lipSync            -> a talking-pulse ring, not real mouth movement
 *   - gesture            -> a small icon badge, only for the few states it's
 *                           worth showing (not a real hand)
 */

/** @typedef {'sleeping'|'meditation'|'wakeUp'|'idle'|'listening'|'thinking'|'speaking'} AvatarState */
/** @typedef {'happy'|'serious'|'excited'|'sad'|'surprise'|'neutral'} Emotion */
/** @typedef {'wave'|'point'|'open_hand'|'explain'|'welcome'|'nod'|'shake_head'|'shrug'|'hands_together'|'none'} Gesture */
/** @typedef {'user'|'look_left'|'look_right'|'look_down'} EyeFocus */
/** @typedef {'nod'|'tilt_left'|'tilt_right'|'shake'|'none'} HeadMovement */

export const STATES = Object.freeze([
  'sleeping', 'meditation', 'wakeUp', 'idle', 'listening', 'thinking', 'speaking',
]);

export const EMOTIONS = Object.freeze(['happy', 'serious', 'excited', 'sad', 'surprise', 'neutral']);

export const GESTURES = Object.freeze([
  'wave', 'point', 'open_hand', 'explain', 'welcome', 'nod', 'shake_head', 'shrug', 'hands_together', 'none',
]);

export const EYE_FOCUS = Object.freeze(['user', 'look_left', 'look_right', 'look_down']);

export const HEAD_MOVEMENTS = Object.freeze(['nod', 'tilt_left', 'tilt_right', 'shake', 'none']);

/**
 * @typedef {Object} AvatarSignals
 * @property {boolean} [isListening] - Mic actively recording.
 * @property {boolean} [isThinking] - Waiting on the model, no output yet.
 * @property {boolean} [isSpeaking] - Streaming a reply or a TTS line is playing.
 * @property {boolean} [justGreeted] - The hover greeting just started.
 * @property {boolean} [hasError] - The last action failed.
 */

/**
 * @typedef {Object} AvatarDirectorState
 * @property {AvatarState} state
 * @property {Emotion} emotion
 * @property {number} emotionIntensity - 0.0 - 1.0
 * @property {Gesture} gesture
 * @property {HeadMovement} headMovement
 * @property {EyeFocus} eyeFocus
 * @property {boolean} lipSync
 * @property {boolean} blink
 * @property {'slow'|'normal'|'fast'} breathing
 * @property {number} animationSpeed
 * @property {AvatarState} returnState
 */

const BASE = Object.freeze({
  emotion: 'neutral',
  emotionIntensity: 0.3,
  gesture: 'none',
  headMovement: 'none',
  eyeFocus: 'user',
  lipSync: false,
  blink: true,
  breathing: 'normal',
  animationSpeed: 1.0,
  returnState: 'idle',
});

/**
 * Derive the avatar's state from real signals. Priority: error > speaking >
 * listening > thinking > greeting > idle. Pure function — same signals always
 * produce the same state, so it's cheap to call on every render.
 *
 * @param {AvatarSignals} signals
 * @returns {AvatarDirectorState}
 */
export function deriveAvatarState(signals = {}) {
  const { isListening, isThinking, isSpeaking, justGreeted, hasError } = signals;

  if (hasError) {
    return { ...BASE, state: 'idle', emotion: 'sad', emotionIntensity: 0.4, headMovement: 'shake', breathing: 'normal' };
  }

  if (isSpeaking) {
    return {
      ...BASE,
      state: 'speaking',
      emotion: justGreeted ? 'happy' : 'serious',
      emotionIntensity: justGreeted ? 0.55 : 0.35,
      gesture: justGreeted ? 'wave' : 'none',
      headMovement: 'nod',
      lipSync: true,
      breathing: 'normal',
      animationSpeed: 1.05,
    };
  }

  if (isListening) {
    return {
      ...BASE,
      state: 'listening',
      emotion: 'serious',
      emotionIntensity: 0.3,
      headMovement: 'tilt_left',
      eyeFocus: 'user',
      breathing: 'normal',
    };
  }

  if (isThinking) {
    return {
      ...BASE,
      state: 'thinking',
      emotion: 'neutral',
      emotionIntensity: 0.25,
      headMovement: 'tilt_right',
      eyeFocus: 'look_left',
      breathing: 'slow',
      animationSpeed: 0.9,
    };
  }

  return { ...BASE, state: 'idle', breathing: 'slow' };
}

/** Milliseconds between blink attempts while idle/listening (randomised around this). */
export const BLINK_INTERVAL_MS = 4200;
/** How long a single blink lasts. */
export const BLINK_DURATION_MS = 140;
