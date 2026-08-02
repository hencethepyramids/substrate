# SUBSTRATE

Four elements, one simulation core. WebGPU, zero assets, hand-written WGSL.

```
npm run dev        # http://localhost:5173
npm run typecheck  # tsc --noEmit
npm run build      # typecheck + vite build
```

Requires WebGPU (Chrome/Edge 113+, Firefox 141+). There is no WebGL fallback — the
capability gate prints a message and stops.

---

## Status: Phase 0 (harness) complete

| Phase | State |
| --- | --- |
| 0 — harness | done |
| 1 — terrain | not started |
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
