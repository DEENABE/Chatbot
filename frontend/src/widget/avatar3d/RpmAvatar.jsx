/**
 * @module widget/avatar3d/RpmAvatar
 * @description Mounts a loaded glTF (Ready Player Me) character and gives it
 * a heartbeat: gentle idle sway/breathing on the whole model, plus blink and
 * a talking-mouth pulse through whatever morph targets the model actually
 * shipped with. Deliberately does not attempt limb/head bone animation —
 * guessing bone names across arbitrary RPM exports risks looking broken in a
 * way that's worse than sitting still; morph-target blink/talk is where most
 * of a face reads as "alive" anyway, and it's existence-checked against real
 * data instead of assumed.
 */

import React, { useEffect, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { loadGlbCharacter, BLINK_NAMES, MOUTH_OPEN_NAMES } from './rpmLoader.js';
import { BLINK_INTERVAL_MS, BLINK_DURATION_MS } from '../avatarDirector.js';

/**
 * @param {Object} props
 * @param {string} props.url - Path to the .glb file.
 * @param {import('../avatarDirector.js').AvatarDirectorState} props.avatarState
 * @param {() => void} [props.onReady]
 * @param {(err: Error) => void} [props.onError]
 */
export default function RpmAvatar({ url, avatarState, onReady, onError }) {
  const groupRef = useRef(null);
  const characterRef = useRef(null);
  const blinkState = useRef({ next: performance.now() + BLINK_INTERVAL_MS, closedUntil: 0 });
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadGlbCharacter(url)
      .then((character) => {
        if (cancelled) {
          character.dispose();
          return;
        }
        characterRef.current = character;
        groupRef.current?.add(character.root);
        setLoaded(true);
        onReady?.();
      })
      .catch((err) => {
        if (!cancelled) onError?.(err);
      });
    return () => {
      cancelled = true;
      characterRef.current?.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  useFrame((state, delta) => {
    const character = characterRef.current;
    if (!character || !groupRef.current) return;

    const t = state.clock.elapsedTime;
    const breathSpeed = { slow: 0.55, normal: 0.85, fast: 1.6 }[avatarState.breathing] || 0.85;
    groupRef.current.position.y = Math.sin(t * breathSpeed) * 0.01;
    groupRef.current.rotation.y = THREE.MathUtils.damp(
      groupRef.current.rotation.y,
      Math.sin(t * 0.4) * 0.05,
      3,
      delta
    );

    const now = performance.now();
    if (now > blinkState.current.next) {
      blinkState.current.closedUntil = now + BLINK_DURATION_MS;
      blinkState.current.next = now + BLINK_INTERVAL_MS * (0.6 + Math.random() * 0.8);
    }
    const closed = now < blinkState.current.closedUntil ? 1 : 0;
    character.setMorph(BLINK_NAMES, closed);

    const talk = avatarState.lipSync ? Math.abs(Math.sin(t * 9)) * 0.6 : 0;
    character.setMorph(MOUTH_OPEN_NAMES, talk);
  });

  return <group ref={groupRef}>{loaded ? null : null}</group>;
}
