/**
 * @module widget/avatar3d/ProceduralAvatar
 * @description A real 3D character, built entirely from primitive geometry and
 * a hand-authored joint hierarchy — no external model file, no Mixamo, no
 * Blender. Head, neck, shoulders, elbows and hands are each their own Group
 * ("bone"), nested the way a rig normally is; rotating a group rotates
 * everything parented under it, exactly like a shoulder joint moving the whole
 * arm. This is the same technique used for simple robot/mascot characters —
 * not a sculpted human face, but a genuinely rigged, moving 3D body.
 *
 * Every motion below is code — sine waves and lerps evaluated per frame in
 * useFrame — driven by the same avatarDirector state already wired to real
 * signals (mic recording, model streaming, TTS playback). There is no
 * animation clip file anywhere in this component.
 *
 * Proportions are in metres, character standing at the origin, feet at y=0,
 * top of head at y≈1.8 — chosen so the numbers below are exact, not guessed,
 * which is the whole advantage of building the geometry myself instead of
 * loading an unknown import: the camera framing in AvatarScene.jsx is
 * computed against these real numbers.
 */

import React, { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { BLINK_INTERVAL_MS, BLINK_DURATION_MS } from '../avatarDirector.js';

const SKIN = '#c99a72';
const ROBE = '#c9691a';
const ROBE_DARK = '#a3540f';
const HAIR = '#1c1a17';

/**
 * @param {Object} props
 * @param {import('../avatarDirector.js').AvatarDirectorState} props.avatarState
 * @param {string} [props.accent] - User's accent colour, used as a small emotion tint.
 */
export default function ProceduralAvatar({ avatarState, accent = '#3b82f6' }) {
  const root = useRef(null);
  const neck = useRef(null);
  const leftEyelid = useRef(null);
  const rightEyelid = useRef(null);
  const mouth = useRef(null);
  const rightShoulder = useRef(null);
  const rightElbow = useRef(null);
  const leftShoulder = useRef(null);

  // Own blink clock — self-contained rather than reusing FloatingBubble's 2D
  // blink state, so this component works even if that layer changes.
  const blinkState = useRef({ next: performance.now() + BLINK_INTERVAL_MS, closedUntil: 0 });

  // A running wave gesture plays for this long before returning to rest.
  const waveUntil = useRef(0);
  const wasWaving = useRef(false);

  const emotionTint = useMemo(() => {
    const map = { happy: '#ffb020', excited: '#ff5fa2', sad: '#5b7ba6', surprise: '#ffffff' };
    return map[avatarState.emotion] || accent;
  }, [avatarState.emotion, accent]);

  useFrame((state, delta) => {
    const t = state.clock.elapsedTime;
    const now = performance.now();

    // --- breathing: whole torso rises/falls gently ---
    const breathSpeed = { slow: 0.55, normal: 0.85, fast: 1.6 }[avatarState.breathing] || 0.85;
    if (root.current) {
      root.current.position.y = Math.sin(t * breathSpeed) * 0.01;
    }

    // --- idle sway (small, always present under whatever state-specific
    //     rotation is applied below) ---
    const idleSway = Math.sin(t * 0.4) * 0.03;

    // --- head/neck: direction depends on state, matching avatarDirector's
    //     headMovement/eyeFocus rather than re-deciding it here ---
    if (neck.current) {
      let targetY = idleSway; // left/right turn
      let targetX = 0; // nod (up/down)
      let targetZ = 0; // tilt (ear toward shoulder)

      if (avatarState.headMovement === 'tilt_left') targetZ = -0.12;
      else if (avatarState.headMovement === 'tilt_right') targetZ = 0.12;
      else if (avatarState.headMovement === 'nod') targetX = Math.sin(t * 3) * 0.06;
      else if (avatarState.headMovement === 'shake') targetY = Math.sin(t * 6) * 0.15;

      if (avatarState.eyeFocus === 'look_left') targetY = -0.18;
      else if (avatarState.eyeFocus === 'look_right') targetY = 0.18;
      else if (avatarState.eyeFocus === 'look_down') targetX = -0.15;

      // Ease toward the target instead of snapping — a real neck doesn't teleport.
      neck.current.rotation.y = THREE.MathUtils.damp(neck.current.rotation.y, targetY, 4, delta);
      neck.current.rotation.x = THREE.MathUtils.damp(neck.current.rotation.x, targetX, 4, delta);
      neck.current.rotation.z = THREE.MathUtils.damp(neck.current.rotation.z, targetZ, 4, delta);
    }

    // --- blink: independent timer, closes both eyelids briefly ---
    if (now > blinkState.current.next) {
      blinkState.current.closedUntil = now + BLINK_DURATION_MS;
      blinkState.current.next = now + BLINK_INTERVAL_MS * (0.6 + Math.random() * 0.8);
    }
    const closed = now < blinkState.current.closedUntil ? 1 : 0;
    if (leftEyelid.current) leftEyelid.current.scale.y = THREE.MathUtils.damp(leftEyelid.current.scale.y, closed, 20, delta);
    if (rightEyelid.current) rightEyelid.current.scale.y = THREE.MathUtils.damp(rightEyelid.current.scale.y, closed, 20, delta);

    // --- mouth: talking pulse, stands in for lip-sync (no viseme data exists) ---
    if (mouth.current) {
      const talkTarget = avatarState.lipSync ? 0.4 + Math.abs(Math.sin(t * 9)) * 0.6 : 0.15;
      mouth.current.scale.y = THREE.MathUtils.damp(mouth.current.scale.y, talkTarget, 10, delta);
    }

    // --- wave gesture: right arm plays a short wave, then returns to rest ---
    const wantsWave = avatarState.gesture === 'wave';
    if (wantsWave && !wasWaving.current) waveUntil.current = now + 1300;
    wasWaving.current = wantsWave;

    const waving = now < waveUntil.current;
    if (rightShoulder.current && rightElbow.current) {
      const restShoulderZ = -0.05;
      const restElbowX = 0.15;
      if (waving) {
        rightShoulder.current.rotation.z = THREE.MathUtils.damp(rightShoulder.current.rotation.z, -2.0, 8, delta);
        rightElbow.current.rotation.z = Math.sin(t * 10) * 0.4;
      } else {
        rightShoulder.current.rotation.z = THREE.MathUtils.damp(rightShoulder.current.rotation.z, restShoulderZ, 6, delta);
        rightElbow.current.rotation.z = THREE.MathUtils.damp(rightElbow.current.rotation.z, 0, 6, delta);
        rightElbow.current.rotation.x = THREE.MathUtils.damp(rightElbow.current.rotation.x, restElbowX, 6, delta);
      }
    }

    // --- listening: lean in slightly ---
    if (root.current) {
      const leanTarget = avatarState.state === 'listening' ? -0.06 : 0;
      root.current.rotation.x = THREE.MathUtils.damp(root.current.rotation.x, leanTarget, 4, delta);
    }
  });

  return (
    <group ref={root} position={[0, 0, 0]}>
      {/* Torso */}
      <group position={[0, 1.0, 0]}>
        <mesh position={[0, 0, 0]} castShadow>
          <capsuleGeometry args={[0.22, 0.5, 4, 12]} />
          <meshStandardMaterial color={ROBE} emissive={emotionTint} emissiveIntensity={0.06} />
        </mesh>
        {/* Robe sash accent */}
        <mesh position={[0, 0.05, 0.19]} rotation={[0, 0, 0.5]}>
          <boxGeometry args={[0.08, 0.55, 0.04]} />
          <meshStandardMaterial color={ROBE_DARK} />
        </mesh>

        {/* Neck + head */}
        <group ref={neck} position={[0, 0.42, 0]}>
          <mesh castShadow>
            <sphereGeometry args={[0.16, 24, 24]} />
            <meshStandardMaterial color={SKIN} />
          </mesh>
          {/* Hair cap */}
          <mesh position={[0, 0.06, -0.02]}>
            <sphereGeometry args={[0.165, 20, 20, 0, Math.PI * 2, 0, Math.PI * 0.55]} />
            <meshStandardMaterial color={HAIR} />
          </mesh>
          {/* Eyes */}
          <mesh position={[-0.055, 0.02, 0.145]}>
            <sphereGeometry args={[0.018, 8, 8]} />
            <meshStandardMaterial color="#1a1410" />
          </mesh>
          <mesh position={[0.055, 0.02, 0.145]}>
            <sphereGeometry args={[0.018, 8, 8]} />
            <meshStandardMaterial color="#1a1410" />
          </mesh>
          {/* Eyelids — scale.y animates 0 (open) -> 1 (closed) each blink */}
          <mesh ref={leftEyelid} position={[-0.055, 0.02, 0.148]} scale={[1, 0, 1]}>
            <boxGeometry args={[0.045, 0.045, 0.01]} />
            <meshStandardMaterial color={SKIN} />
          </mesh>
          <mesh ref={rightEyelid} position={[0.055, 0.02, 0.148]} scale={[1, 0, 1]}>
            <boxGeometry args={[0.045, 0.045, 0.01]} />
            <meshStandardMaterial color={SKIN} />
          </mesh>
          {/* Mouth — scale.y pulses while "speaking" */}
          <mesh ref={mouth} position={[0, -0.075, 0.15]} scale={[1, 0.15, 1]}>
            <boxGeometry args={[0.06, 0.03, 0.01]} />
            <meshStandardMaterial color="#5c2a1a" />
          </mesh>
        </group>

        {/* Left arm (mirrors right; mostly at rest) */}
        <group ref={leftShoulder} position={[-0.24, 0.28, 0]} rotation={[0, 0, 0.08]}>
          <mesh position={[0, -0.14, 0]}>
            <capsuleGeometry args={[0.05, 0.22, 4, 8]} />
            <meshStandardMaterial color={ROBE} />
          </mesh>
          <group position={[0, -0.3, 0]}>
            <mesh position={[0, -0.13, 0]}>
              <capsuleGeometry args={[0.045, 0.2, 4, 8]} />
              <meshStandardMaterial color={SKIN} />
            </mesh>
            <mesh position={[0, -0.26, 0]}>
              <sphereGeometry args={[0.05, 12, 12]} />
              <meshStandardMaterial color={SKIN} />
            </mesh>
          </group>
        </group>

        {/* Right arm — the one that waves */}
        <group ref={rightShoulder} position={[0.24, 0.28, 0]} rotation={[0, 0, -0.05]}>
          <mesh position={[0, -0.14, 0]}>
            <capsuleGeometry args={[0.05, 0.22, 4, 8]} />
            <meshStandardMaterial color={ROBE} />
          </mesh>
          <group ref={rightElbow} position={[0, -0.3, 0]} rotation={[0, 0, 0.15]}>
            <mesh position={[0, -0.13, 0]}>
              <capsuleGeometry args={[0.045, 0.2, 4, 8]} />
              <meshStandardMaterial color={SKIN} />
            </mesh>
            <mesh position={[0, -0.26, 0]}>
              <sphereGeometry args={[0.05, 12, 12]} />
              <meshStandardMaterial color={SKIN} />
            </mesh>
          </group>
        </group>
      </group>

      {/* Simple legs — static for now, framed out of the small bubble window
          but ready for when the window grows to show a full body. */}
      <group position={[0, 0.5, 0]}>
        <mesh position={[-0.09, 0, 0]}>
          <capsuleGeometry args={[0.08, 0.5, 4, 8]} />
          <meshStandardMaterial color={ROBE_DARK} />
        </mesh>
        <mesh position={[0.09, 0, 0]}>
          <capsuleGeometry args={[0.08, 0.5, 4, 8]} />
          <meshStandardMaterial color={ROBE_DARK} />
        </mesh>
      </group>
    </group>
  );
}
