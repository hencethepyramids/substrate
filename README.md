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

Typecheck and build are separate steps on purpose — a type error and a bundling
error should be two distinct red steps, not one ambiguous failure.

**Neither of them looks inside a `.wgsl` file.** Shaders are opaque strings until a
driver sees them, and this project has shipped a green build that rendered nothing
more than once. [scripts/checkShaders.mjs](scripts/checkShaders.mjs) is the step that
does look: it resolves the `#include` graph and fails on an unregistered include, a
`uniforms.x` with no declaration behind it, a uniform or texture the WGSL declares
that no TypeScript ever sets (and the reverse), a texture missing its paired sampler,
a call to a project function nothing declares — which is what a missing `#include` looks
like, and it survives a green build with nothing to show for it —
an identifier used above its declaration, and a bare `return;` inside an entry point —
which Babylon's processor turns into invalid WGSL by appending its own `return`. It
does not compile WGSL and cannot tell you the picture is right. It closes the gap
between "builds" and "the driver will accept this".

---

## Status: Phase 4 complete

| Phase | State |
| --- | --- |
| 0 — harness | done |
| 1 — terrain | done |
| 2 — sky, lighting, atmosphere | done |
| 3 — substrate buffer | **done** |
| 4 — surface materials | **done** |
| 5 — air | **pass A landed, B next** |
| 6 — fire | not started |
| 7 — character | not started |
| 8 — traversal and wakes | not started |
| 9 — post | not started |
| 10 — interactions | not started |
| 11 — game layer | not started |

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

- **Lift** — loose material past `liftThreshold`, where the shear is high enough, leaves
  the ground at a rate set by `windSusceptibility`. Those two numbers have been sitting
  in `SubstrateParams` since Phase 0 waiting for this, and between them they are why ash
  goes up in a breeze and packed snow does not.
- **Ride** — semi-Lagrangian advection, so a gale cannot outrun the timestep the way
  explicit advection would. The CFL limit stops being a limit.
- **Settle** — suspension survives where the air is moving and drops out where it has
  slowed or separated. That asymmetry is the entire reason material accumulates on a slip
  face instead of being carried onward forever.

**It does not edit the ground.** It records what it owes in an exchange channel, so the
substrate stays the only thing that writes the substrate — and B1 has no feedback loop at
all, which is what keeps a working Phase 3 out of the blast radius.

#### Pass B2, closing the loop — next

The relaxation pass reads that exchange channel and applies it. Then the ground loses
mass on a windward face and gains it on a slip face, and a dune migrates.

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

### Deliberately deferred

`sys.farRange` is the rest of pass B. The remaining `sys.*` toggles and most of the
`post.*` group are wired into settings but have nothing behind them yet — they exist so later phases plug in
without touching the overlay, and per rule 3 ("a toggle for every subsystem that
will ever exist"). Each phase implements its own entries.

### Placeholders, marked for deletion

- `src/shaders/phase0.*.wgsl` — the capsule's material. Deleted by Phase 7. It is lit
  through the same sky include the terrain uses, because a capsule shaded by a
  different ambient than the ground it stands on is how you end up trusting the wrong
  one.
- `src/core/mover.ts` — kinematic locomotion. Phase 7 replaces it with the solved
  gait machine, keeping the same contract: it owns a feet position and a facing.

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
  character/         the placeholder capsule, until Phase 7
  shaders/           all WGSL — lib/ holds the shared includes
  ui/                settings and performance overlay
scripts/
  checkShaders.mjs   the static WGSL check CI runs
```

`air/`, `fire/`, `vfx/`, `post/` arrive with the phases that need them — the spec is
explicit that phases are not scaffolded up front.
