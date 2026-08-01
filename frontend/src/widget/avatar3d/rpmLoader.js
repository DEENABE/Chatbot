/**
 * @module widget/avatar3d/rpmLoader
 * @description Loads a Ready Player Me (or any glTF) avatar — the realistic
 * path to a face that actually looks like the reference the user wants,
 * something hand-coded primitive geometry cannot produce. Ready Player Me can
 * generate a stylised head *from a photo*, including one of Chanakya's own
 * portrait — that's the point of recommending it over Mixamo here.
 *
 * Unlike the Mixamo pipeline, this does not guess bone names to drive limb
 * animation — RPM rigs vary and getting that wrong silently looks broken.
 * What it does do, safely, because both are existence-checked against
 * whatever the actual model shipped with: blink and a talking-mouth pulse via
 * ARKit-style morph targets, which is where most of a face's "alive" feeling
 * actually comes from anyway.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const loader = new GLTFLoader();

async function exists(url) {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    return res.ok;
  } catch {
    return false;
  }
}

/** Candidate morph target names across RPM / ARKit / mixamo-style exports. */
const BLINK_NAMES = ['eyesClosed', 'eyeBlinkLeft', 'eyeBlinkRight', 'Blink', 'blink'];
const MOUTH_OPEN_NAMES = ['mouthOpen', 'jawOpen', 'viseme_aa', 'mouthSmile'];

/**
 * @typedef {Object} MorphMesh
 * @property {import('three').Mesh} mesh
 * @property {Record<string, number>} dictionary - morph name -> influence index.
 */

/**
 * @typedef {Object} RpmAvatar
 * @property {import('three').Group} root
 * @property {MorphMesh[]} morphMeshes - Every mesh on the model with morph targets.
 * @property {(names: string[], value: number) => void} setMorph - Sets the first matching morph target found, on every mesh that has it.
 * @property {() => void} dispose
 */

/**
 * @param {string} url - Path to a .glb/.gltf file.
 * @returns {Promise<RpmAvatar>}
 */
export async function loadGlbCharacter(url) {
  if (!(await exists(url))) {
    throw new Error(`No glTF model at ${url}.`);
  }

  const gltf = await new Promise((resolve, reject) => {
    loader.load(url, resolve, undefined, reject);
  });

  const root = gltf.scene;
  root.traverse((child) => {
    if (child.isMesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });

  /** @type {MorphMesh[]} */
  const morphMeshes = [];
  root.traverse((child) => {
    if (child.isMesh && child.morphTargetDictionary && child.morphTargetInfluences) {
      morphMeshes.push({ mesh: child, dictionary: child.morphTargetDictionary });
    }
  });

  if (morphMeshes.length === 0) {
    console.warn(`[avatar3d] "${url}" loaded but has no morph targets — blink/talking will be static.`);
  }

  function setMorph(names, value) {
    for (const { mesh, dictionary } of morphMeshes) {
      for (const name of names) {
        const index = dictionary[name];
        if (index !== undefined) {
          mesh.morphTargetInfluences[index] = value;
          break; // first matching name on this mesh is enough
        }
      }
    }
  }

  function dispose() {
    root.traverse((child) => {
      if (child.isMesh) {
        child.geometry?.dispose();
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        materials.forEach((m) => m?.dispose());
      }
    });
  }

  return { root, morphMeshes, setMorph, dispose };
}

export { BLINK_NAMES, MOUTH_OPEN_NAMES };
