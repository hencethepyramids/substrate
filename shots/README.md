# shots

Frames captured from the real thing, on the real GPU, by
[scripts/capture.mjs](../scripts/capture.mjs).

Every expensive bug in this project has been a runtime GPU bug, and every one was found
by looking at a picture: the faceted substrate normals, the diamond glint tiles, the
blown highlight, the separation blanketing every lee face. All four were plainly visible
in a single still. These are committed so that "what it looked like when we said it
worked" is in the history next to the code that made it look that way.

Regenerate any of them with the dev server running:

```
node scripts/capture.mjs --view=wind --biome=desert --sun=40 --out=shots/name.png
```

`--view` `--biome` `--sun` `--bearing` `--wind` `--tonemap` `--overlay` `--settle` are all
injected through `localStorage` before load, so the harness needs no hook into the app —
`core/settings.ts` already reads exactly that key.

**These are not performance evidence.** The harness reports which adapter it got and it
does reach the real card, but headless timings are not the timings you get with a
compositor and a vsync. GPU pass numbers still come from a human with the overlay open.

## Phase 7

- `phase7-figure-stand.png` — snow, sun 22. The figure standing. Eighteen boxes, one per
  bone, skinned through the palette; head, forearms and hands take the bare material and
  everything else the clothed one.
- `phase7-gait-snow.png` — snow, sun 16, mid-stride. Legs split, arms counter-phased
  against them, and the alternating trail of prints behind. The prints are laid by the
  gait's own contacts, so each one is under the foot that made it.

Pass B replaced the boxes with the loft. The two pass A frames above are kept on purpose
as the before: the gait in them is the same gait, which is the point of having drawn it
as boxes first.

- `phase7-loft-stand.png` — snow, sun 28, close. The lofted surface: elliptical rings over
  the rig, domed caps, shoulders inboard of the silhouette.
- `phase7-loft-walk.png` — snow, sun 26, mid-stride and close. What the loft was for: the
  knee bends without a crease because the rings across it share both bones.
- `phase7-loft-desert.png` — desert, sun 14, walking. The whole thing at once — the
  articulated cast shadow, the prints trailing behind, and the dunes from Phase 1.

Pass C put the character on the ground it carves.

- `phase7-ground-snow.png` — snow, sun 20, close, mid-stride. The planted foot is down
  inside its own print with the rim of it visible around the boot. Before this pass the
  foot stood at the original ground height and the print was drawn below it.
- `phase7-ground-desert.png` — desert, sun 16, walking.

Pass E hung a cloth on the back, driven by the air field.

- `phase7-cloak-snow.png` — snow, sun 22, walking. The cape hanging and swaying on the
  default breeze.
- `phase7-cloak-desert.png` — desert, sun 15, wind 0.62, walking. The same cloth in a
  real wind: swept across the body and lifted, on the velocity field that carved the
  dunes behind it.

## Phase 8

- `phase8-normalmap-trench.png` / `phase8-displaced-trench.png` — snow, sun 10, the same
  0.7 m trench with `sys.displacement` off and on. The first is a flat shading band; the
  second is a hollow with a shadowed interior and a lit far rim. That difference is the
  whole of pass A.
- `phase8-displaced-desert.png` — desert, sun 14, walking. Footprints as real geometry,
  each one a depression the light finds rather than a normal pretending to be one.

- `phase7-walk-fixed.png` — snow, sun 26, walking. After the locked-leg fix: both knees
  bend, the trailing leg reaches back into its own print, and the posture stays upright.
  Before this the legs were straight at 97% extension throughout and peaked at 111% —
  past full reach, where the IK clamps and the foot leaves the shin entirely.
- `phase7-run-fixed.png` — snow, sun 26, sprinting after the cadence fix. Stride 1.39 m
  rather than a fixed 0.75, arms counter-swinging, prints far apart. Before this the
  figure took 10.2 steps a second at this speed.
