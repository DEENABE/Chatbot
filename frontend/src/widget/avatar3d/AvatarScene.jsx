/**
 * @module widget/avatar3d/AvatarScene
 * @description Mounts a 3D character ONLY if a real model file is present —
 * default is 2D (the existing photos), because a hand-coded primitive
 * character (ProceduralAvatar.jsx, still in this folder but no longer used
 * here) looked worse than the photo it was replacing. A face that actually
 * looks like Chanakya needs real 3D art, not code.
 *
 * The realistic way to get that: Ready Player Me can generate a stylised
 * head *from a photo* — including the existing chanakya_default.png portrait
 * — producing a real glTF with a face and blink/mouth morph targets. Once
 * that .glb is placed at public/avatar3d/character.glb, this loads and shows
 * it; until then, calls onFallback immediately and the 2D avatar is what's
 * seen, same as before any of this 3D work started. See
 * public/avatar3d/README.md for the exact Ready Player Me steps.
 */

import React, { useEffect, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import RpmAvatar from './RpmAvatar.jsx';

export const GLB_MODEL_URL = './avatar3d/character.glb';

function supportsWebGL() {
  try {
    const canvas = document.createElement('canvas');
    return !!(canvas.getContext('webgl2') || canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

/**
 * @param {Object} props
 * @param {import('../avatarDirector.js').AvatarDirectorState} props.avatarState
 * @param {() => void} [props.onFallback] - Called if there's nothing 3D to show (no model, or no WebGL).
 * @param {() => void} [props.onReady] - Called once a real model has loaded and is visible.
 * @param {boolean} [props.debugOrbit=false]
 */
export default function AvatarScene({ avatarState, onFallback, onReady, debugOrbit = false }) {
  const [webgl] = useState(supportsWebGL);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!webgl) setFailed(true);
  }, [webgl]);

  useEffect(() => {
    if (failed) onFallback?.();
  }, [failed, onFallback]);

  if (!webgl || failed) return null;

  return (
    <Canvas
      camera={{ position: [0, 0, 0.85], fov: 30 }}
      gl={{ alpha: true, antialias: true }}
      style={{ background: 'transparent' }}
      onCreated={({ gl }) => gl.setClearColor(0x000000, 0)}
    >
      <ambientLight intensity={0.8} />
      <directionalLight position={[1.2, 1.5, 1.6]} intensity={1.1} />
      <directionalLight position={[-1, 0.5, -1]} intensity={0.3} />
      <group position={[0, -1.5, 0]}>
        <RpmAvatar
          url={GLB_MODEL_URL}
          avatarState={avatarState}
          onReady={onReady}
          onError={(err) => {
            console.warn('[avatar3d] No 3D model loaded, staying on the 2D avatar:', err.message);
            setFailed(true);
          }}
        />
      </group>
      {debugOrbit && <OrbitControls target={[0, 0, 0]} />}
    </Canvas>
  );
}
