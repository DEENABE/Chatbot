# Chanakya 3D avatar — drop your Mixamo export here

The app looks for these exact filenames in this folder. None are required —
if `idle.fbx` is missing, the app quietly keeps the current 2D avatar and
nothing breaks. Everything else here is optional per-clip.

## 1. Get a character + rig from Mixamo (free)

1. Go to [mixamo.com](https://www.mixamo.com) and sign in with a free Adobe
   account.
2. **Characters** tab → pick one (e.g. "X Bot" / "Y Bot", or any character you
   like — they all come pre-rigged).
3. **Animations** tab → search "Idle" → pick one you like.
   - Turn **In Place** ON if it's offered, so the character doesn't walk out
     of frame.
   - Click **Download**.
   - Format: **FBX Binary (.fbx)**
   - **"With Skin"** — this is the one export that carries the mesh.
   - Save it as `idle.fbx` in this folder.

## 2. Add more clips (optional, each one improves a different state)

For each animation below: search it on the Animations tab, download as
**FBX Binary**, **"Without Skin"** this time (skeleton only — smaller file,
and it reuses the character mesh from `idle.fbx`), save with the exact name:

| Animation to search on Mixamo | Save as             | Used when Chanakya is... |
|---|---|---|
| "Talking" / "Talking 2"        | `talking.fbx`        | replying / greeting out loud |
| "Thinking"                     | `thinking.fbx`       | waiting on the model |
| "Idle Look Around" or similar  | `listening.fbx`      | the mic is recording |
| "Waving"                       | `waving.fbx`         | the greeting starts |
| "Nodding"                      | `nodding.fbx`        | a quick acknowledgement |

Any file you don't provide is skipped — the character just keeps using
`idle.fbx`'s animation for that state instead.

## Important

- All clips **must come from the same Mixamo character** as `idle.fbx`. The
  skeleton (bone names) has to match exactly for a clip to play on the model —
  that's guaranteed if you pick one character and only change the Animations
  tab, but breaks if you mix characters.
- Filenames are case-sensitive and must match the table exactly.
- To change the mapping (different filenames, more states/gestures), edit
  `frontend/src/widget/avatar3d/animationMap.js`.

## Verifying it worked

Nobody has visually confirmed this pipeline renders correctly — there's no
tool available that can look at a WebGL scene. Once `idle.fbx` is in place,
run the app and check the DevTools console:

- `[avatar3d] No 3D model loaded, staying on the 2D avatar: ...` → the base
  model didn't load; the error after the colon says why (usually a wrong
  filename or a bad export).
- `[avatar3d] Clip "X" not found at ...` → that specific optional clip is
  missing; harmless, the state just falls back to Idle.
- No warnings at all + the avatar visibly changes from the flat photo →
  it worked.

Camera framing in `AvatarScene.jsx` (`camera={{ position: [0, 1.55, 1.05], fov: 32 }}`)
is a guess for a head-and-shoulders shot of a ~1.7 m Mixamo character. If the
character is off-screen, too close, or too far, that's the number to adjust —
pass `debugOrbit` to `<AvatarScene />` temporarily to drag the view around and
find better numbers.
