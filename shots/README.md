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
