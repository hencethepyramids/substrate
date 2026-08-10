import { Scene } from "@babylonjs/core/scene";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import type { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";

import { probeWebGPU, showCapabilityFailure, showFatalError } from "./core/capability";
import { createEngine, bindEngineSettings } from "./core/engine";
import { LoadingScreen, nextFrame } from "./core/loading";
import { Settings } from "./core/settings";
import { BiomeState } from "./core/biome";
import { Perf } from "./core/perf";
import { GpuTimings } from "./core/gpuTimer";
import { Input } from "./core/input";
import { CameraRig } from "./core/cameraRig";
import { Mover } from "./core/mover";
import { Sky } from "./render/sky";
import { Shadows } from "./render/shadows";
import { Post } from "./render/post";
import { Terrain } from "./terrain/terrain";
import { Substrate } from "./substrate/substrate";
import { Carve } from "./substrate/carve";
import { GroundProbe } from "./substrate/groundProbe";
import { Wake } from "./substrate/wake";
import { Spray } from "./substrate/spray";
import { AirField } from "./air/airField";
import { AirProbe } from "./air/airProbe";
import { Airborne } from "./air/airborne";
import { Fire } from "./fire/fire";
import { Embers } from "./fire/embers";
import { Gait } from "./character/gait";
import { Figure } from "./character/figure";
import { Cloak } from "./character/cloak";
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
    let embers!: Embers;
    let character!: Figure;
    let gait!: Gait;
    let groundProbe!: GroundProbe;
    let airProbe!: AirProbe;
    let cloak!: Cloak;
    let spray!: Spray;
    let post!: Post;
    let overlay!: Overlay;
    let unbindEngine: () => void = () => {};

    const mover = new Mover(settings);
    const carve = new Carve(settings);
    const wake = new Wake(settings);
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
        // After the sky, which owns the sun direction the light shafts project, and before
        // anything draws: the camera's first post process decides the format of the target
        // the scene renders into, so the HDR buffer only exists if this does.
        post = new Post(scene, settings, rig.camera, sky);
        shadows = new Shadows(scene, settings, sky);
        terrain = new Terrain(scene, settings, biome, sky, shadows);
        // Straight after the terrain and before anything draws: the terrain material
        // declares the substrate sampler, so the binding has to exist by the first frame.
        substrate = new Substrate(scene, settings, biome, terrain.field);
        terrain.setSubstrate(substrate);
        terrain.setAir(air);
        // Rides the substrate's own window, so it is constructed with it and after it.
        // Heat rides the same window again. The ground reads its phase; it never writes
        // the ground. Built before the air, because smoke is made by heat.
        fire = new Fire(scene, settings, biome, substrate);
        terrain.setFire(fire);
        substrate.setFire(fire);

        airborne = new Airborne(scene, settings, biome, terrain.field, substrate, air);
        airborne.setFire(fire);
        terrain.setAirborne(airborne);
        // They reference each other on purpose: the air reads the ground's loose mass,
        // the ground reads the air's debt, and each sees the other's previous step.
        substrate.setAirborne(airborne);
        embers = new Embers(scene, settings, biome, terrain.field, substrate, air, fire);
        // Thrown material. Reads the substrate's loose mass, so it is built with it.
        spray = new Spray(scene, settings, biome, terrain.field, substrate, air, sky);
        // The gait needs the CPU mirror of the heightfield to plant feet on, so it is
        // built with the terrain rather than with the mover. The figure needs the gait:
        // its geometry is authored against the rig, and its pose is the gait's palette.
        gait = new Gait(settings, terrain.field);
        // The CPU window of the substrate. Built after it, handed to the gait, so the feet
        // land on the ground the character has carved rather than on the one beneath it.
        groundProbe = new GroundProbe(scene, settings, substrate);
        gait.setProbe(groundProbe);
        character = new Figure(scene, settings, sky, shadows, gait);
        // The wind where the character is, read through the same include the smoke uses.
        airProbe = new AirProbe(scene, settings, terrain.field, air);
        cloak = new Cloak(scene, settings, sky, shadows, gait, airProbe);
        // The figure needs the skinned cast — it has no world matrix for the shared one to
        // read. The cloak is the opposite: its solver already works in world space, so the
        // shared pass multiplying by an identity world matrix is exactly right.
        shadows.setCasters(terrain.mesh, [{ mesh: character.mesh, material: character.castMaterial }, { mesh: cloak.mesh }]);
        sky.setFarStart(terrain.stats.halfExtent, terrain.field.originX, terrain.field.originZ, terrain.field.extent);
        console.info(`[substrate] clipmap: ${terrain.stats.triangles.toLocaleString()} tris, ${terrain.stats.vertices.toLocaleString()} verts, ${(terrain.stats.bytes / 1048576).toFixed(2)} MB, radius ${terrain.stats.halfExtent.toFixed(0)} m`);
        console.info(`[substrate] figure: ${character.stats.triangles.toLocaleString()} tris, ${character.stats.vertices.toLocaleString()} verts over 18 bones`);
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
        await fire.prepare();
        await airborne.prepare();
        await embers.prepare();
        await spray.prepare();
    });

    // Rule 2: every pipeline compiled and drawn once behind the loading screen.
    loader.add("compiling pipelines", 5, async (report) => {
        mover.teleport(0, 0);
        mover.position.y = terrain.field.sampleHeight(0, 0);
        // Before the figure compiles: its first draw reads the palette, and a palette of
        // zeros collapses every vertex onto the origin.
        gait.resync(mover);
        gait.update(mover, 0);
        await character.prepare();
        await cloak.prepare();
        report(0.3);
        await shadows.prepare();
        report(0.5);

        rig.snap();

        // Compilation is not the whole story on WebGPU — the render pipeline state
        // object is only built on first draw. Draw real frames until everything
        // reports ready so the first visible frame cannot stall.
        for (let attempt = 0; attempt < 180; attempt++) {
            sky.update(rig.camera);
            substrate.update(rig.camera, 1 / 60);
            airborne.update(1 / 60);
            fire.update(1 / 60);
            embers.update(rig.camera, 1 / 60);
            spray.update(rig.camera, mover, 1 / 60);
            terrain.update(rig.camera);
            character.update(rig.camera);
            cloak.update(rig.camera, 1 / 60);
            shadows.update(rig.camera);
            scene.render();
            if (terrain.ready && sky.ready && shadows.ready && substrate.ready && character.ready && cloak.ready && scene.isReady()) break;
            await nextFrame();
        }

        // Say plainly what came up. A partially-drawn scene is diagnosable; a black
        // rectangle with a clean console is not.
        console.info(
            `[substrate] boot: terrain material ${terrain.compiled ? "ok" : "FAILED"}, ` +
                `sky ${sky.compiled ? "ok" : "FAILED"}, ` +
                `shadow cast ${shadows.compiled ? "ok" : "FAILED"}, ` +
                `substrate relax ${substrate.compiled ? "ok" : "FAILED"}, ` +
                `character material ${character.compiled ? "ok" : "FAILED"}, ` +
                `cloak ${cloak.compiled ? "ok" : "FAILED"}, ` +
                `composite ${post.compiled ? "ok" : "FAILED"}, ` +
                `height mirror ${terrain.field.mirrorValid ? "ok" : "FAILED"}, ` +
                `ground at origin ${terrain.field.sampleHeight(0, 0).toFixed(2)} m`,
        );
        report(1);
    });

    loader.add("overlay", 1, () => {
        overlay = new Overlay({ root: stage, settings, perf, gpu, scene, input, biome, capability });
        overlay.addCounter("sky bakes", () => String(sky.bakes));
        // What the chain actually costs, in fullscreen passes. The bloom pyramid is
        // nine of them, which is worth being able to see next to the frame time.
        overlay.addCounter("post passes", () => String(post.passes));
        overlay.addCounter("substrate steps", () => String(substrate.steps));
        // One stamp lands per step, so a queue that is not draining is real information.
        overlay.addCounter("carve queue", () => (substrate.dropped > 0 ? `${substrate.pending} (${substrate.dropped} dropped)` : String(substrate.pending)));
        // Rule 7: register a provider, not a counter. The wrapper is swapped out
        // whenever the atlas is resized, so a cached reference would go stale.
        gpu.register("shadow cascades", () => shadows.gpuTime);
        gpu.register("substrate", () => substrate.gpuTime);
        gpu.register("airborne", () => airborne.gpuTime);
        gpu.register("heat", () => fire.gpuTime);
        registerActions(overlay, settings, mover, rig, substrate, gait, wake, fire);
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
        // The gait supplies the surface, so the body and the feet cannot disagree about
        // which ground they are on — including a wake carved into it a moment ago.
        mover.update(input, rig, gait, simDt);
        perf.end(S_SIM);

        perf.begin(S_GROUND);
        // Stand on the surface that is drawn — the heightfield through its CPU mirror,
        // less whatever the substrate has taken out of it. The body's height comes from
        // under its centre; the gait then plants each foot against the same surface
        // independently, which is what lets the two feet sit at different heights on a
        // slope and what lets a boot settle into the print it just made.
        mover.position.y = gait.groundAt(mover.position.x, mover.position.z);
        // After the grounding, because character space is pinned to it, and before the
        // carve pass, which stamps the contacts this decides.
        gait.update(mover, simDt);
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
        carve.update(input, mover, gait, substrate, simDt);
        // After the footfalls, so a print and the channel it sits in queue in the order
        // they were made.
        wake.update(mover, substrate, simDt);
        substrate.update(rig.camera, simDt);
        // Straight after the step it reads, so the tile the gait picks up next frame is
        // the freshest one there is. The readback is asynchronous and self-throttling: it
        // costs the character a frame or two of latency and costs the frame nothing.
        groundProbe.update(mover.position.x, mover.position.z);
        // The wind where the character is. One texel, same include as the smoke.
        airProbe.update(mover.position.x, mover.position.z);
        // After the ground: it reads the mass the substrate has just finished writing,
        // on that pass's own window.
        airborne.update(simDt);
        // Heat last: it reads nothing the others write this frame, and the ground picks
        // its phase up next frame.
        fire.update(simDt);
        embers.update(rig.camera, simDt);
        // After the wake that made the loose mass it reads.
        spray.update(rig.camera, mover, simDt);
        perf.end(S_SUBSTRATE);

        perf.begin(S_UNIFORMS);
        terrain.update(rig.camera);
        character.update(rig.camera);
        // After the figure, because the cloak hangs off the palette the figure just baked.
        cloak.update(rig.camera, simDt);
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
    (window as unknown as { __substrate?: unknown }).__substrate = { settings, mover, input, rig, air, substrate, airborne, fire, terrain, gait, character, shadows, scene, groundProbe, airProbe, cloak, wake, spray };

    (window as unknown as { __substrateDispose?: () => void }).__substrateDispose = () => {
        engine.stopRenderLoop();
        overlay.dispose();
        spray.dispose();
        embers.dispose();
        fire.dispose();
        airborne.dispose();
        substrate.dispose();
        terrain.dispose();
        cloak.dispose();
        post.dispose();
        airProbe.dispose();
        character.dispose();
        groundProbe.dispose();
        shadows.dispose();
        sky.dispose();
        input.dispose();
        unbindEngine();
        scene.dispose();
        engine.dispose();
    };
}

/** Overlay buttons. Phase 10's element interactions register here too. */
function registerActions(overlay: Overlay, settings: Settings, mover: Mover, rig: CameraRig, substrate: Substrate, gait: Gait, wake: Wake, fire: Fire): void {
    const teleport = (x: number, z: number): void => {
        mover.teleport(x, z);
        mover.position.y = gait.groundAt(x, z);
        rig.snap();
        // A jump is not a stride. Without this the gait would lay its next print wherever
        // the character landed, at a random point in the cycle — and would spend that
        // cycle swinging a foot from eight hundred metres away.
        gait.resync(mover);
        wake.resync(mover);
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
