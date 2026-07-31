/**
 * @module widget/avatar3d/AvatarScene
 * @description Renders the Mixamo character and drives it from avatarDirector
 * state. Self-contained: on any load failure (most likely — no model file has
 * been supplied yet) it calls `onFallback` and renders nothing, so the caller
 * can keep showing the existing 2D avatar instead of a broken scene.
 *
 * Camera framing (position/target below) is a reasonable guess for a
 * head-and-shoulders "portrait" shot of a ~1.7m Mixamo character standing at
 * the origin — nobody has looked at the actual render yet, so treat the
 * numbers as a starting point to adjust once a model is in place, not as
 * verified correct.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { loadMixamoCharacter } from './mixamoLoader.js';
import { BASE_MODEL_URL, CLIP_URLS, ANIMATION_FOR_STATE, ANIMATION_FOR_GESTURE } from './animationMap.js';

function CharacterRig({ characterRef, avatarState }) {
  useFrame(() => {
    characterRef.current?.update();
  });

  // Cross-fade to whatever clip the current director state calls for.
  useEffect(() => {
    const character = characterRef.current;
    if (!character) return;

    const gestureClip = avatarState.gesture && ANIMATION_FOR_GESTURE[avatarState.gesture];
    if (gestureClip && character.play(gestureClip, { loop: false })) {
      // Gesture clips are one-shots; fall back to the state's loop after they
      // finish playing (rough estimate rather than listening for `finished`,
      // since clip length varies per export).
      const timer = setTimeout(() => {
        character.play(ANIMATION_FOR_STATE[avatarState.state] || 'Idle');
      }, 1200);
      return () => clearTimeout(timer);
    }

    character.play(ANIMATION_FOR_STATE[avatarState.state] || 'Idle');
  }, [avatarState.state, avatarState.gesture, characterRef]);

  return null;
}

/**
 * @param {Object} props
 * @param {import('./avatarDirector.js').AvatarDirectorState} props.avatarState
 * @param {() => void} [props.onFallback] - Called once if the base model can't be loaded.
 * @param {() => void} [props.onReady] - Called once the character is loaded and playing.
 * @param {boolean} [props.debugOrbit=false] - Enable mouse-drag camera orbit, for tuning framing during setup.
 */
export default function AvatarScene({ avatarState, onFallback, onReady, debugOrbit = false }) {
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const characterRef = useRef(null);
  const groupRef = useRef(null);

  useEffect(() => {
    let cancelled = false;

    loadMixamoCharacter({ baseUrl: BASE_MODEL_URL, clipUrls: CLIP_URLS })
      .then((character) => {
        if (cancelled) {
          character.dispose();
          return;
        }
        characterRef.current = character;
        groupRef.current?.add(character.root);
        character.play('Idle');
        setReady(true);
        onReady?.();
      })
      .catch((err) => {
        console.warn('[avatar3d] No 3D model loaded, staying on the 2D avatar:', err.message);
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
      characterRef.current?.dispose();
    };
    // Intentionally load once; swapping model files mid-session isn't supported.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (failed) onFallback?.();
  }, [failed, onFallback]);

  if (failed) return null;

  return (
    <Canvas
      camera={{ position: [0, 1.55, 1.05], fov: 32 }}
      gl={{ alpha: true, antialias: true }}
      style={{ background: 'transparent' }}
    >
      <ambientLight intensity={0.7} />
      <directionalLight position={[1.5, 2.5, 2]} intensity={1.1} castShadow />
      <group ref={groupRef} position={[0, 0, 0]} />
      {ready && <CharacterRig characterRef={characterRef} avatarState={avatarState} />}
      {debugOrbit && <OrbitControls target={[0, 1.5, 0]} />}
    </Canvas>
  );
}
