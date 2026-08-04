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