- `phase8-wake-snow.png` — snow, sun 14, sprinting through a 55 deg/s turn. The swept
  wake: a carved channel with a berm raised along its outside edge. The berm is not
  modelled — the substrate stamp is volume-neutral, so pushing material out of the
  middle has to put it somewhere.
- `phase8-wake-desert.png` — the same run in sand, which slumps its channel back toward
  the angle of repose while snow holds the wall. Same code, different element block.
- `phase8-slide-snow.png` — snow, sun 14, sliding off a 63 deg face found by
  `capture.mjs --steep`. The slide crouch, and the wake it carved running back up the
  slope behind. Speed here is gravity's, not the player's: sliding has no target speed.
- `phase8-spray-snow.png` — snow, sun 16, sliding off a steep face. Thrown material, gated
  on the substrate's loose-mass channel and lit by the same sun as the ground it came off.
  Alpha blended rather than additive: a grain of snow hides what is behind it.

## Gait contact sheets

Made by `scripts/filmstrip.mjs`, which samples a whole cycle rather than one instant.
Every animation defect this project has had was invisible in a single still.

- `gait-walk-cycle.png` — 12 frames across one walk cycle, side on.
- `gait-run-cycle.png` — 8 frames across one run cycle, with the spray trailing behind.

## Phase 12

- `phase12-sweep-before.png` / `phase12-sweep-snow.png` — snow, sun 12, viewed side-on so
  the transport crosses the frame instead of running away from the camera. The first is the
  control: featureless ground where the second has a hollow and, one throw further out, the
  bank the material arrived in. 2.2 m³ carried along the character's facing by
  `--sweepFor=4000`, which holds `Z` through the real input path.

  The pair matters more than either frame. A shove that had quietly collapsed into a scoop
  would dig the same hollow and heap nothing, and on this terrain a single frame of it would
  still look plausible — the control is what says the bank is not a dune that was always
  there.

- `phase12-ridge-desert.png` / `phase12-ridge-snow.png` — sun 18, yaw 335, pitch 20, the
  same `--ridge` press in two elements at identical camera and sun. Sand throws up a crest
  with a broad shadowed trough alongside it; snow throws up a sharp-edged wall with the
  ground either side untouched.

  That difference is one number. `srStamped` scales the bowl's rim by `(1 - cohesion)`, so
  the material a ridge stands on comes from beside it in sand (cohesion 0.02) and from
  compaction in snow (0.82). `scripts/probeRidge.mjs` measures the flanks at 46.6% of the
  crest in desert against 7.4% in snow; this pair is that measurement with the lights on.

- `phase12-wall-snow.png` / `phase12-wall-desert.png` — sun 18, yaw 200, pitch 12, the same
  `--wall` press in two elements, photographed 2.5 seconds AFTER it goes up. That delay is
  the subject: both walls are thrown to 1.3 m, and by the time the shutter opens snow is
  still standing at 1.326 m while sand has slumped to 0.316 m.

  Snow hides the character to the shoulders; sand is a low bank they stand clear above.
  Cohesion holds a face that steep and a 34-degree repose does not, and no line in the game
  layer knows which one it is talking to.

  The scalloping along the snow crest is real and is the seventeen stamps that built it, 0.4
  radii apart.

## Phase 13

- `phase13-raise-before.png` / `phase13-raise-snow.png` — snow, sun 20, the same frame with
  `sys.gesture` off and on. Same camera, same sun, the same `C` held, the same mound coming
  up out of the ground in front of the character. In the first the arms hang.

  Both are taken with `--hold`, which presses a key and keeps it down through the shutter.
  Every other verb flag in the harness presses and releases, which is right for anything that
  leaves a mark on the ground — the mark outlives the key. A gesture does not.
- `phase13-sweep-snow.png` — the sweep pose: arms out along the bearing the material is being
  carried, both on the same side rather than counter-phased.
