# SUBSTRATE

Four elements, one simulation core. WebGPU, zero assets, hand-written WGSL.

[![CI](https://github.com/hencethepyramids/substrate/actions/workflows/ci.yml/badge.svg)](https://github.com/hencethepyramids/substrate/actions/workflows/ci.yml)
[![Deploy](https://github.com/hencethepyramids/substrate/actions/workflows/deploy.yml/badge.svg)](https://github.com/hencethepyramids/substrate/actions/workflows/deploy.yml)

**Live: https://hencethepyramids.github.io/substrate/**

```
npm run dev            # http://localhost:5173
npm run typecheck      # tsc --noEmit
npm run check:shaders  # static checks over the WGSL
npm run build          # typecheck + shader check + vite build
```

Requires WebGPU (Chrome/Edge 113+, Firefox 141+). There is no WebGL fallback — the
capability gate prints a message and stops.

## Automation

| Workflow | Trigger | Does |
| --- | --- | --- |
| [CI](.github/workflows/ci.yml) | push to `main`, any PR | typecheck, shader check, build, upload `dist` as a 7-day artifact |
| [Deploy](.github/workflows/deploy.yml) | push to `main` | builds with `VITE_BASE=/substrate/` and publishes to GitHub Pages |

**And a third kind of check, which runs the real thing.**
[scripts/capture.mjs](scripts/capture.mjs) drives headless Chromium against the dev
server and brings back a screenshot and the boot console — on the **real adapter**, which
it prints, and which on this machine is the actual card rather than a software fallback.
Settings go in through `localStorage` before load, so it needs no hook into the app.
Frames land in [shots/](shots/). It is not performance evidence: headless timings are not
the timings you get with a compositor, so GPU pass numbers still come from a human.

[scripts/checkWind.mjs](scripts/checkWind.mjs) goes further and *measures*. Some questions
a picture cannot answer — the lee of one dune and the windward face of the next are the
same pixels — so it reads the wind vector the app is actually using and the drawn surface
through its own CPU mirror, and reports the slope distribution. That is where
`air.separation` got its number, and it is also how the terrain turned out to be far
gentler than the registry's own comments claim.

[scripts/checkGait.mjs](scripts/checkGait.mjs) does the same for the walk, and exists
because **foot sliding is invisible in a still**. It is a few centimetres per frame under
a body moving three metres a second; in motion it reads as "something is slightly off"
rather than as anything you could point at. So it walks the character with real key
events, reads each ankle back out of the **baked bone palette** — the matrix the GPU
actually draws, not the gait's own bookkeeping, so the pose, the shortest-arc rotation
and the root transform are all under test — and reports the drift across each whole
contact, the distance from each print to the foot that made it, the stride paced out on
the ground, and whether the contact foot is touching the terrain.

Both of the failures it found on the first run were in the check rather than the code,
which is worth saying plainly: it read the palette's translation column as though that
were the joint position, and it identified the planted foot as whichever one was lower,
which on a downslope is often the one in mid-swing. A measurement is a thing that can be
wrong, and one that agrees with you is not evidence.

Typecheck and build are separate steps on purpose — a type error and a bundling
error should be two distinct red steps, not one ambiguous failure.

**Neither of them looks inside a `.wgsl` file.** Shaders are opaque strings until a
driver sees them, and this project has shipped a green build that rendered nothing
more than once. [scripts/checkShaders.mjs](scripts/checkShaders.mjs) is the step that
does look: it resolves the `#include` graph and fails on an unregistered include, a
`uniforms.x` with no declaration behind it, a uniform or texture the WGSL declares
that no TypeScript ever sets (and the reverse), a texture missing its paired sampler,
a call to a project function nothing declares — which is what a missing `#include` looks
like, and it survives a green build with nothing to show for it — a texture declared but
unreachable from the entry point, which is what an *unnecessary* `#include` looks like and
which silently obliges the pass to bind something it will never read — a WGSL **reserved
keyword** used as an identifier (`let target = ...` parses fine to every tool but the
driver) —
an identifier used above its declaration, and a bare `return;` inside an entry point —
which Babylon's processor turns into invalid WGSL by appending its own `return`. It
does not compile WGSL and cannot tell you the picture is right. It closes the gap
between "builds" and "the driver will accept this".

---

## Status: Phase 9 complete

| Phase | State |
| --- | --- |
| 0 — harness | done |
| 1 — terrain | done |
| 2 — sky, lighting, atmosphere | done |
| 3 — substrate buffer | **done** |
| 4 — surface materials | **done** |
| 5 — air | **done** |
| 6 — fire | **done** |
| 7 — character | **done** |
| 8 — traversal and wakes | **done** |
| 9 — post | **done** |
| 10 — interactions | **done** |
| 11 — game layer | **done** |
| 12 — the bending vocabulary | not started |
| 13 — the bender's body | not started |
| 14 — stakes | not started |

### Phase 0 acceptance

> Empty scene runs, overlay is honest, adding a toggle or slider is one line.

- **Runs.** WebGPU device, capability gate, weighted loading screen, pipelines
  compiled *and drawn* behind the screen before the first visible frame.
- **Honest overlay.** `F1` or `` ` ``. Frame-time graph with median / p95 / 1% low,
  draw calls, triangles, active meshes, per-system CPU breakdown, and per-pass GPU
  timings from real `timestamp-query` — not `performance.now()` around draws. When
  the adapter has no timestamp-query the panel says so rather than showing a number
  it made up.
- **One line.** Every control in the overlay is generated from `SCHEMA` in
  [src/core/settings.ts](src/core/settings.ts). Adding this:
  ```ts
  "sys.myThing": bool({ group: "Systems", label: "My thing", def: true }),
  ```
  gives you a typed `settings.v["sys.myThing"]`, a checkbox in the right group, a
  change subscription, and persistence. `src/ui/overlay.ts` does not change.
- **Biome selector wired from day one.** Three elements are already defined as
  parameter blocks in [src/elements/registry.ts](src/elements/registry.ts) and the
  switch takes effect live — albedo, ambient, ground bounce, haze and sky all move
  without a reload.

### Phase 1 acceptance

> Walk 800 m in any direction, no LOD popping, terrain draw count is exactly 1.

- **One draw call.** An 8-level nested ring clipmap: 160 cells per side, 8.5 cm at
  level 0, 870.4 m radius, **324,424 triangles in one static mesh**. Vertices carry
  `(gridIndex.x, ringLevel, gridIndex.z)` and nothing else — 2 MB, uploaded once,
  never touched again. World placement, per-level snapping, CDLOD morphing and
  displacement all happen in the vertex shader.
- **Analytic derivatives, not finite differences.** [noise.wgsl](src/shaders/lib/noise.wgsl)
  carries exact derivatives through every octave, every domain transform and every
  Jacobian. That is what allows the fBm to *damp its own detail by slope*, which is
  the single largest contributor to the result reading as landform rather than as
  noise, and it gives normals for free.
- **The dunes were longitudinal for four phases.** `sbAniso` divided the *along-wind*
  coordinate by `duneStretch`, elongating features along the wind into ridges running
  parallel to it — while its own comment said it made "transverse ridges". A transverse
  crest runs perpendicular to the wind, so the elongation has to be across it. The bug
  was invisible by eye (a dune field looks like a dune field either way) and only showed
  up when Phase 5 measured the slope distribution and found the desert was the *flattest*
  of the three biomes: 3.5° at the median, 21° at the very steepest, with no slip face
  anywhere. Dividing the correct component gives 9.4° and 36.1° — past sand's 34° repose
  — with no change to a single registry number. See [shots/phase1-desert-dunes.png](shots/phase1-desert-dunes.png).
- **One heightfield function.** [heightfield.wgsl](src/shaders/lib/heightfield.wgsl)
  is the same construction for all three biomes — swell, wind-sheared dunes, drifts,
  ridged levees, outcrops, channels — differing only by the `TerrainDef` numbers in
  [registry.ts](src/elements/registry.ts). No branch on biome anywhere.
- **Baked once** into a 4096² RG32F field over 2048 m (0.5 m/texel), and **mirrored
  to the CPU** so grounding stands on the surface that is drawn.

### Phase 2 acceptance, pass A

> Sun elevation drives everything. No ambient constant anywhere.

Phase 2 is deliberately two passes. This is the first: the atmosphere and the light
that comes out of it, verified on hardware before the shadow cascades go anywhere
near it. Pass B is the three PCSS cascades and the far-range raymarch.

**Verified on an RTX Lovelace card.** 3 draw calls, 324,424 triangles, main pass
0.22–0.30 ms against a 3.5 ms budget. Sky bakes hold at 3 after boot and never move
again while the sun is still.

- **One atmosphere model.** [atmosphere.wgsl](src/shaders/lib/atmosphere.wgsl) is
  Nishita single scattering with ozone and a multiple-scattering approximation, in
  kilometres. Nothing else in the project is allowed an extinction curve of its own —
  the sky-view LUT, the SH bake and Phase 2's far-range raymarch all include this file.
- **Two baked textures, no readback.** A 256×128 RGBA16F sky-view LUT, and a 16×1
  RGBA32F block holding nine SH irradiance coefficients, the direct sun, the ground
  bounce and the aerial extinction. Materials sample the block directly, so the light
  on a surface cannot drift from the sky drawn behind it. Both rebake only when the
  sun or a sky control moves; the overlay counts the bakes, because a rebake is
  invisible in both the frame graph and the main-pass GPU timing.
- **No ambient constant.** There is no `fAmbient` uniform any more, and no fog colour.
  A surface gets `albedo * (sun * N·L + shIrradiance(n))` and nothing else — both terms
  already carry the Lambert 1/π, so there is no loose constant left to tune.
- **The ground bounce is solved, not dialled.** A ground point sees sky over
  `sky.skyVisibility` of its hemisphere and lit ground over the rest, so its own bounce
  feeds its own illumination; the bake iterates that to convergence. This is what makes
  snow read white rather than grey, and the size of it is measurable: on a 45° face
  pointed directly away from the sun, the bounce is **+66% luminance at a 12° sun and
  +109% at 30°**, and it drops the face's saturation from 0.67 to 0.51. Turn
  `sky.groundBounce` to 0 to watch it go.
- **Elements still differ only by numbers.** `groundAlbedo`, `groundBounce`,
  `turbidity`, `mieG`, `rayleighScale`, `hazeDensity` and `emissiveAmbient` were
  declared in Phase 0 as the atmosphere block and are now all consumed by shared code.
  Volcanic's emission enters through the *lower* hemisphere, so ash glows up at a face
  from below rather than through an ambient term that lights it from everywhere.
- **The LUT's orientation is measured, not asserted.** Babylon's shader processor
  appends `position.y *= yFactor_` to every vertex main, and `yFactor_` is −1 for any
  render target — which a procedural texture always is. Get that backwards and every
  upward ray samples a downward one, the sky contributes nothing, and the scene falls
  back on ground bounce alone. It is also invisible in a heightfield, because
  mirrored noise is still noise, which is how it survived Phase 1. So the data bake
  writes both what the LUT says and what a direct evaluation says for two probe
  directions, and boot bakes it each way and keeps whichever agrees: **0.0003 against
  1.00**. The same trick as the height mirror, for the same reason.
- **Aerial perspective, not exponential fog.** Extinction is the real sea-level
  coefficient; the in-scatter colour is the sky itself, sampled at the horizon of the
  view azimuth — which is where the air between here and a hillside 800 m away actually
  is. `sky.aerialScale` defaults above 1 only because the clipmap still stops at 870 m
  and haze is doing the work the far-range raymarch will take over in pass B.

### Phase 3, the substrate buffer

> Carve it, and it holds. Snow keeps a wall, sand collapses at 34 degrees, ash never
> comes back. One pass, no branch on biome.

The hinge of the project: every phase from 4 onward reads this buffer. Split in two,
for the same reason Phase 2 was — a wrong data layout here is expensive to undo.

**Verified on an RTX Lovelace card.** The relaxation is **0.072–0.105 ms** for a full
1024² pass every frame — about a tenth of the shadow cascades — and the main pass is
unchanged at 0.22 ms, still 3 draw calls. The carve queue never leaves 0.

The acceptance test, read off `substrate.depression`: **the same test pit, a 43° face,
in two biomes.** Snow keeps a crisp blue rim around a red pit, because 43° is nowhere
near its 78° effective limit and nothing moves. Desert loses the rim entirely and the
pit spreads — which is not decay fading it, it is the rim sliding back into the hollow
it came out of, because 43° is past sand's 35°. `substrate.compaction` is a tight
bright disc in snow and nothing anywhere else; `substrate.mass` is the inverse, dim in
snow and bright in ash, because what packs never becomes loose. Desert erases itself in
about twenty seconds and volcanic never does.

#### Pass 1, the buffer and the relaxation

A camera-following 64 m window at 1024², ping-ponged between two RGBA32F targets,
one relaxation pass per frame:

| channel | holds |
| --- | --- |
| R | depression depth, metres below the heightfield. Negative is a heap |
| G | loose mass — the material slump is allowed to move and Phase 5 to lift |
| B | compaction 0..1 — packed snow, wet sand, crushed ash |
| A | phase state, which Phase 6 drives with heat |

- **The window snaps to its own texel grid.** A frame's scroll is therefore a whole
  number of texels, so carrying the buffer forward is an integer copy rather than a
  resample: walking cannot blur what is carved into the ground, and a hollow does not
  creep across the world while you circle it. `debug.showSubstrateWindow` draws the
  square, because its edge fades to nothing by design and a window that has stopped
  following the camera otherwise looks exactly like one that is working.
- **The gather is conservative, not approximately conservative.** A fragment shader
  cannot scatter, so each texel computes both its own outflow and every neighbour's
  inflow to it. `srSlumpFlow` is antisymmetric by construction — both ends of a pair
  pick the same source, read the same two states, and get the same number with
  opposite signs. Material cannot leak into the gaps between texels over a few
  thousand frames.
- **Slump sees the total surface**, terrain included, and the terrain's contribution
  comes off the analytic derivative baked in Phase 1 rather than eight more field
  samples. Over a 6 cm texel that is more faithful than resampling a 50 cm field and
  it costs three instructions instead of thirty-two texture loads.
- **Only loose material moves.** That single gate is why undisturbed ground on a 30°
  dune face does not quietly drain downhill on the first frame the simulation runs.
- **Six numbers, no branch on biome.** `cohesion` carries `angleOfRepose` the rest of
  the way toward vertical — snow's 0.82 over 38° holds 78°, sand's 0.02 over 34° holds
  35°, ash sits just over its own 30° — and the same number resists diffusion.
  `decayHalfLife` is read exactly as the registry writes it, through `2^(-dt/T)`, so
  ash's quoted 1e9 seconds means ash never comes back. The buffer is deliberately
  **not** cleared on a biome switch: carve a pit in snow, switch to desert, and watch
  the same buffer collapse. That is the architectural test in one click.
- **The stamp is volume-neutral by construction.** `(1-u²)e^(-u²)` integrates to
  exactly zero over the plane, so the material a carve pushes down is precisely the
  material it heaps up, and nothing downstream has to trust a fudge factor. Cohesive
  material packs instead of displacing, which is the difference between a clean print
  in snow and a collapsing crater in dry sand.
- **Where a carve lands is measured, not asserted.** The pass derives a texel from
  `vUV` and a world position from that texel; the shared include derives a texel from a
  world position. If those disagree the buffer is perfectly self-consistent and
  completely wrong, every carve lands mirrored about the window centre, and it moves as
  the window scrolls. So boot stamps a pit at an asymmetric offset, reads the profile
  back along an oblique line through it, and compares against a kernel recomputed from
  scratch on the CPU. Same trick as the height mirror and the sky LUT's v flip, because
  both of those were this exact bug.

Try it: **drop test pit**, then the four `substrate.*` debug views.

- **A clamped coefficient is where an element parameter goes to die.** The diffusion
  term shipped pinned against its own explicit-stability ceiling. Once it clamps, the
  coefficient stops tracking `dt`, so spreading becomes frame-rate dependent *and* every
  element fast enough to clamp diffuses identically — `diffusionRate` had quietly
  stopped telling sand apart from ash. It was invisible at 238 fps, where only ash
  clamped, and broken at 60. The gain is now solved against the longest step the
  simulation will take rather than dialled by eye. Worth checking every other clamp in
  the project for the same thing.

#### Pass 2, writing into it

- **Footfalls are phased on ground travelled, not on time.** Stride length is then a
  distance you can measure by walking past your own prints, and it holds at any speed
  and through any frame rate. It is also the exact contract Phase 7 states for its gait
  machine, so the prints will not move underfoot when the real legs arrive.
- **The carve button digs at a rate.** Right mouse, held: depth is metres per second, so
  how long you hold it decides how deep it goes and the frame rate does not.
- **One stamp lands per step, so writes queue rather than overwrite.** A footfall and a
  held carve on the same frame is ordinary, and the second must not silently replace the
  first. The queue is never deep — a sprint lays a print every ninth frame — and both
  its depth and any drops are on the overlay, because a backlog that is not visible is a
  backlog that gets guessed at.
- **The load is the character's; the response is the element's.** A print is the same
  call with the same numbers in all three biomes. Snow keeps it for about two minutes,
  desert erases it in eight seconds, ash keeps it forever. That split is the whole
  architectural claim, and walking is now the shortest way to check it.

#### Not in Phase 3: displacing the geometry

The clipmap's finest spacing is 8.5 cm and most of the 64 m substrate window is drawn at
17–68 cm, so a 24 cm footprint is roughly three vertices at best and one at worst.
Displacing the clipmap by the depression channel would alias the buffer badly and pop
across the CDLOD morph, and no amount of care in this phase fixes that.

So footprint-scale detail becomes visible in **Phase 4**, through the surface shader —
normals off the depression gradient, and the compacted albedo the B channel already
carries. Carves large enough to be real geometry are **Phase 8's** wake, and that will
need the buffer low-pass filtered per clipmap level before it can be displaced without
popping. Until then the buffer is real and the ground is still drawn flat, which is why
the four debug views are the way to see it.

### Phase 4, surface materials

> The substrate stops being a debug view and becomes the picture.

Split three ways, smallest and highest-value first.

#### Pass A, the buffer becomes visible — landed

- **The surface normal comes off the depression gradient, and the gradient is free.** It
  is the analytic derivative of the *same* interpolation the depression came from, off
  the *same* four texels — so the normal cannot describe a surface different from the one
  the buffer describes, and it costs no extra texture reads.
- **Catmull-Rom, and the stencil has to be four wide.** A gradient off plain bilinear is
  constant inside a texel and jumps at the boundary — a footprint becomes a grid of flat
  facets. The obvious repair, smoothstep weights, is *worse*: `du/df = 6f(1-f)` is zero
  at every node, so the normal flattens on a lattice and peaks between. It shipped that
  way for one run and the grid was unmistakable. No 2×2 filter escapes it — matching the
  derivative across a cell boundary for arbitrary samples forces `w'(0) = w'(1) = 0`, so
  any four-texel filter smooth enough to hide its seams has lattice-locked zeros in its
  derivative. Catmull-Rom interpolates exactly, is C1, and its derivative reduces to the
  central difference at every node.
- **Sixteen loads, but only inside the window.** The buffer covers 32 m and the clipmap
  draws to 870, so the common case was sixteen loads for a guaranteed zero. One compare
  skips it, and the branch is screen-space coherent.
- **The geometry is still untouched.** A 24 cm print is three clipmap vertices at best,
  so nothing is displaced — but light does not care whether it was told about a surface
  by a vertex or by a normal, and at this scale the normal is the honest channel. It
  does mean a print shades but does not cast; the cascades see flat ground.
- **`albedoCompacted` finally means what it says.** The compaction channel blends it
  against the loose albedo, so a print in fresh snow is a different *colour*, not just a
  different shape. That number has been sitting in the registry since Phase 0.
- **The rock blend reads the terrain's own normal, not the bent one.** Outcrop is about
  landform — where a hillside is steep enough to shed loose material — and the wall of a
  footprint is not a cliff. Coupling them would paint outcrop around every deep carve.
- **Relief fades out by the window edge**, because a sub-pixel normal perturbation is not
  detail, it is aliasing — and fading it where the buffer already ends leaves one
  boundary in the picture instead of two.

`substrate.relief` to 0 is the A/B for all of it.

**Verified on an RTX Lovelace card.** Both boot probes at 0.01% of a stamp; main pass
0.34 ms against 0.22 before the phase, for sixteen texture loads per lit pixel inside
the window and none outside it.

#### Pass B, the BRDF — landed

**Verified on an RTX Lovelace card.** Main pass 0.32–0.41 ms across all three tonemaps,
so the curve is free; still 3 draw calls. The A/B is decisive: under `none` the glitter
path on a golden-hour dune is a flat white hole with a hard edge and no information in
it. Under `agx` the same pixels have structure, and the highlight stays neutral instead
of shifting hue as it saturates — which is the log-space encode earning its place.

[brdf.wgsl](src/shaders/lib/brdf.wgsl) is the one reflectance model, and it declares no
textures and binds nothing — pure maths — so Phase 7's character takes the same lines
rather than a second opinion about what a highlight looks like.

- **GGX with height-correlated Smith.** The visibility term already carries the
  `1/(4 N·L N·V)` of the microfacet denominator, so there is no loose 4 anywhere.
- **Everything returns a factor, never light.** Diffuse pairs with `sbSunDiffuse()`,
  specular with `sbSunIrradiance()` — which Phase 2 put in the data texture with a
  comment saying it was for exactly this. The atmosphere stays the single source of how
  bright anything is.
- **Dual lobe, because a sand grain has two.** It reflects off its own facet and off the
  film of fines around it, and those are nothing like the same width. `dualLobeMix` 0
  collapses to a single lobe exactly, which is what snow asks for.
- **Subsurface tints only the light that went through the material.** The wrap widens
  N·L; the *extra* light the wrap adds is the part that travelled, so that part gets
  `subsurfaceTint` and nothing else does. Snow's is blue because ice absorbs red over a
  few centimetres of path. This replaces the flat `wrap = 0.18` Phase 1 left behind.
- **Compaction drives roughness as well as albedo.** Packed material is smoother than
  the material it was made from, so a print in snow catches a highlight the powder
  around it does not — a second job for the channel, and no new parameter.

`surface.specular`, `surface.roughness` and `surface.subsurface` are the three views.
Specular IBL is deliberately absent: there is no prefiltered environment yet, only SH
irradiance, so a highlight in shadow has nothing to reflect. That wants a Phase 9 LUT.

**The display transfer came forward from Phase 9 with it, and had to.** A correct
specular is enormous — the glitter path on snow at a low sun lands near 17 in
scene-referred units against a diffuse peak of 0.85, which is simply what a real
highlight is. Under the bare `pow(color, 1/2.2)` every phase before this one shipped,
everything above 1 clips to flat white, so the highlight was not ugly, it was
*undisplayable*. Retuning roughness to stop it blowing out would have been tuning the
BRDF to compensate for a broken transfer. So [tonemap.wgsl](src/shaders/lib/tonemap.wgsl)
lands now — AgX by default, ACES and none behind the `post.tonemap` control that has sat
in the schema since Phase 0 — and the rest of the post chain still belongs to Phase 9.
AgX works in log space, which is what keeps a blown highlight white instead of letting
it drag its own hue toward the primaries. Set `post.tonemap` to `none` to see what the
project looked like before.

#### Pass C, glints and emission — landed

- **A snowfield does not have one microfacet distribution.** It has a few million ice
  crystals, and at any instant a handful happen to bisect the eye and the sun exactly.
  That is a different phenomenon from roughness — it does not smear out with the lobe,
  it *flashes* — and averaging it into the BRDF is precisely what loses it. So glints
  are one facet per lattice cell, cell size from the element's glints per square metre,
  and only the tail of the distribution is kept so they read as scattered sparks rather
  than a shimmering sheet. `glintBasis` offsets the lattice so no two elements sparkle
  in the same pattern.
- **A spark sits inside its cell; it is not the cell.** The first version gave each cell
  one facet with a constant normal, so the whole cell flashed at once — and a flashing
  cell is a square in world space, which is a diamond on screen. It drew a lattice of
  tiles, exactly as visible in `surface.glints`. The lattice sets where a crystal *might*
  be; the crystal is far smaller than the patch of ground it was drawn from.
- **Never narrower than a pixel.** A spark below a pixel is static, not sparkle, so the
  radius is floored at the screen-space footprint — and because widening it would
  brighten the field, the normalisation takes back exactly what the widening added, so a
  receding glint field dims instead of boiling.
- **The facets come from `sbHash2`**, the same and only hash in the project — the one
  Phase 1's gradient noise is built on.
- **They fade out by 26 m**, because sub-pixel sparkle is not detail, it is noise, and
  it crawls. Same argument as the substrate relief fade and the same shape of answer.
- **`emissiveGain` is wired to the phase channel** and is identically zero until Phase 6
  drives it with heat — the same move as `spThermalCoupling` in Phase 3, so Phase 6 only
  has to *write* the channel and cannot introduce a second opinion about what hot
  material looks like.

**All nine `SurfaceParams` fields are now consumed by shared code**, which is the
architectural test for that block: albedo, albedoCompacted, baseRoughness,
subsurfaceTint, subsurfaceStrength, glintDensity, glintBasis, dualLobeMix, emissiveGain.
No branch on biome anywhere in the surface shader.

**Verified on an RTX Lovelace card.** Main pass 0.34 ms, still 3 draw calls, and
`surface.glints` shows scattered points rather than the lattice of tiles the first
version drew. This is the phase where the buffer stops being a debug view: a print in
fresh snow is a shaded dimple with its own albedo and its own roughness, and the glitter
path runs behind it.

### Phase 5, air

> The wind is not a buffer.

#### Pass A, the velocity field — landed

Air over a heightfield is a **pure function** of the heightfield and the free-stream
wind, so storing it would mean keeping a second copy of something already known, in sync
by hand, at a resolution someone has to justify. [air.wgsl](src/shaders/lib/air.wgsl)
declares no texture at all and takes the terrain derivative as an argument, which is what
keeps it that way. Evaluating it costs a dot product and a smoothstep.

Three things happen to wind crossing a dune, and all three fall out of that one dot
product with the slope:

- it **accelerates** up the windward face, because the streamlines compress against
  rising ground — which is why the stoss side is stripped and the trough is not;
- it **separates** past the crest once the lee is steep enough that the flow cannot stay
  attached, leaving a bubble where the near-surface air runs backwards — which is why a
  slip face is where material lands and *stays* rather than being carried onward, and
  therefore why dunes migrate at all;
- it **follows the surface**, which fixes the vertical component exactly and with no free
  parameter: `w = horizontal · grad(h)` is the kinematic boundary condition.

Gusts advect downwind rather than pulsing in place, so a lull travels across the field
the way a real one does. The `wind` debug view shows shear as brightness and separation
as red.

**Known approximation:** separation is decided by the local lee slope, so the bubble sits
on the slip face itself and does not extend downwind into the trough the way a real wake
does — that would need a march upwind to find the governing crest, which is a per-pixel
raymarch. The asymmetry that drives dune migration is the shear differential between
stoss and lee, and that is captured; the reach of the wake is not, and pass B will say
whether it has to be.

#### Pass B1, airborne material — landed

This one *does* carry history, so it does get a buffer — ping-ponged **on the substrate's
own window**: same origin, extent, texel grid and snapping, taken from it every frame
rather than computed a second time. Material crosses between ground and air constantly,
and on a shared grid that exchange is texel-to-texel with no resampling and no way for
the two to disagree about where a cell is.

Three things happen, and they are the whole of aeolian transport:

- **Lift** — loose material past `liftThreshold`, where the wind is *actually* fast
  enough, leaves the ground at a rate set by `windSusceptibility`. Those two numbers have
  been sitting in `SubstrateParams` since Phase 0 waiting for this, and between them they
  are why ash goes up in a breeze and packed snow does not. It is driven by the excess of
  wind **speed** over a fluid threshold, times the speed — which is why aeolian transport
  is so violently sensitive to weather. The first version drove it from `shear`, which is
  a *ratio* to the free stream and sits near 1 on flat ground whatever the weather is
  doing: a gale and a breeze lifted identically and half the field never lifted at all.
  The `airborne` view was simply black, and stayed black until it was measured.
- **Ride** — semi-Lagrangian advection, so a gale cannot outrun the timestep the way
  explicit advection would. The CFL limit stops being a limit.
- **Settle** — suspension survives where the air is moving and drops out where it has
  slowed or separated. That asymmetry is the entire reason material accumulates on a slip
  face instead of being carried onward forever.

**It does not edit the ground.** It records what it owes in an exchange channel, so the
substrate stays the only thing that writes the substrate — and B1 has no feedback loop at
all, which is what keeps a working Phase 3 out of the blast radius.

#### Pass B2, closing the loop — landed

The relaxation pass reads that exchange channel and applies it, shifted by the same
whole-texel window scroll `srPrevAt` uses — that buffer was written in *last* frame's
window, and reading it unshifted would drag every deposit backwards across the ground at
walking pace. The air reads the ground's loose mass, the ground reads the air's debt, and
each sees the other's previous step.

**The exchange is exact. The system is not conserved, and it is worth being precise about
which.** Lift and settle move the same amount the other way, so they cannot invent or
destroy anything between them. But material blows out through the window's open boundary,
and the advection is semi-Lagrangian on a divergent 2D field standing in for a vertical
flux it does not represent. [scripts/checkConserve.mjs](scripts/checkConserve.mjs)
measures it and asserts **one-sidedly**: loss is a tuning matter, but a world that breeds
sand is a runaway.

It did breed sand, at +50% per ten seconds, until it was measured. Plain semi-Lagrangian
treats density as *intensive* — the value rides the parcel unchanged — and density is
not. Where the flow diverges the backward trace contracts, many target cells trace into
one small source region, and every one of them reads the same value. Carrying the
Jacobian of that trace, `1 - div(v)·dt`, is what stops it. Two things cost a round each
and are recorded in the code: measuring that divergence across one 6 cm texel measures
the bilinear heightfield's C0 derivative jumps rather than the flow (and made it five
times worse), and measuring conservation over ten seconds measures the open boundary
rather than conservation, because a parcel crosses the window in about two.

### Phase 6, fire

> Not combustion. Heat driving a phase change.

Combustion privileges one element and leaves the other two with nothing to do. Heat does
not: snow melts, sand needs a great deal before it does anything, and rock goes molten and
then sets. Same pass, same five numbers in `FireParams`, no branch on biome.

#### Pass A, heat and the phase change — landed

- **Phase 6 only had to WRITE the channel.** `phase` has been the substrate's fourth
  channel since Phase 3 and zero ever since, with two consumers already wired and waiting:
  `thermalCoupling` softens cohesion so molten material flows, and `emissiveGain` makes it
  glow. Writing it lit both at once, with no change to either — see
  [shots/phase6-lava-volcanic.png](shots/phase6-lava-volcanic.png).
- **Heat does not advect.** It is *in* the material and the material is not going
  anywhere, which is the whole difference between this pass and the airborne one — and
  why it needs no Jacobian and carries no open-boundary caveat.
- **Latent heat is a plateau, not a ramp.** The phase ramp is `latent` wide, so a material
  with a large one sits part-way through the transition across a broad band of heat rather
  than flipping. Snow's 0.8 is the largest in the registry and it is why a snowfield holds
  at melting point instead of vanishing the moment it is warmed.
- **The phase lag IS the crust.** Volcanic's six seconds against snow's four tenths is
  the difference between a flow that carries a solid skin while the rock beneath it is
  still molten, and a puddle that does not. Compare `heat` against `fuel` in the debug
  views: the gap between them is latent heat plus that lag.
- **It never writes the ground.** The relaxation pass mirrors phase across into the A
  channel, at the very end of its step, so the whole stencil ran on one consistent frame
  of it. The ground stays the only thing that writes the ground — the same rule the
  airborne exchange follows.

**Verified on an RTX Lovelace card.** `ignite` is the acceptance test as one click.
Measured through the buffers rather than eyeballed: heat peaks at 0.99 about 1.5 s in and
is already falling by 4 s, while phase is *still climbing* at 8 s and reaches 0.72. That
gap is the crust, in numbers.

#### Pass B, the light pool — landed

Molten rock does not merely glow, it **lights things**, and a surface lit only by its own
emission reads as a decal. There is no light list and there does not need to be one: the
heat buffer already knows where every hot cell is, so the pool is an area light that
happens to be stored as a texture, integrated by sampling a disc around the shaded point.
Seven taps on a golden-angle spiral with `sqrt` spacing, so equal *area* sits behind each
one; falloff is inverse-square with a `+1` so a cell underfoot cannot go singular.

It is gated on the element's emissive gain, which is a uniform — so snow and desert never
take the taps at all.

**Two magnitudes were wrong and only measurement found them.** `fire.igniteFrames`
counted *frames*, which made an ignition four times hotter at 60 fps than at 240 and left
peak phase at 0.072 — barely into the transition, which is why the ground would not go
properly molten. It counts seconds now, like everything else in this project. And
`sbEmissive` carried a `× 4.0` from Phase 4 that had **never once been exercised**,
because `phase` was zero until Phase 6 existed to write it; the first time it ran it put
several metres of ground at radiance 2 and AgX did exactly what AgX is for, rolling it
off into a flat white hole. 1.8 keeps its hue against a reference surface of 1.0.

#### Pass C, crust — landed

A uniform molten disc is the wrong **shape** for lava however well its brightness is
tuned, and no amount of magnitude fixes that. What makes lava read as lava is that most
of it is dark, cooled plate, and the glow comes out of a network of cracks between them.

The cracks are the **zero-crossings of gradient noise** — `abs(n)` near zero traces a
connected web of curved lines, which is how a cooling skin actually fractures, and it
costs two noise evaluations rather than a texture. Two octaves so the plates are not all
one size, and the crack width scales with heat, because hot rock cannot hold a skin
together. See [shots/phase6-crust-volcanic.png](shots/phase6-crust-volcanic.png).

**The light pool had to learn about it.** The pool integrates `phase` — how molten the
ground is — but what escapes is phase *times the crust*, and the crust hides most of it.
Left alone it lit the plates almost as brightly as the cracks and washed the whole point
of having crust straight back out. It is now scaled by the crust's mean transmission, so
the pool and the surface casting it stay consistent as the `fire.crust` dial moves.

#### Pass D, smoke — landed

**Smoke did not need a buffer of its own.** It is airborne material that happens to be
hot, so it lives in the spare channel of the Phase 5 airborne buffer — and gets the wind,
the semi-Lagrangian advection and the Jacobian correction for free, all of it already
written and already measured. A fourth ping-pong pair would have been a second copy of
work that was done.

- **Hot ground makes it, the wind takes it, and it thins as it goes.** There is no
  buoyancy term and there cannot be one: this is a column density on a flat grid, so
  "rising" has nowhere to rise to. Thinning stands in for a plume climbing out of the
  layer the buffer represents — which is also why smoke fades rather than settling.
  Material comes back down; smoke does not.
- **It is marched, not looked up.** Sampling at the shaded pixel would make smoke a decal.
  Marching the ground track between the eye and the pixel is what makes a plume *obscure*
  what is behind it, and why a glancing view through one accumulates far more than a view
  straight down onto it.
- **It is lit by the sky it sits under**, through the same `sbHazeColor` the aerial
  perspective uses, so it is grey at noon and orange at dusk with no colour of its own to
  keep in sync.
- **Thinning sets the plume's length as much as its density.** Lifetime × wind speed is
  how far it reaches: at 0.28/s it outran the entire 64 m window and read as global fog
  rather than as a plume. 0.6/s is about 21 m at a fresh breeze.

#### Pass E, embers — landed

The first geometry since the clipmap, and built the same way: **the vertex buffer carries
an index and nothing else.** There is no CPU particle system, no per-frame upload and no
state — a particle is a pure function of its index and the clock, so the buffer that would
normally hold positions and lifetimes is replaced by a hash.

**The fire decides which particles are real, not the CPU.** Each ember samples the heat
where it was born and collapses to a degenerate quad if that spot is cold, which is why
one static mesh serves a fire of any shape and why this costs one draw call whether the
world is burning or frozen. It also means a small fire makes few sparks without anyone
arranging that.

Three mistakes on the way in, and the last is the one worth remembering:

- **`sbHash2` returns a unit vector.** It is the gradient hash Phase 1's noise is built
  on, so its components are the cosine and sine of one angle and always land on a circle.
  Using them as a pair of independent coordinates put every ember on a **ring at half the
  window's width from its centre** — never near any fire, which is why not one of them
  ever lit. The angle is the uniform quantity; that is the number to take.
- **Brightness peaked at birth**, which is exactly when an ember is still at ground level
  and inside the depth buffer's idea of the ground. Every particle drew, and every
  particle spent its bright moment buried.
- **Size followed the fade**, so a spark shrank to nothing by the time it had climbed
  clear of the pool that launched it. It dims as it rises; it does not evaporate.

### Phase 7, character

#### Pass A, the skeleton and the gait — landed

**The bean is gone.** Eighteen bones written down in code, a solved walk cycle, analytic
two-bone IK for the legs, and GPU skinning shared with the shadow cast.

**The cycle is phased on ground travelled, not on time** — which is not a new decision,
it is the contract [Phase 3 wrote down](#pass-2-writing-into-it) three phases before
there were any legs to honour it. The payoff is that **a planted foot does not move**.
Stance is not the foot animating slowly backwards; it is the foot at a fixed world
position while the body travels past it. Feet cannot slide because nothing in the solve
gives them anywhere to slide to, and the prints laid in Phase 3 stayed exactly where they
were when the real legs arrived on top of them.

Measured on the card, walking and sprinting, by [checkGait.mjs](scripts/checkGait.mjs):

| | walk (3.2 m/s) | sprint (7.7 m/s) |
| --- | --- | --- |
| stance drift, worst of all contacts | **0.0 cm** | **0.0 cm** |
| body travel per frame, for scale | 1.4 cm | 3.3 cm |
| cadence | 3.1 steps/s | 3.6 steps/s |
| leg extension, median | 82% | 71% |
| print to the ankle that made it | 0.5 cm | 2.7 cm |
| stride paced out between prints | **1.027 m** (gait chose 1.027) | **2.128 m** |
| contact foot against the terrain | 0.0 cm float, 0.0 cm sink | 0.0 cm / 0.0 cm |

**The footfall moved out of the carve pass and into the gait.** Phases 3 to 6 kept their
own copy of the stride phase there, because there were no legs to ask. Two copies of
"which foot, and where" is exactly how prints drift out from under the feet that made
them, so the gait now owns the contact and `carve.ts` reads it. What stayed behind is the
half that is about the *ground* — how wide a foot is and how hard it presses.

Things worth writing down:

- **The pelvis bob is not a chosen number.** With the feet split by one stride at contact,
  each is half a stride from the body, so a leg of fixed length can only reach the ground
  by dropping the hip through the sagitta of that triangle — 8.5 cm at the default stride.
  At mid-stance the leg is vertical and the hip rides at full height. Moving the stride
  slider therefore changes the walk rather than breaking it.
- **The bank into a turn is the real balance angle**, `tan(bank) = v·ω/g` — the sum a
  cyclist does. It falls out of how fast the character is actually turning rather than out
  of a curve someone drew.
- **The settle blend must not touch the planted foot.** Blending *both* feet toward a
  neutral stance as the character stops is the obvious thing to write and it is wrong: a
  foot in stance is already standing somewhere it legitimately landed, and dragging it
  toward where the body has since got to is foot sliding — the one failure the whole
  design exists to prevent. It showed up as a few centimetres of creep in the first half
  second of every walk, invisible in motion and plainly there in the measurement. The
  planted foot now holds and the swinging one comes down beside it, which is also what
  stopping actually looks like.
- **Rest orientations are all the identity, so there are no inverse bind matrices.**
  Everything is solved in character space with the origin under the feet, which collapses
  a bone's inverse bind to a translation by minus its own joint, and skinning to
  `root · translate(head) · R · translate(−restHead)`. No quaternion chain and no bind
  pose to keep in step with anything.
- **The shadow cast skins from the same include.** It cannot go through the shared
  world-transform cast, because the figure has no world matrix — its pose lives entirely
  in the bone palette, and a cast that ignored the palette would draw the shadow of a rest
  pose standing at the origin while the character walked away from it.
- **The palette length must stay a literal** in `uniform skBones: array<vec4f, 54>`.
  Babylon's WGSL processor reads that number straight out of the declaration to size the
  uniform buffer, so a named constant would leave it sized zero.

**Drawn as boxes, deliberately.** The gait is the hard part of this phase and a box figure
shows it more honestly than a lofted one will: a foot that slides, a knee through its own
limit or a bone weighted to the wrong joint is unmissable on a box and easy to miss under
a smooth skin. Pass B replaces the geometry and touches nothing else — the skinning path,
the palette and the solve are already what they will be.

Still 4 draw calls: the figure replaced the capsule rather than adding to it.

#### Pass B, the loft — landed

Rings of vertices swept along chains of bones, with an **elliptical** cross-section whose
two radii come from a small table per chain. A body is wider than it is deep almost
everywhere and the ratio changes down its length, so one radius per ring gives a bundle of
sausages and two gives a figure. 3,336 triangles over 1,682 vertices, built once at boot.

Exactly as promised, **pass B changed the geometry and nothing else** — [loft.ts](src/character/loft.ts)
is the new file, and the gait, the palette, the solve and the shadow cast are untouched.
[checkGait.mjs](scripts/checkGait.mjs) still passes all four claims unchanged, which is
what makes that a real statement rather than a hope.

- **What makes a joint bend smoothly is the rings either side of it sharing both bones.**
  Pass A weighted every vertex rigidly, which is right for boxes and would put a hard
  crease at every knee here. Rings inside a blend window take a weight in both bones, and
  **that weight must be exactly one half at the joint itself** — the two bones swap roles
  as a ring crosses, so any other value makes the ring just below and the ring just above
  resolve to different blends and creases along the seam the window exists to remove. The
  window is sized from the local radius, so the volume that linear blend skinning loses on
  a hard bend is spread over a length comparable to the limb's own thickness.
- **The caps are domes, not poles.** Fanning the last ring to a single vertex is three
  lines shorter and draws a *cone*: it put a spike on the crown of the head, a point
  between the legs, and a pair of hard angular tabs where the arms leave the shoulders —
  epaulettes. Two intermediate rings on a quarter ellipse is the whole fix.
- **The sweep stops short and the dome finishes the job.** Running rings to the end of the
  chain and adding a cap on top would have put the crown eight centimetres above the
  height the rig says the figure is, and the toe past the end of the foot.
- **The shoulder joint moved inboard**, 0.185 m to 0.158 m. The first version put it out at
  the silhouette's edge, so the arm's own cap stood proud of the chest however the cap was
  shaped. The deltoid is the torso's width; the joint it turns about is well inside it.
- **Winding is derived, not guessed.** The cross-section frame is built right-handed on
  purpose, which makes `dP/dθ × dP/ds` point outward, which fixes the triangle order and
  the analytic normals together. Back-face culling went straight back on and the figure
  came out the right way round first time.

Still 4 draw calls.

#### Not in pass A

- ~~**The figure does not sink into its own prints.**~~ Closed by pass C.
- **The cast shadow detaches slightly at a low sun.** The normal-offset bias in
  `shVisibility` is tuned for terrain, and a leg is a much thinner caster than a dune.
- **The cloak bone is posed but undrawn.** Bone 17 hangs off the chest and goes where the
  back goes, and it has no geometry: a cape that does not move while you run reads worse
  than no cape at all. Pass E brings the solver and the geometry together, driven by the
  same wind that already carries the smoke.
- **`mover.ts` survived.** The plan said Phase 7 would replace it with the gait machine;
  it did not, and that is the better outcome rather than a shortcut. The mover's contract
  — a feet position, a facing, a distance travelled — is exactly the gait's *input*, so
  the gait consumes it instead of absorbing it, and locomotion stays separable from the
  legs that draw it.

#### Pass C, the ground — landed

The character now stands on the surface it has **carved**, not the one underneath it.

Until this pass the depression lived only in a GPU buffer while the gait ran on the CPU,
so a boot planted on the undisturbed heightfield with its own print drawn ten centimetres
below it. [groundProbe.ts](src/substrate/groundProbe.ts) closes that: a 64-texel tile of
the substrate, rendered **through the same `substrateBuffer` include the terrain shades
with** and read back asynchronously.

**The obvious fix is the wrong one.** Keeping a CPU copy of the stamps and decaying it to
approximate the relaxation would put a second, simpler physics beside the real one, and
the two would agree at first and drift for ever after — the exact self-consistent-but-wrong
shape this project keeps finding. There is no second model. One source of truth, sampled
twice.

- **A planted foot is fixed horizontally and live vertically.** The plant's height is
  recorded at contact, which is *before* the print exists — the carve pass stamps it on the
  same frame. Holding the foot there left the boot hanging over its own print by the full
  depth of it, measured at 10.7 cm. The ground is allowed to move under a planted foot, and
  it does; only X and Z are pinned, which is all the no-sliding claim ever needed.
- **The sink damping is anti-pop, not soil mechanics**, and sizing it as though it were
  physics is what made it wrong. At 45 per second the foot lagged its own print through a
  third of every contact; a sprint's stance is only 78 ms long, so the time constant has to
  be a couple of frames — 10 ms — and no more.
- **The pelvis cap is the bob, generalised.** The hip can be no higher above either ankle
  than a leg can span at that horizontal distance. On flat ground that is exactly the
  sagitta that gives the bob; on a slope, or over a print, it binds and the figure crouches
  instead of leaving a straight leg still short of the floor. One triangle, two jobs.
- **The foot pitches onto the slope it is standing on**, measured over the length of the
  foot rather than differentiated at a point — the substrate's 6 cm texels have derivative
  jumps at every one of them, and a point derivative flicks between them as a foot crosses.
  Pitch only: the shortest-arc rotation the rig uses leaves twist about the bone
  undetermined by construction, so sideways roll needs a frame the skeleton does not carry.

Measured on the card, by [checkGait.mjs](scripts/checkGait.mjs), now that it can tell the
two surfaces apart:

| | walk | sprint |
| --- | --- | --- |
| contact foot vs the **drawn** surface, settled | 0.0 cm | 0.3 cm |
| depth of print it is standing in | 11.0 cm | 15.9 cm |
| below the undisturbed heightfield | 9.9 cm | 12.0 cm |
| ground probe round trip | 14.1 ms | 9.2 ms |
| of contact spent settling | 3.2% | 29.1% |

**Turning was measured too, and it is fine.** The worry was that a body whose facing keeps
rotating would wind away from feet that are pinned in world space. It does not: walking a
full circle at 42 deg/s and two and a half circles at 113 deg/s leaves stance drift at
0.0 cm and every other claim unchanged, because the swing foot re-predicts its landing
every frame and therefore steers into the turn while the planted one holds. `--turn` in
the harness is what settled it. **This is why there is no pass D** — the pass that was
pencilled in to fix pivoting had nothing to fix.

**The sprint number is the honest cost and it was measured, not guessed.** The readback is
about one and a half frames old, which is 5% of a walking stance and 20% of a sprinting
one — so at a sprint the foot spends the first third of each contact catching up with a
print it has not been told about yet. Latency is the price of having one source of truth
instead of two, and it is the right price.

Two things worth flagging rather than fixing here: a sprint stamps a print **twice as
deep** as a walk while the foot is on it for a quarter as long, which is backwards from
how a real footfall works and is now visible because the character actually stands in it;
and 11 cm at a walk reads closer to deep snow than to a dusting. Both are `char.footDepth`
and its load curve, and both are one slider.

#### Pass E, the cloak — landed

A Verlet cloth on the character's back, and **the wind is the same wind**. Not a similar
one, not a sine: the velocity comes from `sbAirAt` through [airProbe.ts](src/air/airProbe.ts),
which is the include the smoke plumes and the embers ride. So the cape fills on an exposed
crest and slackens in the lee of the dune the character has just walked behind, without
anyone writing a rule that says so, and it agrees with a plume drifting past it because
they are reading the same function.

`AirField.base` was right there and would have been the easy answer — but it is the
*ambient* wind, before the terrain has had its say. Measured over a walk, the flow at the
cloak runs **0.77× to 1.11× the ambient**, with up to 1.1 m/s of vertical. The harness
prints "terrain IS modulating it" or "FLAT — the probe is echoing the ambient wind",
because a probe that quietly returned the base vector would look completely correct.

Solved on the CPU, unlike almost everything else here, and deliberately: the cloth has to
stay off the body, and a capsule collision against the figure's own spine is a few lines
against a skeleton that already lives on this side of the bus.

**Three bugs, and the measurement found all three.** The stills looked plausible each time.

- **The collision capsule swallowed the seam.** Its radius was 0.20 m and the cloak is
  sewn 0.125 m behind the spine, so every particle below the pinned row was ejected 10 cm
  backwards on every substep while the row above it was pinned. The top edge fought the
  pins for ever and stretched **76%** past its rest length. The cape came out crumpled onto
  one shoulder, which reads exactly like a solver that has simply diverged. A collision
  radius has to be smaller than the offset the thing is attached at.
- **The body walked out from under the cloth.** The seam is pinned to a body moving at
  3.2 m/s and the rest length between rows is 6.8 cm, so the anchor jumped 40% of an edge
  per substep and the entire strain landed on row 0 — a median **28%** stretch and peaks
  over **400%**, always on the same edge. Relaxation cannot fix it: Gauss-Seidel propagates
  one row per iteration, so the correction is still crawling down the sheet when the next
  substep pulls the seam away again. The fix is to carry every particle along with the
  seam — position and previous position both, so velocity is untouched — which moves the
  solve into the body's frame where it only ever sees the residual. **1.3% after.**
- **And that fix silently deleted the apparent wind.** In the body's frame a particle
  resting against the back has zero velocity even at a full sprint, so the drag term saw
  only the ambient breeze and a running cape hung dead straight. It looked like stiff
  cloth and was actually a missing term. The frame's own velocity goes back in at the
  aerodynamics and nowhere else.

Two things that are tuning rather than bugs, recorded because both looked like solver
failures first: fourteen relaxation iterations with a 0.25 bend constraint produced a
**rigid dark rectangle** — a solver doing exactly what it was told and cloth doing nothing
anyone would recognise; and the first drag coefficient was about three times too strong,
which is a flag rather than a cape.

Measured, walking and sprinting: cloth edge stretch p50 **1.3% / 6.2%**, p99 2.8% / 7.5%.
`checkGait.mjs` now samples this **every frame** rather than once at the end — the settled
cloth read 1.7% while the walking cloth was at 28%, so an end-of-run sample would have
called all of this fine.

The figure also stopped standing perfectly rigid: two slow oscillations at unrelated
periods — breath, and weight drifting between the feet — faded in by the same `_stand` the
settle already uses, so it is absent the moment anyone walks and needs no second state.

5 draw calls, up from 4.

### Phase 8, traversal and wakes

#### Pass A, the ground becomes geometry — landed

**The substrate stops being a normal map.** Phase 3 wrote down that displacing the buffer
was a Phase 8 job — a 24 cm print is three clipmap vertices at best, and displacing it
naively would alias badly and pop across the CDLOD morph. This is that job.

The displacement happens inside [clipmap.wgsl](src/shaders/lib/clipmap.wgsl), which means
**the shadow cascades come along for free and must** — a shadow cast by the undisplaced
surface is the shadow of a footprint that is not there.

- **A vertex only represents what its own cell can hold.** At level 0 the spacing is 8.5 cm
  against a 6.25 cm buffer texel, so a bootprint is genuinely geometry; by level 3 a cell
  is 68 cm and a print inside it is a sub-cell wiggle that would shimmer every time the
  clipmap snapped. Displacement fades out across that range and the surface shader picks
  up the remainder as a normal, which is what it did for Phases 3 to 7.
- **The filter width is the MORPHED spacing.** A vertex at the outer edge of its level has
  slid onto one of its parent's, and the parent filters at twice the width — so anything
  but `spacing * (1 + morph)` leaves the two disagreeing about how deep the ground is at
  exactly the place they are meant to be the same vertex. That is a crack along every ring
  boundary.
- **Four taps at the quadrant centres**, not the cell corners: a box filter over exactly
  the ground the vertex stands for. Corner taps would be shared with the neighbouring
  vertex and would filter nothing.
- **The surface shader subtracts what the geometry already took.** The vertex reports the
  fraction it displaced, and the fragment adds only the remainder — otherwise a print is
  shaded twice and reads far deeper than the one you can walk into.

`sys.displacement` toggles it, and the A/B is the point:
[phase8-normalmap-trench.png](shots/phase8-normalmap-trench.png) is a flat shading band;
[phase8-displaced-trench.png](shots/phase8-displaced-trench.png) is a hollow with a
shadowed interior and a lit far rim. All six of `checkGait`'s claims still pass unchanged,
which is what says the CPU mirror the character walks on and the geometry the GPU draws
still agree.

**This cost a whole session to land, and almost all of it was spent being wrong.** Worth
recording, because none of it was the maths:

- The first version displaced the vertex and **left its derivative on the bare
  heightfield**, so there was a real hollow in the mesh shaded as though the ground were
  flat. That looks exactly like nothing happening. The normal has to move with the vertex —
  and the same four taps already carry the gradient, being the analytic derivative of the
  interpolation the depression came from.
- `tDisplace` went into the shadow cast's uniform list and not the terrain material's, so
  it silently stayed 0 — **and toggling it still changed the picture**, because the cast
  was displacing while the shaded surface was not. A convincing wrong answer, and exactly
  the disagreement `substrateClipmap` exists to make impossible.
- Several probe rounds were run against a **dev server serving a stale `?raw` import**, so
  two different shaders rendered identically and I concluded things about uniforms that
  were not true. Shader iteration now goes through `npm run build` + `vite preview`, where
  there is no question which shader is running.

The lesson worth keeping: three of those are failures of the *measurement*, not the code,
which is now the fourth time this project has had that happen. A probe is a thing that can
lie, and a probe that renders identically twice is lying.

### Controls

| | |
| --- | --- |
| click canvas | lock pointer (closes the overlay) |
| WASD / arrows | move, camera-relative |
| shift | sprint |
| mouse | look |
| wheel | zoom — writes back into `cam.armLength`, so slider and wheel agree |
| right mouse | carve — digs at `substrate.carveRate` metres per second, held |
| `F1` / `` ` `` | overlay |
| escape | release pointer |

**Verbs** (Phase 10). Every one of them lands at `play.reach` metres directly in front of
the character rather than under a cursor — a third-person camera has no cursor, and pointer
lock is not available to a headless run.

| | |
| --- | --- |
| `E` | ignite — dumps heat where you are pointed. Snow melts and refreezes, so it will not catch; a biome with fuel will |
| `Q` | gather — held. Lifts material out of the ground and into your hands, up to `play.carryCapacity` |
| `F` | place — held. Puts it back as a loose heap, free to slump at the angle of repose |
| `R` | pack — held. Treads the ground down. Moves no material at all: compaction drives roughness, so a packed patch is what the screen-space reflections actually show |
| `T` | throw — launches what you are carrying on a ballistic arc. The volume travels with the projectile, so the books balance mid-flight as well as at the ends |
| `space` | leap — a real vertical solver, apex 1.4 m from a standing start. The landing craters the snow in proportion to how hard it was |

**Bending** (Phase 10 passes F–G). A different grammar from the carrying verbs above: the
terrain moves because it is told to, nothing is held, and there is no capacity. All of it
runs through `substrate.stamp()`, which has been volume-neutral since Phase 3 — driven with
negative depth it raises instead of pressing.

| | |
| --- | --- |
| `Z` | sweep — carry the material in front of you a further `play.sweepDistance` out |
| `X` | draw — carry material from one throw beyond your reach back to arm's length |
| `C` | raise the ground you are aiming at |
| `V` | lower it |
| `G` | pedestal — raise the ground under your own feet and ride it up |
| `B` | ridge — press once and a wave runs `play.ridgeRange` metres away from you, laying a crest as it goes |
| `N` | wall — throw a barrier up across your facing. Whether it stays up is the element's business |

`Z` and `X` are Phase 12 and are a step beyond the three below them: raise, lower and
pedestal act on one *spot*, and these two have a *bearing*. See
[Phase 12](#phase-12--the-bending-vocabulary).

The pedestal is worth describing because nothing implements it. The mover snaps to the
surface every frame it is grounded, so when the surface rises the character rises with it;
and because the leap reads the height the feet are actually at, a jump from the top of a
pedestal is a jump from the top of a pedestal. Measured: rode 154 cm up, leapt from there to
215 cm above the flat. Two passes built for their own reasons compose into a move neither
of them mentions.

In snow, raising ground draws from COMPACTION rather than from a ring around it — the stamp
drives that channel too, and lifting fluffs the material back up. A probe caught this
correcting a comment that had claimed the opposite: the centre rose 83 cm and the ring did
not move at all, because `srStamped` scales the rim by `(1 - cohesion)` and snow is
cohesive. In dry sand the same call scars. Neither behaviour is written in the game layer;
both fall out of the element.

Gather, place and throw all move the same conserved quantity. `substrate.stamp()` is
volume-neutral by construction — a footprint heaps up exactly what it pushes down — so
carrying needed the one operation that deliberately is not: `scoop()` takes a **volume** in
cubic metres and solves for the amplitude from the kernel's closed-form integral, which
makes conservation a property of the interface rather than something a probe has to measure
afterwards.

## Phase 12 — the bending vocabulary

### Pass A: the substrate learns a direction

Everything the substrate could do was radially symmetric about a point. `stamp` displaces
outward into a rim, `scoop` lifts straight up, `pack` moves nothing — so between them they
can raise ground, lower it, or hand it to whoever is holding it, and **none of them can
carry it in a bearing**. A drift pushed aside is not a deeper stamp; it is material that
ends up somewhere it did not start.

`substrate.shove(x, z, radius, dx, dz, volume)` is that operation. The kernel is one
Gaussian minus the same Gaussian somewhere else, which makes it odd about the bisector of
the two and therefore exactly zero over the plane — volume-neutral like the bowl, but for a
different reason worth keeping straight. The bowl conserves because its radial integral
vanishes; this conserves because nothing is created even in principle.

**The amplitude solve is not `scoop`'s, and assuming it was would have been a silent 48%
shortfall** at the geometry a verb actually uses. Where the lobes overlap they cancel, so
the material that crosses the bisector is `erf(|v| / radius)` of a Gaussian rather than all
of it. The shove stays perfectly neutral while being short — it delivers everything it
lifts, it just lifts less than you asked — so no conservation check anywhere could have
caught it. Dividing that erf back out is what makes "move half a cubic metre" true at every
displacement instead of only at long ones.

[scripts/probeShove.mjs](scripts/probeShove.mjs) measures it on hardware, with the world
paused so `dt` is zero and the stamp is the only thing that happens. It **calibrates the
readback's row order against a scoop at a known point before trusting it** — this project
has shipped a self-consistent mirror twice, and a shove that transports along +Z when told
+X passes every volume check ever written.

| | long (4 radii) | short (1 radius) |
| --- | --- | --- |
| volume delivered | 100.00% | 100.00% |
| net created | 3e-15 m³ | 8e-15 m³ |
| bearing asked / measured | 26.57° / 26.57° | 26.57° / 26.57° |
| stray depression outside the lobes | 2.7e-8 m | 2.3e-8 m |

And one independent prediction, which is the line worth trusting most. The centroids do not
sit at the two points named, and should not: cancellation across the bisector pushes each
side's centre of mass outward to `len / erf(len / 2r)`. That is the kernel's **first**
moment, where the amplitude solve is its zeroth, and nothing in the shipped code computes
it — the shader has no erf in it and `substrate.ts` uses erf only to scale an amplitude. The
model says 3.215 m and 2.305 m for displacements of 3.2 m and 1.2 m. The buffer reads
3.215 m and 2.305 m.

One bug found while writing it, and it is the kind this project keeps having. `srStamped`
tested `srStampKind > 1.5` for compaction, which was correct while 2 was the highest kind
there was and routed every shove into the pack branch the moment 3 existed — a branch that
writes no depression at all. A shove would have looked exactly like a shove that did
nothing. It is a band now.

### Pass B: two verbs with a bearing

`Z` sweeps and `X` draws, and they are **one call with the vector reversed**. Sweeping takes
the material at arm's length and carries it further out; drawing takes material one throw
beyond arm's length and carries it back. Both leave the near end of the transport at
`play.reach`, so neither can dump a heap inside the character, and the pair is symmetric by
construction rather than by two blocks of code that have to be kept agreeing.

A rate in **cubic metres**, unlike raise and lower which are a rate in metres of depth. That
is not an inconsistency, it follows from what is conserved: bending commands a height and
the material sorts itself out, a sweep commands a volume and the height follows from how far
it is spread.

The probe drives the real verb layer with a synthetic actor and an explicit `dt` while the
world stays paused — `Verbs.update` takes an `Actor` interface rather than the `Mover`
precisely so this is possible, and it isolates the one thing pass B is responsible for:
does the verb hand the substrate the bearing the character is actually facing? Forward is
`(sin, cos)` of the facing angle, and a shader, a gait and a camera rig in this project each
have their own opinion about which way round that goes. Swap the pair and the verb still
sweeps, still conserves, still reads 100% of its volume, and pushes the drift sideways
instead of away from you.

Ten cases — sweep and draw at 0°, 90°, 180°, 270° and 35° — all carried 0.2200 m³ along the
bearing asked to within 0.00°, with the transport's centre exact.

[phase12-sweep-before.png](shots/phase12-sweep-before.png) and
[phase12-sweep-snow.png](shots/phase12-sweep-snow.png) are the A/B: featureless snow, and
then the same ground after 2.2 m³ has been swept along the facing — a hollow where the
material left and a bank where it arrived, 2.2 m further out. Neither of those is drawn by
anything; both are the same buffer the footprints are in.

**What it deliberately does not do yet.** It sweeps bare ground exactly as willingly as it
sweeps a drift. Moving only the *loose* material would be the richer verb, and the substrate
does track it in the mass channel — but the decision is made in `verbs.ts`, on the CPU, and
nothing there can see the buffer. That is a GPU-side choice and a later pass, and it is the
most interesting thing left in this phase.

### Pass C: a wave that outlives the press

`B` sends a ridge running away from the character. It is the first verb here whose result
outlives its input — the other five command ground for exactly as long as they are held —
and it is also the pass with **nothing new in the substrate at all**. A ridge is a line of
the same volume-neutral bowls `raise` has stamped since Phase 10. The roadmap called this
the cheap one, and it is cheap precisely because "a shape" here means "the same operation,
walked".

**The stamps are spaced in metres, not in frames.** One per frame would make the ridge's
shape a property of the machine it ran on — a smooth bank at 120 fps, a row of separate
lumps at 20 — so the wave asks how far it has travelled since its last stamp and lays as
many as fit. It also keeps the substrate queue honest: one stamp lands per relaxation step,
so a per-frame wave would enqueue exactly as fast as the queue drains and any other verb
held alongside it would overflow. At the default radius the spacing is 36 cm, so a 9 m/s
wave stamps 25 times a second, and the probe reports zero dropped.

**The crest is solved, not dialled.** `play.ridgeHeight` is metres of crest because a line
of overlapping bowls builds up to the kernel's *line integral* over the spacing:
integrating `(1 - u²)e^(-u²)` along the line gives `r√π·e^(-a²)·(½ - a²)`, so the crest
stands at `depth · r√π / 2·spacing`. Pinning the spacing to a fixed fraction of the radius
makes the radius cancel, and the per-stamp depth becomes a pure number.

That one expression also predicts the flanks, which is the part `verbs.ts` never evaluates:
the profile crosses zero at `a = 1/√2` and bottoms out at `a = √(3/2)`, so a ridge should
sit between two troughs 1.22 radii out, 44.6% as deep as it is tall. **In ground that lets
material come from beside it.** `srStamped` scales the bowl's rim by `(1 - cohesion)` —
snow is 0.82 and packs instead, desert is 0.02 and trenches. Same call, same numbers,
opposite picture, and no line of code in the game layer knows the difference:

| | desert (cohesion 0.02) | snow (cohesion 0.82) |
| --- | --- | --- |
| crest standing | 0.5691 m | 0.6692 m |
| model says | 0.5528 m | 0.6663 m |
| deepest flank | **46.6%** of crest, at 1.40 radii | **7.4%** of crest, at 1.10 radii |
| kernel predicts | 44.6% at 1.22 radii | suppressed to 18% of that |

[phase12-ridge-desert.png](shots/phase12-ridge-desert.png) and
[phase12-ridge-snow.png](shots/phase12-ridge-snow.png) are that table as a picture, at
identical camera and sun: sand throws up a crest with a broad shadowed trough alongside it,
snow throws up a sharp-edged wall with the ground either side untouched.

Snow's crest stands **21% proud of the number asked for**, and should: `RIDGE_STAMP_DEPTH`
divides by the whole line integral, which is only what the ground gives back when nothing
is cohesive. Compensating for that in `verbs.ts` would mean writing element behaviour into
the game layer, which is the one thing this project's architecture is arranged to prevent —
so the setting is documented as metres of crest in cohesionless ground and the probe
predicts the excess from cohesion rather than tuning it away.

Two controls run before the ridge in every element, because a per-step bias and a
once-per-stamp bias look identical in a finished crest: **a single raise of 0.4 m lifts the
ground 0.3997 m** (0.08% out), and the buffer drifts **exactly zero** over thirty further
steps. So the arithmetic is right before any line of stamps is involved, and nothing else
is writing while the wave runs.

One bug found in the writing, and it is the sort that only bites on a coincidence: the stamp
loop tested `stamped <= reached`, and both counters advance by adding to a running total, so
they can land on bit-identical floats and lay two stamps in one call. The spacing was
depending on a floating-point accident. It is `<` now.

**Known, and recorded rather than tuned away.** Desert's crest sits 2.9% above what the
model predicts, snow's 0.4%. It is not the continuum approximation — summing the kernel
directly over the stamps' actual positions agrees with the closed form to 0.05% — and it
scales with `(1 - cohesion)`, which makes it a rim effect. Small, bounded, measured on every
run, and not yet explained.

### Pass D: the wall, which is two ridges

`N` throws a barrier up across your facing, and **it is the ridge with different arguments.**
Pass C kept each travelling line's speed, range, radius and depth in the loop that stepped
it; moving those onto the record itself is the whole of pass D. A wall is then two lines
launched back to back along the perpendicular — shorter, faster, thinner, taller. The
roadmap listed the ridge and the wall as separate moves, and they are separate moves; only
one of them needed building.

Parameters on the record buy something else worth having: a line already in flight keeps the
numbers it was launched with, so dragging a slider mid-wave cannot bend a ridge into a wall.

**It unzips from the middle, and the queue is why.** A wall wants to appear at once and
cannot — the substrate lands one stamp per relaxation step, so an eighteen-stamp wall issued
in a single frame would sit in the queue for eighteen frames and overflow the sixteen slots
it has. Growing outward from the centre spreads the same stamps over the frames the queue
was always going to take, so the constraint costs nothing and buys a wall that visibly
throws itself up rather than one that pops. The second line starts one spacing out so the
two halves do not both stamp the centre; the probe checks that seam against its own
immediate neighbours rather than against the crest average, because a double stamp is a
spike one stamp wide and the finite-length taper varies over metres.

Measured, both elements, 17 stamps at 0.28 m and zero dropped:

| | desert | snow |
| --- | --- | --- |
| spans across the facing | 4.81 m | 5.00 m (asked 5 m) |
| spans along it | 0.63 m | 0.81 m |
| seam above its neighbours | 4.5% | −0.1% |

Long across, short along is the one thing only this verb can get wrong. A perpendicular
taken backwards or swapped for the facing gives a wall that is still the right length, still
the right height, and lying the wrong way — and every other check here would pass it.

**Whether it stays up is the element's business.** Two and a half seconds after it goes up, a
1.3 m wall over a 0.7 m radius stands at **1.326 m in snow** and has slumped to **0.316 m in
sand**. Nothing in the game layer knows: snow's cohesion holds a face that steep, and sand's
34° repose does not. [phase12-wall-snow.png](shots/phase12-wall-snow.png) hides the character
to the shoulders; [phase12-wall-desert.png](shots/phase12-wall-desert.png) is a low bank they
stand clear above.

**The residual from pass C, now characterised.** Running the same wall at two amplitudes
answers the question the ridge left open. Desert overshoots the line-integral model by
**10.5% at 1.3 m and 8.9% at 0.3 m** — 4.3× the amplitude for essentially the same fraction,
so it is not a clamp, a saturation or any other nonlinearity. It is a fixed proportion that
scales with `(1 − cohesion)` (snow: 1.7% and 0.7%) and grows as the radius shrinks (the
ridge's 0.9 m radius gives 2.9%, this 0.7 m one gives ~10%). So the buffer delivers slightly
less rim than a continuous line integral predicts. Direct summation over the actual stamp
positions agrees with the closed form to 0.05%, so the model is not the approximation at
fault. Still not explained; now bounded, reproducible and measured on every run rather than
tuned away.

Also honest: the crest is visibly scalloped in the snow shot. That is the seventeen stamps,
at 0.4 radii apart. Tightening the spacing smooths it and costs queue slots, and which way
that trade should go is a question for whatever ends up standing behind the wall.

### Pass E: what the ground has to give

Until now a sweep carried bare ground as willingly as a drift. **The verb layer cannot ask
that question** — `verbs.ts` picks where to sweep on the CPU a frame earlier and nothing
there can see the buffer, so "move the drift and not the bedrock under it" is not a harder
call to write up there, it is an impossible one. `srMobile()` makes it per texel in the
relaxation, where the only code that knows what is lying on the ground lives.

Two ways to be movable, and a shove takes the better. Loose material — the mass channel,
what slump and deposits and settling air have left sitting proud — moves freely. Undisturbed
ground still moves, because a bender who could only move what someone else had loosened
would be a groundskeeper; it moves at `(1 - cohesion)`, the same split `srStamped` uses to
decide whether a stamp throws a rim or packs. And `spCohesionAt` folds in **compaction**, so
a patch trodden down with `R` resists being swept afterwards — an interaction between two
verbs that neither of them mentions.

Every expected value below is the element's own number, not one written into the probe:

| | bare | loose |
| --- | --- | --- |
| snow, cohesion 0.82 | **18.0%** (element says 18%) | 100.0% |
| desert, cohesion 0.02 | **98.0%** (element says 98%) | 100.0% |

Bare desert moves **5.44×** what bare snow does through the identical call.

**Gating the source forces a gather.** How much arrives at the sink is no longer a property
of the sink — it belongs to a texel one displacement away, and a fragment shader cannot
scatter. But the two lobes are the same Gaussian about two centres, so the sink lobe *is* the
source lobe translated by the displacement: what arrives at p is what left p − displacement,
and both ends read the same previous state. `shove()` now snaps the displacement to whole
texels so that offset read is an exact copy rather than a filter, for the same reason the
window's own scroll is snapped.

`volume` therefore became an upper bound rather than a promise. What it never does is deliver
more than it took.

#### The bug this pass nearly shipped with

The gate worked immediately and measured perfectly. It also quietly created **0.15% of
everything a shove moved**, with the sign never flipping — and `sweep` is held, at sixty
shoves a second. That is the exact failure `checkConserve.mjs` exists to catch, so it was
committed to a branch rather than to `main` while it was chased.

Four experiments found it, and three of them were eliminations:

- **a control that took twenty steps with no shove at all** (fed by a far-corner scoop, whose
  volume is known exactly and could be subtracted) drifted 1.6e-9 — so the step was innocent
  and the shove owned it
- **forcing mobility to a constant** left the error unchanged — so the gate was innocent
- **a displacement already exactly 26 × 13 texels** left it unchanged — so the snap was
  innocent
- **the same probe against `main`'s original kernel** read 1.9e-10 on the identical geometry —
  so the gather rewrite owned it, and pass A's 1e-15 had not been geometry luck

That left one line. `t.y = t.y + drop - lift` runs mass negative at the source lobe, and
`srSlumpFlow` limits its flow with `min(q, src.y * SR_MAX_SHARE)` — so a negative mass makes
that `min` pick the negative number and **slump runs backwards even at `dt = 0`**, where it
is supposed to be identically zero. That flow is not antisymmetric, because each texel takes
the terrain derivative at its own centre, so it does not cancel between the two ends of a
pair. The write-out clamp never saw any of it.

The fix is `max(..., 0.0)` in `srStamped`, and the reason is written six lines above the bug
in the same file: *"Clamped here rather than only at the end of the step: `srStamped()` is
applied to all nine taps before the Laplacian is taken."* The pack branch learned this in
Phase 10. I made the same mistake one branch down and the file had already warned me.

| | before | after |
| --- | --- | --- |
| net after 1 shove | −2.37e-5 (−0.13%) | **1.5e-11** |
| net after 20 shoves | −7.67e-4 (−0.21%) | **−3.3e-9** |

1e-9 is the instrument's own floor — the scoop control sits at the same 1.6e-9.

## Phase 13 — the bender's body

### Pass A: the arms answer to the ground

Phase 12 gave the player five ways to move earth and the character performed none of them.
The ridge ran, the wall went up, the drift swept aside, and the figure stood there with its
arms swinging as though out for a walk. Every other system in this project answers to
something; the body answered only to where the feet were going.

[phase13-raise-before.png](shots/phase13-raise-before.png) and
[phase13-raise-snow.png](shots/phase13-raise-snow.png) are the same frame with
`sys.gesture` off and on — same camera, same sun, same key held, same mound rising out of
the ground in front. In the first the arms hang.

**This is not in `gait.ts`, and that is the pass.** The gait solves *locomotion* — where the
feet land, how the pelvis rides, what the arms do to balance a stride — from speed and
heading alone. A gesture is driven by something the gait has no business knowing: which verb
is held. One file for both would mean the leg solver could see the verb layer, and the first
time a bending pose needed a foot to move, the two would fight over the same bones. So
`character/gesture.ts` decides a **pose** and the gait decides **how much of it to believe**.

Poses are shoulder and elbow angles rather than hand positions, which is worth saying because
the obvious alternative is to name a point in space and solve for the arm. That is IK, and IK
needs a reachability answer for every pose at every body scale; these are two numbers that
cannot fail. Phase 7 already established the arm reads without IK.

Both arms take the same angle, where the swing gives them opposite ones — **that opposition is
the whole visual difference between walking and commanding.** A stride counter-phases the arms
against the legs; a bender brings them together onto the same piece of ground.

The blend is a rate in both directions. Snapping to a pose the frame a key goes down is the
difference between a body and a mannequin being posed; snapping back on release is worse,
because the arms drop into the walk cycle mid-swing.

[scripts/probeGesture.mjs](scripts/probeGesture.mjs) presses each key through the real input
path and reads the hand bones out of the skeleton, in character space so the claims do not
depend on where the figure is standing:

| | hand height | reach |
| --- | --- | --- |
| idle | 0.821 m | 0.030 m |
| raise | **1.784 m** | 0.386 m |
| lower | 1.056 m | 0.425 m |
| sweep | 1.449 m | **0.494 m** |
| draw | 1.476 m | 0.319 m |
| pedestal | 0.841 m | **−0.239 m** |

Every claim is an ordering rather than an absolute, because the absolutes are body
proportions that would have to be retyped whenever the rig changed: raising puts the hands
above lowering, sweeping reaches further out than drawing, and the pedestal is the only pose
whose hands go **back** — which is the case that would catch an inverted shoulder sign, since
it is the only negative one.

And the half nobody checks: every pose blends to 1.000 while held and returns to 0.000 when
released. A blend that arrives and never leaves looks correct in every screenshot ever taken
of it.

**What it deliberately does not touch:** the legs, the pelvis and the spine. A bender leans
into what they are lifting, and that lean is most of what would sell it — but the pelvis is
what the gait plants the feet against, and reaching into it before the arms read correctly
would make one problem into two.

### Pass B: a blow, which is not a pose

`B` and `N` are **events**. The key is up again by the next frame while the thing it launched
runs for another second, so there is nothing left to ask — "are you still ridging?" has no
answer. The held mechanism above cannot express them at all: it reads the input every frame
and would see nothing. The body has to *remember it struck*.

So a strike runs on a clock rather than chasing a target. **Fast in, slow out** — 90 ms to
arrive, 420 ms to recover. Both halves equal reads as a wave rather than a blow; what makes a
hit land is that the arm gets there in about three frames and comes back over a beat. And
while it plays, the envelope owns the blend outright instead of easing toward it, because
easing a strike is how a punch turns into a stretch.

A new strike always restarts the envelope even if one is still playing. Two ridges thrown in
quick succession are two throws, and a body that ignored the second until the first finished
would drop the input on the floor.

The probe samples a single press every 40 ms with the key up the whole time, because every
way this fails is a *shape* rather than a value:

```
  ridge  0499875421000000000000
  wall   0599875421000000000000
```

A strike wired to the held path would read all zeros — the key is gone before the next frame
looks at it. One that never released would look perfect in any still and leave the arms
overhead forever. One easing in on a rate would arrive late and soft, which is why the second
sample is checked as well as the peak: at 40 ms against a 90 ms attack it cannot be near zero
unless the clock has been replaced by a rate.

Measured: both peak at 1.000 from one press, both settle to 0.000 with nothing held, and the
wall throws the hands to 1.93 m against the ridge's 1.52 m — it has to be the highest pose
here, because the wall is the tallest thing the verbs make.

[phase13-wall-strike.png](shots/phase13-wall-strike.png) is the top of that blow, caught at
weight 0.980 by `--strike=n --at=115`; [phase13-ridge-strike.png](shots/phase13-ridge-strike.png)
is the ridge's, arms punched out along the bearing with the crest already running away.

### Pass C: leaning from the waist up

A bender leans into what they are lifting, and that lean is most of what sells it. It is also
the one change in this phase that could break something older than itself: **the gait plants
its feet in world space**, and the whole of Phase 7 rests on a planted foot not moving. A lean
built from the ankles pitches the pelvis, and every planted foot goes with it.

So the lean is spent through the spine **above** the pelvis. The gait already chains the torso
off a `leanZ` slope — each segment leaning less than the one below, so the head arrives nearly
upright — and the leg solve reads none of it: the hips come off `leanX`, `pelvisY` and the
sway. Adding a gesture term to `leanZ` therefore costs the feet nothing and buys almost all of
the read, because what sells a body committing to something is the chest and the head, not the
shins. The arms ride it for free, being positioned from the neck.

| | lean | chest z | feet moved |
| --- | --- | --- | --- |
| raise | −9° | −0.033 | 4.76 mm |
| lower | +14° | +0.056 | 4.78 mm |
| sweep | +16° | +0.064 | 4.81 mm |
| draw | −13° | −0.049 | 4.91 mm |
| pedestal | +7° | +0.028 | 4.94 mm |
| ridge | +23° | — | — |
| wall | −17° | — | — |

**The last column is the pass**, and it only means anything next to the row underneath it:
*the same interval with no key held moves the feet 4.67 mm*. The character drifts a few
millimetres a second standing still — it is on a slope and gravity does what gravity does —
so "the ankle moved" is evidence about the lean only if it moved more than it was going to
anyway. The lean costs the feet between 0.1 and 0.3 mm over that floor. A lean that had
reached the leg solve would move them by centimetres.

Two earlier versions of this measurement were wrong, both by measuring the wrong thing:

- the first held `C`, which **raises the ground the character is standing next to**, tilts it,
  and moves them — so a 240 mm "foot slide" was the player sliding down a hill they had just
  built. The probe now runs with `sys.verbs` off; `sys.gesture` is independent of it.
- the second measured ankles in **character space**, which is pinned to the body — so the
  idle sway moving the pelvis by a centimetre read as the feet sliding. World space is where
  Phase 7 states the guarantee, so it is the frame the claim belongs in.

`checkGait`'s six claims still pass, which is the independent confirmation that none of this
reached the legs.

[phase13-ridge-strike.png](shots/phase13-ridge-strike.png) is the biggest lean in the table —
the whole torso pitched into the throw at the top of the blow, cape trailing behind it.

Phase 13 is done.

## Phase 14 — stakes

### Pass A: something that is not on the player's side

Every phase before this one added a capability. A player could build a wall and it stood
there for as long as the tab was open — no reason to build one thing rather than another, and
no reason to hurry.

**Weather is a driver, not a simulation.** Wind has lifted material off the ground, carried it
and put it back down since Phase 5, and the elements already differ in how susceptible they
are to it. So `play/weather.ts` is a *schedule* — when is it calm, when does it blow, how
hard — and it writes `world.windStrength` rather than holding its own number, the same
contract the wheel zoom keeps with `cam.armLength`. Building the erosion again inside a file
called `weather.ts` would be a second physics next to the real one.

**The cycle has a real calm in it, and that matters more than the storm.** A world that is
always eroding is not opposition, it is a tax: everything decays and the only strategy is to
build faster. A world that is quiet and then is not gives a build a *deadline*, which is what
makes one plan better than another — pack it before the wind comes, put it in the lee of
something, or accept that this one is not going to survive.

The goal layer gains `survival`, the other end of the measurement it already had. Phase 11
scored the **peak** on purpose and said why: snow creeps for seconds after the last shovelful,
so a mound scored on its instantaneous height would finish and unfinish itself while the
player watched. That was right when nothing threatened the pile. Now a wall that stood for one
frame and blew away has the same peak as one that held, so `survival` is `height / peakHeight`
— two heights that were both measured, divided. The goal still completes on the peak, because
a thing that was built *was* built, and what happened to it afterwards is a separate sentence.

[scripts/probeWeather.mjs](scripts/probeWeather.mjs) raises the identical pile twice, from the
same call at the same place, and gives one of them a storm. **The control is the whole point:**
a pile settles on its own, and that settling would happily be reported as erosion.

| | calm | storm | the storm's share |
| --- | --- | --- | --- |
| snow (cohesion 0.82) | lost 109 litres | lost 788 | **48% of the pile** |
| desert (cohesion 0.02) | lost 812 litres | lost 1072 | 22% of the pile |

Snow is where the design lives: a pile is nearly permanent in a calm (7.7% lost) and loses
about half of itself to a storm, so there is something worth protecting. Sand loses 70% to its
own decay whether or not anything is blowing — the storm is a smaller share of a pile that was
never going to last. Same code, same numbers, different element block.

**Two versions of that measurement were wrong before it was right**, both by pointing the
instrument at the wrong place:

- the first asked `gait.groundAt(site)`, which reads the CPU ground-probe **tile** — four
  metres wide, centred on the character. The site was eight metres away, so both runs read the
  bare heightfield and reported an identical 3.704 m and *zero* erosion. A perfectly steady
  number from an instrument aimed at nothing.
- the second summed proud material over the **whole window**, which counts the drifts a storm
  builds *elsewhere* as though the pile still had them — and duly reported that a storm in snow
  left **more** standing than a calm did. Restricting the sum to a disc around the site
  reversed the sign.

No shot is committed for this pass. The obvious one — a storm blowing — photographs as weather
rather than as *loss*, and the honest picture is a before-and-after of a specific pile, which
is a capture harness change rather than a camera angle. The numbers above are the evidence.

### Pass B: cohesion gets a budget

Cohesion made material **infinitely strong**. `spCohesionAt` carries the repose angle toward
vertical and says nothing about how much is stacked on top, so a snow face held at 78° whether
it was one metre tall or thirty. A player could raise a tower to the buffer's ceiling and it
stood there. It was the last thing here that could be done and never be told no.

Real cohesive ground has a critical height for a vertical cut — soil mechanics puts it near
`4c/γ`, proportional to how well the stuff sticks together. So cohesion now falls off above
`cohesion × 2.6` metres of standing pile and is gone half again above that. Snow's 0.82 buys
about 2.1 m of face; sand's 0.02 buys five centimetres, which is why sand never needed this
rule and snow always did.

**Full strength below the critical height, deliberately.** Every result this project measured
before the rule existed was measured on material below one, and all of it had to be untouched.
It is: the ridge and wall crests read 0.5691 / 0.6692 / 1.4439 / 1.6015 m after the change,
identical to the digits they read before it.

| column raised | stood after 4 s | kept |
| --- | --- | --- |
| 0.50 m | 0.484 | 97% |
| 1.60 m | 1.549 | 97% |
| 2.40 m | 2.323 | 97% |
| 3.20 m | 2.842 | 89% |
| 3.98 m | 2.952 | **74%** |

Both tall columns settle to about 2.9 m however much was stacked, which is what a critical
height looks like from the outside.

Two things had to be fixed before any of that could happen, and neither was the rule:

- **The ceiling sat below the physics.** `SR_MAX_OFFSET` clamped the buffer at 2.0 m and
  snow's critical height is 2.13 m, so the collapse could never once fire. The probe caught it
  as six columns standing at *exactly* 2.000 m — which is what a clamp looks like and nothing
  else does. It is 4.0 m now: the point of the pass is that the material decides what can be
  built, and that is only true with the arbitrary constant out of the way.
- **Slump only moves loose mass**, which is deliberate and is what stops the landscape draining
  downhill on frame one — but a raised column is not loose. A face that had lost every bit of
  its cohesion still stood, because the repose angle said it should fall and there was nothing
  present to fall. Failing material now **mobilises**: the gap between the cohesion it has and
  the cohesion it is still holding with becomes loose mass, capped at the pile itself. Nothing
  is created — depression is untouched, and the mass channel is a statement about what is free
  to move, not about how much there is.

### What the remaining phases are for

Phases 0 to 9 built a world; 10 and 11 gave someone a way to act in it and a reason to. What
is left is the part the project is actually named for — the character is meant to be a
**bender of the terrain they are standing on**, and Phase 10 delivered the primitive for
that in its last two passes rather than the vocabulary.

**Phase 12 — the bending vocabulary.** Raise, lower and pedestal all act on one spot. The
moves that read as bending act on a *shape*: a ridge travelling away from you, a drift swept
aside, a wall thrown up along a line, material pulled toward you. Only the first of those is
cheap — a moving stamp over time. The rest need something the substrate does not have, which
is DIRECTIONAL TRANSPORT: every operation so far is radially symmetric about a point, and
moving material sideways is a genuinely new primitive rather than a new call.

**Phase 12 is done.** All four moves exist and so does the question behind them, written up
[below](#phase-12--the-bending-vocabulary) as passes A–E: the transport primitive, sweep and
draw, the ridge, the wall, and the gate that decides how much the ground is willing to give.

**Phase 13 — the bender's body. Done**, and written up
[below](#phase-13--the-benders-body) as passes A–C: a pose per held verb, a struck envelope
for the two that are events, and a lean spent through the spine above the pelvis so the feet
never learn about it.

**Phase 14 — stakes. Done**, and written up [below](#phase-14--stakes) as passes A and B:
weather with a real calm in it, and cohesion given a budget so a pile can be built past what
it can carry.

---

## Architecture notes

**Settings is the single source of truth.** Nothing keeps a private copy of a tunable.
The camera's wheel zoom writes to `cam.armLength` rather than holding its own
number; biome presets write to `world.sunElevation` rather than bypassing it. This is
why the overlay can never drift out of sync with what the renderer is doing.

**Elements are numbers, not code paths.** `src/elements/` holds the whole difference
between snow, sand and ash: cohesion, angle of repose, slump anisotropy, diffusion,
decay half-life, wind susceptibility, thermal coupling. The architectural test in
the spec — add desert as a parameter set with no new code path — is checked against
this file. Snow's decay half-life is *derived* from the spec's "~71% of depth
survives one minute" rather than eyeballed, so the number can be re-derived if the
target changes.

**Rule 1 is enforced, not aspirational.** `frame()` in
[src/main.ts](src/main.ts) allocates nothing. Percentiles sort into a preallocated
scratch buffer at overlay rate; the overlay reuses its row elements and only writes
`textContent`; uniform pushes mutate preallocated vectors.

**The sky splits into four includes for a mechanical reason.** An include that
declares a texture obliges every shader including it to bind that texture. The LUT
bake needs the direction mapping but must not declare the LUT it is writing; the SH
bake needs the LUT but not the data texture it produces. So the maths
([skyMap](src/shaders/lib/skyMap.wgsl), [sh](src/shaders/lib/sh.wgsl)) is split from
the declarations ([skyLutTex](src/shaders/lib/skyLutTex.wgsl),
[skyData](src/shaders/lib/skyData.wgsl)) and each pass includes only what it binds.
Same reason `substratePack` was split out of `substrateTerrainField` in Phase 1.

**Rule 4 has a home.** [terrainField.wgsl](src/shaders/lib/terrainField.wgsl) is the
single definition of "where is the ground". The beauty pass includes it today and
every Phase 2 shadow cascade will include the same file. It uses explicit bilinear
over `textureLoad` rather than a filtered sample for two reasons: it removes any
dependence on the `float32-filterable` feature, and it is reproducible on the CPU,
which is what lets character grounding be *exact* rather than close.

**Two decisions worth knowing about.** Each clipmap ring's hole is built one cell
*smaller* than the level it wraps: a level snapped to twice its own spacing sits
either exactly on its child's centre or one cell off it, and sizing the hole small
turns that ambiguity into a harmless 1–2 cell overlap instead of a hole in the
ground. And the packed derivative is a 24-bit integer, not `pack2x16float` — bitcast
packing produces denormals and NaNs, which a float32 render target is permitted to
flush.

**Rule 7 is real.** `GpuTimings` registers *providers*, not counter references,
because Babylon swaps the counter object out whenever timing is toggled — a cached
reference silently reports a stale value forever. Later phases register their passes
with one line: `gpu.register("substrate", () => substrateRT.gpuTimeInFrame)`.

### Known, and why they are still here

Two warnings survive a clean boot. Both are named here rather than left as mystery noise,
because a console you have learned to skim is a console that will hide the next real bug.

- **`powerPreference is currently ignored on Windows`** — Chrome's, not ours.
  [crbug.com/369219127](https://crbug.com/369219127). It picks the right adapter anyway:
  the capture harness reports `nvidia / lovelace`.
- **`Destroyed texture [D3DImageBacking_...WebGPUSwapBufferProvider] used in a submit`**,
  once, on frame 1 or 2. It names the **swap-chain** texture, not anything this project
  allocates, and everything renders correctly from frame 3 onward. It has been present
  since Phase 2, survives with every one of our own systems disabled, and is a Babylon /
  Dawn interaction around the first swap-chain acquisition. Left alone deliberately: it
  costs one line at boot and chasing it means reading Babylon's WebGPU backend rather
  than building the thing.

Neither has ever masked a real failure — every runtime bug this project has had announced
itself either as a compile error naming a shader, a boot probe reporting a large number,
or a picture that was obviously wrong.

### Deliberately deferred

`sys.farRange` is the rest of pass B. The remaining `sys.*` toggles and most of the
`post.*` group are wired into settings but have nothing behind them yet — they exist so later phases plug in
without touching the overlay, and per rule 3 ("a toggle for every subsystem that
will ever exist"). Each phase implements its own entries.

### Placeholders, marked for deletion

Both of this section's entries were paid off by Phase 7 pass A. `src/shaders/phase0.*.wgsl`
and `src/character/placeholder.ts` — the capsule and its material — are deleted.
`src/core/mover.ts` stayed, for the reason given [above](#not-in-pass-a): the gait
consumes its contract rather than replacing it.

Nothing is currently marked for deletion.

---

## Layout

```
src/
  main.ts            entry point and frame orchestration
  core/              settings, biome switch, input, camera rig, perf, gpu timing,
                     capability gate, loading, engine
  elements/          per-element parameter blocks and the material registry
  terrain/           heightfield bake + CPU mirror, clipmap mesh, terrain system
  substrate/         the ping-ponged buffer and its relaxation; what writes into it
  render/            sky, atmosphere and IBL; the shared debug-view codes
  character/         the rig, the solved gait, and the skinned figure
  air/               the wind field and what it carries
  fire/              heat, the phase change, and embers
  shaders/           all WGSL — lib/ holds the shared includes
  ui/                settings and performance overlay
scripts/
  checkShaders.mjs   the static WGSL check CI runs
```

`air/`, `fire/`, `vfx/`, `post/` arrive with the phases that need them — the spec is
explicit that phases are not scaffolded up front.
