/**
 * @module widget/avatar3d/animationMap
 * @description Where the Mixamo FBX files live, and which clip name plays for
 * each avatarDirector state/gesture. Edit CLIP_URLS once real files are in
 * public/avatar3d/ — the key is the clip name used in ANIMATION_FOR_STATE
 * below, the value is the exported filename.
 *
 * Files go in frontend/public/avatar3d/ (served as-is, not bundled — see
 * public/avatar3d/README.md). None of these need to exist for the app to run:
 * mixamoLoader skips missing clips, and AvatarScene falls back to the existing
 * 2D avatar if the base model itself is missing.
 */

export const BASE_MODEL_URL = './avatar3d/idle.fbx';

/** clip name -> "Without Skin" export filename. */
export const CLIP_URLS = {
  Talking: './avatar3d/talking.fbx',
  Thinking: './avatar3d/thinking.fbx',
  Listening: './avatar3d/listening.fbx',
  Waving: './avatar3d/waving.fbx',
  Nodding: './avatar3d/nodding.fbx',
};

/**
 * avatarDirector state -> clip name to play. "Idle" is assumed to ship inside
 * the base FBX itself (that's what you exported it "with skin" alongside).
 * Anything not listed here, or whose clip didn't load, falls back to "Idle".
 */
export const ANIMATION_FOR_STATE = {
  idle: 'Idle',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Talking',
  sleeping: 'Idle',
  meditation: 'Idle',
  wakeUp: 'Idle',
};

/** avatarDirector gesture -> a one-shot clip to play on top of the state. */
export const ANIMATION_FOR_GESTURE = {
  wave: 'Waving',
  nod: 'Nodding',
};
