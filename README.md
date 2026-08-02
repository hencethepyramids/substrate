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

Typecheck and build are separate steps on purpose — a type error and a bundling
error should be two distinct red steps, not one ambiguous failure.

**Neither of them looks inside a `.wgsl` file.** Shaders are opaque strings until a
driver sees them, and this project has shipped a green build that rendered nothing
more than once. [scripts/checkShaders.mjs](scripts/checkShaders.mjs) is the step that
does look: it resolves the `#include` graph and fails on an unregistered include, a
`uniforms.x` with no declaration behind it, a uniform or texture the WGSL declares
that no TypeScript ever sets (and the reverse), a texture missing its paired sampler,
an identifier used above its declaration, and a bare `return;` inside an entry point —
which Babylon's processor turns into invalid WGSL by appending its own `return`. It
does not compile WGSL and cannot tell you the picture is right. It closes the gap
between "builds" and "the driver will accept this".

---

## Status: Phase 2 — sky, lighting and shadow cascades complete

| Phase | State |
| --- | --- |
| 0 — harness | done |
| 1 — terrain | done |
| 2 — sky, lighting, atmosphere | pass A done; pass B cascades done, far range next |
| 3 — substrate buffer | not started |
| 4 — surface materials | not started |
| 5 — air | not started |
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

### Controls

| | |
| --- | --- |
| click canvas | lock pointer (closes the overlay) |
| WASD / arrows | move, camera-relative |
| shift | sprint |
| mouse | look |
| wheel | zoom — writes back into `cam.armLength`, so slider and wheel agree |
| right mouse | carve (held; consumed in Phase 8) |
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
  render/            sky, atmosphere and IBL; the shared debug-view codes
  character/         the placeholder capsule, until Phase 7
  shaders/           all WGSL — lib/ holds the shared includes
  ui/                settings and performance overlay
scripts/
  checkShaders.mjs   the static WGSL check CI runs
```

`air/`, `fire/`, `vfx/`, `post/` arrive with the phases that need them — the spec is
explicit that phases are not scaffolded up front.
