# SUBSTRATE

Four elements, one simulation core. WebGPU, zero assets, hand-written WGSL.

[![CI](https://github.com/hencethepyramids/substrate/actions/workflows/ci.yml/badge.svg)](https://github.com/hencethepyramids/substrate/actions/workflows/ci.yml)
[![Deploy](https://github.com/hencethepyramids/substrate/actions/workflows/deploy.yml/badge.svg)](https://github.com/hencethepyramids/substrate/actions/workflows/deploy.yml)

**Live: https://hencethepyramids.github.io/substrate/**

```
npm run dev        # http://localhost:5173
npm run typecheck  # tsc --noEmit
npm run build      # typecheck + vite build
```

Requires WebGPU (Chrome/Edge 113+, Firefox 141+). There is no WebGL fallback — the
capability gate prints a message and stops.

## Automation

| Workflow | Trigger | Does |
| --- | --- | --- |
| [CI](.github/workflows/ci.yml) | push to `main`, any PR | typecheck, build, upload `dist` as a 7-day artifact |
| [Deploy](.github/workflows/deploy.yml) | push to `main` | builds with `VITE_BASE=/substrate/` and publishes to GitHub Pages |

Typecheck and build are separate steps on purpose — a type error and a bundling
error should be two distinct red steps, not one ambiguous failure.

---

## Status: Phase 1 (terrain) complete

| Phase | State |
| --- | --- |
| 0 — harness | done |
| 1 — terrain | done |
| 2 — sky, lighting, atmosphere | not started |
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

`debug.view`, the `sys.*` toggles and most of the `post.*` group are wired into
settings but have nothing behind them yet — they exist so later phases plug in
without touching the overlay, and per rule 3 ("a toggle for every subsystem that
will ever exist"). Each phase implements its own entries.

### Placeholders, marked for deletion

- `src/core/phase0World.ts` + `src/shaders/phase0.*.wgsl` — a 2-triangle grid plane
  and a capsule. Deleted by Phase 1 (clipmap) and Phase 7 (character). They exist to
  prove the hand-written WGSL path compiles, binds uniforms and warms correctly, and
  to make the biome switch visible from day one.
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
  shaders/           all WGSL — lib/ will hold the shared includes
  ui/                settings and performance overlay
```

`terrain/`, `render/`, `air/`, `fire/`, `character/`, `vfx/`, `post/` arrive with the
phases that need them — the spec is explicit that phases are not scaffolded up front.
