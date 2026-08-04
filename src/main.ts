import { Scene } from "@babylonjs/core/scene";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import type { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";

import { probeWebGPU, showCapabilityFailure, showFatalError } from "./core/capability";
import { createEngine, bindEngineSettings } from "./core/engine";
import { LoadingScreen, nextFrame, compileOrWarn } from "./core/loading";
import { Settings } from "./core/settings";
import { BiomeState } from "./core/biome";
import { Perf } from "./core/perf";
import { GpuTimings } from "./core/gpuTimer";
import { Input } from "./core/input";
import { CameraRig } from "./core/cameraRig";
import { Mover } from "./core/mover";
import { Sky } from "./render/sky";
import { Shadows } from "./render/shadows";
import { Terrain } from "./terrain/terrain";
import { Substrate } from "./substrate/substrate";
import { Carve } from "./substrate/carve";
import { AirField } from "./air/airField";
import { Airborne } from "./air/airborne";
import { Fire } from "./fire/fire";
import { PlaceholderCharacter } from "./character/placeholder";
import { registerShaderIncludes } from "./shaders/lib/register";
import { Overlay } from "./ui/overlay";
import { BIOME_IDS } from "./elements/registry";
import type { BiomeId } from "./elements/types";

/**
 * SUBSTRATE — entry point and frame orchestration.
 *
 * Rule 1: nothing in frame() allocates. Every object it touches is constructed here,
 * during boot, behind the loading screen.
 */

async function boot(): Promise<void> {
    const stage = document.getElementById("stage") as HTMLElement;
    const canvas = document.getElementById("view") as HTMLCanvasElement;

    // Gate first. No WebGL fallback, by design.
    const capability = await probeWebGPU();
    if (!capability.ok) {
        showCapabilityFailure(capability.reason);
        return;
    }

    registerShaderIncludes();

    const settings = new Settings();
    const biome = new BiomeState(settings);
    const perf = new Perf(512);
    const loader = new LoadingScreen(stage);

    let engine!: WebGPUEngine;
    let scene!: Scene;
    let gpu!: GpuTimings;
    let input!: Input;
    let rig!: CameraRig;
    let sky!: Sky;
    let shadows!: Shadows;
    let terrain!: Terrain;
    let substrate!: Substrate;
    let airborne!: Airborne;
    let fire!: Fire;
    let character!: PlaceholderCharacter;
    let overlay!: Overlay;
    let unbindEngine: () => void = () => {};

    const mover = new Mover(settings);
    const carve = new Carve(settings);
    const air = new AirField(settings);

    loader.add("requesting device", 3, async () => {
        engine = await createEngine(canvas, capability);
        unbindEngine = bindEngineSettings(engine, settings);
    });

    loader.add("scene", 1, () => {
        scene = new Scene(engine);
        scene.clearColor = new Color4(0, 0, 0, 1);
        scene.autoClear = true;
        // No Babylon lights: all shading is in our own WGSL.
        gpu = new GpuTimings(engine, settings, capability.has("timestamp-query"));
        input = new Input(canvas);
        rig = new CameraRig(scene, settings);
    });

    loader.add("clipmap mesh", 2, () => {
        // Sky and shadows first: terrain and the character bind their textures at
        // construction. Shadows learns which meshes cast once those exist.
        sky = new Sky(scene, settings, biome);
        shadows = new Shadows(scene, settings, sky);
        terrain = new Terrain(scene, settings, biome, sky, shadows);
        // Straight after the terrain and before anything draws: the terrain material
        // declares the substrate sampler, so the binding has to exist by the first frame.
        substrate = new Substrate(scene, settings, biome, terrain.field);
        terrain.setSubstrate(substrate);
        terrain.setAir(air);
        // Rides the substrate's own window, so it is constructed with it and after it.
        airborne = new Airborne(scene, settings, biome, terrain.field, substrate, air);
        terrain.setAirborne(airborne);
        // They reference each other on purpose: the air reads the ground's loose mass,
        // the ground reads the air's debt, and each sees the other's previous step.
        substrate.setAirborne(airborne);
        // Heat rides the same window again. The ground reads its phase; it never writes
        // the ground.
        fire = new Fire(scene, settings, biome, substrate);
        terrain.setFire(fire);
        substrate.setFire(fire);
        character = new PlaceholderCharacter(scene, settings, sky, shadows);
        shadows.setCasters(terrain.mesh, [character.mesh]);
        sky.setFarStart(terrain.stats.halfExtent, terrain.field.originX, terrain.field.originZ, terrain.field.extent);
        console.info(`[substrate] clipmap: ${terrain.stats.triangles.toLocaleString()} tris, ${terrain.stats.vertices.toLocaleString()} verts, ${(terrain.stats.bytes / 1048576).toFixed(2)} MB, radius ${terrain.stats.halfExtent.toFixed(0)} m`);
    });

    // Two small render targets and a fullscreen triangle. Cheap next to the height
    // bake, but it has to happen behind the screen: the first visible frame must not
    // be lit by an unbaked sky.
    loader.add("baking sky", 2, async (report) => {
        await sky.prepare(report);
    });

    // The heightfield bake plus the 67 MB readback that mirrors it to the CPU. This is
    // the long pole at load, so it reports real sub-progress.
    loader.add("baking heightfield", 12, async (report) => {
        await terrain.prepare(report);
    });

    // After the heightfield, because the relaxation reads it — and because the boot
    // probe that checks where a carve lands should run against the real field.
    loader.add("substrate buffer", 2, async (report) => {
        await substrate.prepare(report);
        await airborne.prepare();
        await fire.prepare();
    });

    // Rule 2: every pipeline compiled and drawn once behind the loading screen.
    loader.add("compiling pipelines", 5, async (report) => {
        const characterOk = await compileOrWarn("character", () => character.material.forceCompilationAsync(character.mesh));
        report(0.3);
        await shadows.prepare();
        report(0.5);

        mover.teleport(0, 0);
        mover.position.y = terrain.field.sampleHeight(0, 0);
        rig.snap();

        // Compilation is not the whole story on WebGPU — the render pipeline state
        // object is only built on first draw. Draw real frames until everything
        // reports ready so the first visible frame cannot stall.
        for (let attempt = 0; attempt < 180; attempt++) {
            sky.update(rig.camera);
            substrate.update(rig.camera, 1 / 60);
            airborne.update(1 / 60);
            fire.update(1 / 60);
            terrain.update(rig.camera);
            character.update(rig.camera);
            shadows.update(rig.camera);
            scene.render();
            if (terrain.ready && sky.ready && shadows.ready && substrate.ready && character.isReady() && scene.isReady()) break;
            await nextFrame();
        }

        // Say plainly what came up. A partially-drawn scene is diagnosable; a black
        // rectangle with a clean console is not.
        console.info(
            `[substrate] boot: terrain material ${terrain.compiled ? "ok" : "FAILED"}, ` +
                `sky ${sky.compiled ? "ok" : "FAILED"}, ` +
                `shadow cast ${shadows.compiled ? "ok" : "FAILED"}, ` +
                `substrate relax ${substrate.compiled ? "ok" : "FAILED"}, ` +
                `character material ${characterOk ? "ok" : "FAILED"}, ` +
                `height mirror ${terrain.field.mirrorValid ? "ok" : "FAILED"}, ` +
                `ground at origin ${terrain.field.sampleHeight(0, 0).toFixed(2)} m`,
        );
        report(1);
    });

    loader.add("overlay", 1, () => {
        overlay = new Overlay({ root: stage, settings, perf, gpu, scene, input, biome, capability });
        overlay.addCounter("sky bakes", () => String(sky.bakes));
        overlay.addCounter("substrate steps", () => String(substrate.steps));
        // One stamp lands per step, so a queue that is not draining is real information.
        overlay.addCounter("carve queue", () => (substrate.dropped > 0 ? `${substrate.pending} (${substrate.dropped} dropped)` : String(substrate.pending)));
        // Rule 7: register a provider, not a counter. The wrapper is swapped out
        // whenever the atlas is resized, so a cached reference would go stale.
        gpu.register("shadow cascades", () => shadows.gpuTime);
        gpu.register("substrate", () => substrate.gpuTime);
        gpu.register("airborne", () => airborne.gpuTime);
        gpu.register("heat", () => fire.gpuTime);
        registerActions(overlay, settings, mover, rig, terrain, substrate, carve, fire);
    });

    try {
        await loader.run();
    } catch (err) {
        loader.fail(err);
        return;
    }
    await loader.dismiss();

    // -----------------------------------------------------------------------
    // Frame loop
    // -----------------------------------------------------------------------

    const S_INPUT = perf.section("input");
    const S_SIM = perf.section("locomotion");
    const S_GROUND = perf.section("grounding");
    const S_CAMERA = perf.section("camera");
    const S_SKY = perf.section("sky");
    const S_SUBSTRATE = perf.section("substrate");
    const S_SHADOWS = perf.section("shadow cascades");
    const S_UNIFORMS = perf.section("uniforms");
    const S_RENDER = perf.section("render submit");
    const S_OVERLAY = perf.section("overlay");

    let nextAllowedFrame = 0;

    const frame = (): void => {
        const now = performance.now();

        // FPS cap. Cheaper than a timer and keeps the loop shape identical.
        const cap = settings.v["render.fpsCap"];
        if (cap > 0) {
            if (now < nextAllowedFrame) return;
            nextAllowedFrame = now + 1000 / cap;
        }

        perf.frameBegin(now);

        perf.begin(S_INPUT);
        input.update();
        perf.end(S_INPUT);

        const simDt = settings.v["world.paused"] ? 0 : perf.dt * settings.v["world.timeScale"];

        perf.begin(S_SIM);
        mover.update(input, rig, simDt);
        perf.end(S_SIM);

        perf.begin(S_GROUND);
        // Stand on the surface that is drawn, sampled through the CPU mirror of the
        // same bilinear filter the vertex shader uses. Phase 7 replaces this with
        // per-foot contact against the same field.
        mover.position.y = terrain.field.sampleHeight(mover.position.x, mover.position.z);
        character.setPose(mover.position, mover.facing);
        perf.end(S_GROUND);

        perf.begin(S_CAMERA);
        // The rig uses real time, not simulation time — pausing must not freeze the camera.
        rig.update(input, mover.position, perf.dt);
        perf.end(S_CAMERA);

        // Before the scene render, not inside it: a rebake binds its own target, and
        // the SH pass integrates the LUT written immediately before it. This section
        // is CPU submit time — the bake itself is GPU work and only happens on the
        // frames where the sun or a sky control actually moved.
        perf.begin(S_SKY);
        sky.update(rig.camera);
        perf.end(S_SKY);

        // Before the terrain pushes uniforms, for the same reason the sky bakes before
        // everything: this writes the buffer the beauty pass is about to sample, and it
        // binds its own render target while doing so. Simulation time, not real time —
        // the ground freezes when the world is paused.
        perf.begin(S_SUBSTRATE);
        // The wind first: Phase 5's second pass will lift material with it, and the
        // beauty pass reads it this frame either way.
        air.update(simDt);
        // Then the carve sources, then the step that consumes them.
        carve.update(input, mover, substrate, simDt);
        substrate.update(rig.camera, simDt);
        // After the ground: it reads the mass the substrate has just finished writing,
        // on that pass's own window.
        airborne.update(simDt);
        // Heat last: it reads nothing the others write this frame, and the ground picks
        // its phase up next frame.
        fire.update(simDt);
        perf.end(S_SUBSTRATE);

        perf.begin(S_UNIFORMS);
        terrain.update(rig.camera);
        character.update(rig.camera);
        perf.end(S_UNIFORMS);

        // Fit and render the cascades before scene.render() samples them. terrain
        // .update() has already fed the cast material the clipmap numbers the beauty
        // pass will use, so both passes displace from the same frame's values.
        perf.begin(S_SHADOWS);
        shadows.update(rig.camera);
        perf.end(S_SHADOWS);

        perf.begin(S_RENDER);
        scene.render();
        perf.end(S_RENDER);

        gpu.sample();

        perf.begin(S_OVERLAY);
        overlay.update(now);
        perf.end(S_OVERLAY);

        input.endFrame();
        perf.frameEnd(performance.now());
    };

    engine.runRenderLoop(frame);

    // The live systems, for scripts/capture.mjs. Settings is the whole control surface,
    // so a harness can drive any view or parameter at runtime instead of reloading the
    // page per experiment — and the wind vector can be read rather than re-derived,
    // which is the difference between checking a sign and asserting one.
    (window as unknown as { __substrate?: unknown }).__substrate = { settings, mover, rig, air, substrate, airborne, fire, terrain };

    (window as unknown as { __substrateDispose?: () => void }).__substrateDispose = () => {
        engine.stopRenderLoop();
        overlay.dispose();
        fire.dispose();
        airborne.dispose();
        substrate.dispose();
        terrain.dispose();
        character.dispose();
        shadows.dispose();
        sky.dispose();
        input.dispose();
        unbindEngine();
        scene.dispose();
        engine.dispose();
    };
}

/** Overlay buttons. Phase 10's element interactions register here too. */
function registerActions(overlay: Overlay, settings: Settings, mover: Mover, rig: CameraRig, terrain: Terrain, substrate: Substrate, carve: Carve, fire: Fire): void {
    const teleport = (x: number, z: number): void => {
        mover.teleport(x, z);
        mover.position.y = terrain.field.sampleHeight(x, z);
        rig.snap();
        // A jump is not a stride. Without this the gait would lay its next print
        // wherever the character landed, at a random point in the cycle.
        carve.resync(mover);
    };
    overlay.addAction("cycle biome", () => {
        const current = settings.get("world.biome") as BiomeId;
        const next = BIOME_IDS[(BIOME_IDS.indexOf(current) + 1) % BIOME_IDS.length];
        settings.set("world.biome", next);
    });
    overlay.addAction("origin", () => teleport(0, 0));
    // The Phase 1 acceptance test, as one click.
    overlay.addAction("walk 800m", () => teleport(800, 0));
    overlay.addAction("noon", () => settings.set("world.sunElevation", 68));
    overlay.addAction("golden", () => settings.set("world.sunElevation", 8));
    // The Phase 3 acceptance test, as one click. Drop the same pit in each biome and
    // watch it: snow holds a near-vertical wall, sand collapses to its repose angle,
    // ash collapses and then never recovers. Phase 3's second pass replaces this with
    // the character's feet and the carve button.
    overlay.addAction("drop test pit", () => {
        substrate.stamp(mover.position.x, mover.position.z, settings.v["substrate.carveRadius"], settings.v["substrate.testDepth"]);
    });
    overlay.addAction("clear substrate", () => substrate.reset());
    // Phase 6's acceptance test as one click. The same heat into three elements: snow
    // melts and stops, sand barely registers it, rock goes molten and stays that way.
    overlay.addAction("ignite", () => {
        fire.ignite(mover.position.x, mover.position.z, settings.v["fire.igniteRadius"], settings.v["fire.igniteRate"]);
    });
    overlay.addAction("cool down", () => fire.reset());
}

boot().catch((err) => {
    console.error("[substrate] fatal", err);
    showFatalError(err instanceof Error ? err.message : String(err));
});
