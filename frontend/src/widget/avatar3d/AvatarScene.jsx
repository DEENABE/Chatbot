/**
 * @module widget/avatar3d/AvatarScene
 * @description Mounts the 3D character and drives it from avatarDirector
 * state. Renders ProceduralAvatar — a hand-built rigged character, no model
 * file required — so there's something real to look at immediately instead of
 * waiting on a Mixamo export. `mixamoLoader.js`/`animationMap.js` are kept for
 * later: if you do want to swap in a nicer downloaded character, that pipeline
 * still works, it's just not the active path right now.
 *
 * On any genuine WebGL failure (old GPU driver, disabled hardware
 * acceleration) this calls `onFallback` and renders nothing, so the caller
 * can keep showing the 2D avatar rather than a blank/broken canvas.
 *
 * The camera sits at [0,0,0.85] looking down -Z with no rotation, and
 * ProceduralAvatar is shifted so its head sits at world origin — that's
 * exact, computed from the character's own known geometry (see the comment
 * inside ProceduralAvatar.jsx), not a guess. What hasn't been checked is
 * whether it *looks* right: there's no tool in this session that can render
 * and look at a WebGL scene, so the first real look is you running the app.
 */

import React, { useEffect, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import ProceduralAvatar from './ProceduralAvatar.jsx';

/** @returns {boolean} Whether this machine can create a WebGL context at all. */
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
 * @param {() => void} [props.onFallback] - Called once if WebGL isn't usable here.
 * @param {() => void} [props.onReady] - Called once the character has mounted.
 * @param {string} [props.accent]
 * @param {boolean} [props.debugOrbit=false] - Mouse-drag camera orbit, for adjusting framing.
 */
export default function AvatarScene({ avatarState, onFallback, onReady, accent, debugOrbit = false }) {
  const [supported] = useState(supportsWebGL);

  useEffect(() => {
    if (!supported) {
      onFallback?.();
      return;
    }
    onReady?.();
    // Fires once on mount — the procedural character has no async loading
    // step, so "ready" just means "WebGL is usable here".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supported]);

  if (!supported) return null;

  return (
    <Canvas
      camera={{ position: [0, 0, 0.85], fov: 30 }}
      gl={{ alpha: true, antialias: true }}
      style={{ background: 'transparent' }}
      onCreated={({ gl }) => gl.setClearColor(0x000000, 0)}
    >
      <ambientLight intensity={0.75} />
      <directionalLight position={[1.2, 1.5, 1.6]} intensity={1.15} />
      <directionalLight position={[-1, 0.5, -1]} intensity={0.3} />
      {/* Head sits at world origin: torso group is at y=1.0, neck/head pivot is
          a further +0.42 inside it (see ProceduralAvatar.jsx), so -1.42 here
          centres the head exactly in front of the camera. */}
      <group position={[0, -1.42, 0]}>
        <ProceduralAvatar avatarState={avatarState} accent={accent} />
      </group>
      {debugOrbit && <OrbitControls target={[0, 0, 0]} />}
    </Canvas>
  );
}
