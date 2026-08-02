import type { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import type { WebGPUPerfCounter } from "@babylonjs/core/Engines/WebGPU/webgpuPerfCounter";
import type { Settings } from "./settings";

/**
 * Per-pass GPU timings from real WebGPU timestamp queries (rule 7).
 *
 * Each pass registers a provider rather than a counter reference, because Babylon
 * swaps the counter object out whenever timing is toggled — a cached reference goes
 * stale and silently reports the last value forever.
 */

export interface GpuPass {
    name: string;
    /** Last frame, in ms. */
    ms: number;
    /** Rolling average over the last second, in ms. */
    avgMs: number;
}

type CounterProvider = () => WebGPUPerfCounter | undefined;

const NS_TO_MS = 1e-6;

export class GpuTimings {
    /** True only if the adapter granted `timestamp-query` and the device took it. */
    readonly supported: boolean;

    readonly passes: GpuPass[] = [];

    private readonly _engine: WebGPUEngine;
    private readonly _providers: CounterProvider[] = [];
    private _enabled = false;

    /** Sum of every registered pass. Unregistered passes are simply absent — this is not whole-frame time. */
    totalMs = 0;

    constructor(engine: WebGPUEngine, settings: Settings, supported: boolean) {
        this._engine = engine;
        this.supported = supported;

        this.register("main pass", () => engine.gpuTimeInFrameForMainPass);

        this._applyEnabled(supported && settings.get("perf.gpuTiming"));
        settings.on("perf.gpuTiming", (on) => this._applyEnabled(supported && on));
    }

    get enabled(): boolean {
        return this._enabled;
    }

    /**
     * Register a named pass. Later phases call this with their render target or
     * compute shader, e.g. `register('substrate', () => substrateRT.gpuTimeInFrame)`.
     */
    register(name: string, provider: CounterProvider): number {
        this.passes.push({ name, ms: 0, avgMs: 0 });
        this._providers.push(provider);
        return this._providers.length - 1;
    }

    /** Read every counter. Call once per frame, after render. Allocation-free. */
    sample(): void {
        let total = 0;
        for (let i = 0; i < this._providers.length; i++) {
            const pass = this.passes[i];
            if (!this._enabled) {
                pass.ms = 0;
                pass.avgMs = 0;
                continue;
            }
            const counter = this._providers[i]();
            if (counter === undefined) {
                pass.ms = 0;
                pass.avgMs = 0;
                continue;
            }
            pass.ms = counter.counter.current * NS_TO_MS;
            pass.avgMs = counter.counter.lastSecAverage * NS_TO_MS;
            total += pass.avgMs;
        }
        this.totalMs = total;
    }

    private _applyEnabled(on: boolean): void {
        if (this._enabled === on) return;
        this._enabled = on;
        this._engine.enableGPUTimingMeasurements = on;
    }
}
