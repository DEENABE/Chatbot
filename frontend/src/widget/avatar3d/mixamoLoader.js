/**
 * @module widget/avatar3d/mixamoLoader
 * @description Loads a Mixamo-rigged character and its animation clips.
 *
 * Mixamo export convention this expects:
 *   - ONE "With Skin" FBX (the base character export) — this carries the mesh,
 *     the skeleton, and whichever animation you exported it with (usually Idle).
 *   - Any number of "Without Skin" FBX files — each is just the same skeleton
 *     re-animated, with no mesh. Because every clip came from the same Mixamo
 *     character, the bone names match the base model exactly, so its
 *     AnimationClip can be added straight to the base model's AnimationMixer —
 *     no retargeting step needed. This is the standard Mixamo + three.js
 *     pipeline; it only breaks if the without-skin clips came from a
 *     *different* character than the base.
 *
 * Nothing here has been visually verified — there is no tool in this session
 * that can render and look at a WebGL scene. It follows the documented
 * three.js FBXLoader + AnimationMixer pattern; the first real check is you
 * running the app.
 */

import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';

const loader = new FBXLoader();

/**
 * Fetch-check a URL exists before asking FBXLoader to parse it — a missing
 * file otherwise surfaces as an opaque parser error instead of "not found".
 *
 * @param {string} url
 * @returns {Promise<boolean>}
 */
async function exists(url) {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * @param {string} url
 * @returns {Promise<import('three').Group>}
 */
function loadFbx(url) {
  return new Promise((resolve, reject) => {
    loader.load(url, resolve, undefined, reject);
  });
}

/**
 * @typedef {Object} MixamoCharacter
 * @property {import('three').Group} root - The character's scene graph; add this to the scene.
 * @property {import('three').AnimationMixer} mixer
 * @property {Record<string, import('three').AnimationAction>} actions - Keyed by clip name (e.g. "Idle", "Talking").
 * @property {(name: string, opts?: {fadeSeconds?: number, loop?: boolean}) => boolean} play - Cross-fades to a clip; returns false if that clip isn't loaded.
 * @property {() => void} update - Call every frame with no args; internally tracks its own clock.
 * @property {() => void} dispose
 */

/**
 * Load the base character plus every animation clip that actually exists at
 * the given URLs. Clips that 404 are skipped, not fatal — the character still
 * loads and plays whatever it has.
 *
 * @param {Object} args
 * @param {string} args.baseUrl - The "With Skin" FBX (mesh + skeleton + a clip).
 * @param {Record<string,string>} args.clipUrls - clipName -> "Without Skin" FBX URL.
 * @returns {Promise<MixamoCharacter>}
 */
export async function loadMixamoCharacter({ baseUrl, clipUrls = {} }) {
  if (!(await exists(baseUrl))) {
    throw new Error(`Base model not found at ${baseUrl}. Export a "With Skin" FBX from Mixamo and place it there.`);
  }

  const root = await loadFbx(baseUrl);
  // Mixamo FBX exports are typically ~100x too large for a normal three.js scene scale.
  root.scale.setScalar(0.01);
  root.traverse((child) => {
    if (child.isMesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });

  const mixer = new THREE.AnimationMixer(root);
  /** @type {Record<string, THREE.AnimationAction>} */
  const actions = {};

  // Whatever clip shipped with the base FBX (commonly "Idle" / "mixamo.com").
  for (const clip of root.animations) {
    actions[clip.name] = mixer.clipAction(clip);
  }

  // Additional "without skin" clips, loaded in parallel; missing ones are
  // skipped with a console note rather than failing the whole character.
  await Promise.all(
    Object.entries(clipUrls).map(async ([name, url]) => {
      if (!(await exists(url))) {
        console.warn(`[avatar3d] Clip "${name}" not found at ${url} — skipping.`);
        return;
      }
      try {
        const fbx = await loadFbx(url);
        const clip = fbx.animations[0];
        if (!clip) {
          console.warn(`[avatar3d] "${url}" has no animation clip inside it.`);
          return;
        }
        clip.name = name;
        actions[name] = mixer.clipAction(clip);
      } catch (err) {
        console.warn(`[avatar3d] Failed to load clip "${name}":`, err.message);
      }
    })
  );

  let current = null;
  const clock = new THREE.Clock();

  function play(name, { fadeSeconds = 0.4, loop = true } = {}) {
    const next = actions[name];
    if (!next) return false;
    if (current === next) return true;

    next.reset();
    next.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    next.clampWhenFinished = !loop;
    next.fadeIn(fadeSeconds);
    next.play();

    if (current) current.fadeOut(fadeSeconds);
    current = next;
    return true;
  }

  function update() {
    mixer.update(clock.getDelta());
  }

  function dispose() {
    mixer.stopAllAction();
    root.traverse((child) => {
      if (child.isMesh) {
        child.geometry?.dispose();
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        materials.forEach((m) => m?.dispose());
      }
    });
  }

  return { root, mixer, actions, play, update, dispose };
}
