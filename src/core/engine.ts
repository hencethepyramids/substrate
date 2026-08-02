import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import type { Capability } from "./capability";
import type { Settings } from "./settings";

/**
 * Engine construction. WebGPU only.
 *
 * Only the features the adapter actually granted are requested — asking for one it
 * does not have makes requestDevice reject outright rather than degrade.
 */
export async function createEngine(canvas: HTMLCanvasElement, capability: Capability): Promise<WebGPUEngine> {
    const engine = new WebGPUEngine(canvas, {
        powerPreference: "high-performance",
        // MSAA is off by design: TAA in Phase 9 handles edges, and MSAA would cost
        // a resolve on every render target the deferred-ish passes touch.
        antialias: false,
        stencil: false,
        adaptToDeviceRatio: true,
        doNotHandleContextLost: false,
        deviceDescriptor: capability.grantedFeatures.length > 0 ? { requiredFeatures: capability.grantedFeatures } : undefined,
    });

    await engine.initAsync();
    return engine;
}

/** Wires the engine to the settings that change its configuration, and to resize. */
export function bindEngineSettings(engine: WebGPUEngine, settings: Settings): () => void {
    const applyScale = (scale: number) => engine.setHardwareScalingLevel(1 / scale);
    applyScale(settings.get("render.resolutionScale"));
    const offScale = settings.on("render.resolutionScale", applyScale);

    const onResize = () => engine.resize();
    window.addEventListener("resize", onResize);

    return () => {
        offScale();
        window.removeEventListener("resize", onResize);
    };
}
