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
