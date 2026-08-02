import { Scene } from "@babylonjs/core/scene";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import type { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";

import { probeWebGPU, showCapabilityFailure } from "./core/capability";
import { createEngine, bindEngineSettings } from "./core/engine";
import { LoadingScreen, nextFrame } from "./core/loading";
import { Settings } from "./core/settings";
import { BiomeState } from "./core/biome";
import { Perf } from "./core/perf";
import { GpuTimings } from "./core/gpuTimer";
import { Input } from "./core/input";
import { CameraRig } from "./core/cameraRig";
import { Mover } from "./core/mover";
import { Phase0World } from "./core/phase0World";
import { Overlay } from "./ui/overlay";
import { BIOME_IDS } from "./elements/registry";
import type { BiomeId } from "./elements/types";

/**
 * SUBSTRATE — entry point and frame orchestration.
 *
 * Phase 0: harness only. Everything below is structured so that later phases hang
 * their systems off the existing timing sections and settings, rather than
 * restructuring the loop.
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

    const settings = new Settings();
    const biome = new BiomeState(settings);
    const perf = new Perf(512);
    const loader = new LoadingScreen(stage);

    let engine!: WebGPUEngine;
    let scene!: Scene;
    let gpu!: GpuTimings;
    let input!: Input;
    let rig!: CameraRig;
    let world!: Phase0World;
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
        scene.skipFrustumClipping = false;
        gpu = new GpuTimings(engine, settings, capability.has("timestamp-query"));
        input = new Input(canvas);
        rig = new CameraRig(scene, settings);
    });

    loader.add("world", 2, () => {
        world = new Phase0World(scene, settings, biome);
        world.setCharacterPose(mover.position, mover.facing);
        world.update(rig.camera);
    });

    // Rule 2: every pipeline compiled and drawn once behind the loading screen.
    loader.add("compiling pipelines", 6, async (report) => {
        const materials = world.materials;
        for (let i = 0; i < materials.length; i++) {
            await materials[i].forceCompilationAsync(world.meshes[i]);
            report((i + 1) / (materials.length + 1));
        }
        // Compilation is not the whole story on WebGPU — the render pipeline state
        // object is only built on first draw. Draw real frames until everything reports
        // ready so the first visible frame cannot stall.
        for (let attempt = 0; attempt < 120; attempt++) {
            scene.render();
            if (world.isReady() && scene.isReady()) break;
            await nextFrame();
        }
        report(1);
    });

    loader.add("overlay", 1, () => {
        overlay = new Overlay({
            root: stage,
            settings,
            perf,
            gpu,
            scene,
            input,
            biome,
            capability,
        });
        registerActions(overlay, settings, mover, rig);
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
        world.setCharacterPose(mover.position, mover.facing);
        perf.end(S_SIM);

        perf.begin(S_CAMERA);
        // The rig uses real time, not simulation time — pausing must not freeze the camera.
        rig.update(input, mover.position, perf.dt);
        perf.end(S_CAMERA);

        perf.begin(S_UNIFORMS);
        // The world owns the clear colour too — it is the same sky the fog mixes toward,
        // and two owners is how the horizon seam got in.
        world.update(rig.camera);
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

    // Held for teardown symmetry; nothing calls this yet, but every system that
    // allocates GPU memory must be reachable from one place when it does.
    (window as unknown as { __substrateDispose?: () => void }).__substrateDispose = () => {
        engine.stopRenderLoop();
        overlay.dispose();
        world.dispose();
        input.dispose();
        unbindEngine();
        scene.dispose();
        engine.dispose();
    };
}

/** Overlay buttons. Phase 10's element interactions register here too. */
function registerActions(overlay: Overlay, settings: Settings, mover: Mover, rig: CameraRig): void {
    overlay.addAction("cycle biome", () => {
        const current = settings.get("world.biome") as BiomeId;
        const next = BIOME_IDS[(BIOME_IDS.indexOf(current) + 1) % BIOME_IDS.length];
        settings.set("world.biome", next);
    });
    overlay.addAction("origin", () => {
        mover.teleport(0, 0);
        rig.snap();
    });
    overlay.addAction("noon", () => settings.set("world.sunElevation", 68));
    overlay.addAction("golden", () => settings.set("world.sunElevation", 8));
}

boot().catch((err) => {
    console.error("[substrate] fatal", err);
    showCapabilityFailure(err instanceof Error ? err.message : String(err));
});
