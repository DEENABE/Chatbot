# Chanakya 3D avatar — getting a face that actually looks right

**Default behaviour: the app shows the existing 2D photo.** It only switches
to 3D once `character.glb` exists in this folder — nothing breaks or looks
worse in the meantime.

## Why not hand-coded 3D, or Mixamo?

Two things were tried and both fell short:

- **Hand-built primitive shapes** (spheres/capsules coded directly, no model
  file) — this is a real, moving, rigged 3D character with actual joints, but
  it can never look like a sculpted face. Code can't replace an artist.
- **Mixamo** — great for a rigged *body* with animations, but Mixamo
  characters are stock models; you can't turn a Chanakya photo into a Mixamo
  face.

**Ready Player Me can generate a stylised 3D head from a photo** — including
the actual `chanakya_default.png` portrait already in this app — and exports
a real glTF (`.glb`) with a face, proper materials, and blink/talk-ready morph
targets. That's the realistic path to a result close to what you're after.

## Steps

1. Go to [readyplayer.me](https://readyplayer.me/avatar) (free, no login
   required for a single avatar; sign up if you want to edit it later).
2. Choose **Photo** as the creation method.
3. Upload `frontend/src/assets/chanakya_default.png` (or any clear
   front-facing portrait you want the face to match).
4. Pick a **stylised / cartoon** look if offered — closer to the reference
   image quality than the "realistic" preset.
5. Adjust hair, facial hair, skin tone etc. in the editor to taste.
6. **Download** → this gives you a `.glb` URL or file.
7. Save it as exactly:
   ```
   frontend/public/avatar3d/character.glb
   ```

## What the app does with it

- Loads the glTF and shows it in place of the 2D photo.
- Blink and a talking-mouth pulse are driven through whatever morph targets
  the export includes (Ready Player Me avatars ship with ARKit-style blend
  shapes like `eyesClosed`/`mouthOpen` out of the box, so this should work
  without extra setup).
- Gentle idle sway and a breathing motion are applied to the whole model.
- Deliberately does **not** attempt to rotate individual bones (head turns,
  arm gestures) yet — every RPM export can name its skeleton slightly
  differently, and guessing wrong looks more broken than sitting still. That's
  a good next step once a model is in place and someone can actually look at
  it moving.

## Verifying it worked

Nobody has visually confirmed this pipeline renders correctly — there's no
tool in this session that can look at a WebGL scene. With `character.glb` in
place, run the app and check the DevTools console (Ctrl+Shift+I):

- `[avatar3d] No 3D model loaded, staying on the 2D avatar: ...` → the file
  isn't at the exact path above, or failed to parse.
- No warning, and the avatar visibly changes from the flat photo → it worked.
- `[avatar3d] "..." loaded but has no morph targets` → the model loaded but
  won't blink/talk; re-export with face tracking / ARKit blend shapes enabled.

Camera framing in `AvatarScene.jsx` (a `group` shifted `[0, -1.5, 0]` in front
of a camera at `[0, 0, 0.85]`) is a guess for a roughly human-height RPM
avatar — pass `debugOrbit` to `<AvatarScene />` temporarily to drag the camera
around and find the right numbers once a real model is in place.

## Older, still-present-but-unused code

- `mixamoLoader.js` / `animationMap.js` — the Mixamo FBX pipeline. Not wired
  into `AvatarScene.jsx` anymore, kept in case a downloaded rigged body is
  wanted for full-body animation later.
- `ProceduralAvatar.jsx` — the hand-coded capsule character. Not used by
  default; kept as a working example of code-driven rig animation.
