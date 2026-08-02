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
import { Environment } from "./render/environment";
import { Terrain } from "./terrain/terrain";
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
    const env = new Environment();
    const loader = new LoadingScreen(stage);

    let engine!: WebGPUEngine;
    let scene!: Scene;
    let gpu!: GpuTimings;
    let input!: Input;
    let rig!: CameraRig;
    let terrain!: Terrain;
    let character!: PlaceholderCharacter;
    let overlay!: Overlay;
    let unbindEngine: () => void = () => {};

    const mover = new Mover(settings);

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
        terrain = new Terrain(scene, settings, biome);
        character = new PlaceholderCharacter(scene, settings);
        console.info(`[substrate] clipmap: ${terrain.stats.triangles.toLocaleString()} tris, ${terrain.stats.vertices.toLocaleString()} verts, ${(terrain.stats.bytes / 1048576).toFixed(2)} MB, radius ${terrain.stats.halfExtent.toFixed(0)} m`);
    });

    // The heightfield bake plus the 67 MB readback that mirrors it to the CPU. This is
    // the long pole at load, so it reports real sub-progress.
    loader.add("baking heightfield", 12, async (report) => {
        await terrain.prepare(report);
    });

    // Rule 2: every pipeline compiled and drawn once behind the loading screen.
    loader.add("compiling pipelines", 5, async (report) => {
        const characterOk = await compileOrWarn("character", () => character.material.forceCompilationAsync(character.mesh));
        report(0.5);

        mover.teleport(0, 0);
        mover.position.y = terrain.field.sampleHeight(0, 0);
        rig.snap();

        // Compilation is not the whole story on WebGPU — the render pipeline state
        // object is only built on first draw. Draw real frames until everything
        // reports ready so the first visible frame cannot stall.
        for (let attempt = 0; attempt < 180; attempt++) {
            env.update(settings, biome.current, scene);
            terrain.update(rig.camera, env);
            character.update(rig.camera, env);
            scene.render();
            if (terrain.ready && character.isReady() && scene.isReady()) break;
            await nextFrame();
        }

        // Say plainly what came up. A partially-drawn scene is diagnosable; a black
        // rectangle with a clean console is not.
        console.info(
            `[substrate] boot: terrain material ${terrain.compiled ? "ok" : "FAILED"}, ` +
                `character material ${characterOk ? "ok" : "FAILED"}, ` +
                `height mirror ${terrain.field.mirrorValid ? "ok" : "FAILED"}, ` +
                `ground at origin ${terrain.field.sampleHeight(0, 0).toFixed(2)} m`,
        );
        report(1);
    });

    loader.add("overlay", 1, () => {
        overlay = new Overlay({ root: stage, settings, perf, gpu, scene, input, biome, capability });
        registerActions(overlay, settings, mover, rig, terrain);
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

        perf.begin(S_UNIFORMS);
        env.update(settings, biome.current, scene);
        terrain.update(rig.camera, env);
        character.update(rig.camera, env);
        perf.end(S_UNIFORMS);

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

    (window as unknown as { __substrateDispose?: () => void }).__substrateDispose = () => {
        engine.stopRenderLoop();
        overlay.dispose();
        terrain.dispose();
        character.dispose();
        input.dispose();
        unbindEngine();
        scene.dispose();
        engine.dispose();
    };
}

/** Overlay buttons. Phase 10's element interactions register here too. */
function registerActions(overlay: Overlay, settings: Settings, mover: Mover, rig: CameraRig, terrain: Terrain): void {
    overlay.addAction("cycle biome", () => {
        const current = settings.get("world.biome") as BiomeId;
        const next = BIOME_IDS[(BIOME_IDS.indexOf(current) + 1) % BIOME_IDS.length];
        settings.set("world.biome", next);
    });
    overlay.addAction("origin", () => {
        mover.teleport(0, 0);
        mover.position.y = terrain.field.sampleHeight(0, 0);
        rig.snap();
    });
    overlay.addAction("walk 800m", () => {
        // The Phase 1 acceptance test, as one click.
        mover.teleport(800, 0);
        mover.position.y = terrain.field.sampleHeight(800, 0);
        rig.snap();
    });
    overlay.addAction("noon", () => settings.set("world.sunElevation", 68));
    overlay.addAction("golden", () => settings.set("world.sunElevation", 8));
}

boot().catch((err) => {
    console.error("[substrate] fatal", err);
    showFatalError(err instanceof Error ? err.message : String(err));
});
