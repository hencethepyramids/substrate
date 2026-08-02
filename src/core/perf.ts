/**
 * CPU-side frame instrumentation.
 *
 * Frame pacing and per-system CPU cost are measured here with performance.now().
 * GPU pass cost is NOT measured here — see gpuTimer.ts, which uses real WebGPU
 * timestamp queries. Wrapping performance.now() around a draw call measures nothing
 * useful on a modern driver.
 *
 * Nothing on the per-frame path allocates. Percentiles are recomputed at overlay
 * refresh rate, not per frame.
 */

export interface FrameStats {
    /** Samples currently in the window. */
    count: number;
    meanMs: number;
    medianMs: number;
    p95Ms: number;
    /** Mean of the worst 1% of frames, in ms. */
    low1Ms: number;
    /** 1000 / low1Ms — the number people actually quote. */
    low1Fps: number;
    minMs: number;
    maxMs: number;
}

interface Section {
    name: string;
    /** Accumulated time this frame (ms). */
    acc: number;
    /** Timestamp of the open begin(), or -1. */
    open: number;
    /** Last completed frame's total (ms). */
    lastMs: number;
    /** Exponential moving average (ms). */
    avgMs: number;
}

const EMA_ALPHA = 0.08;

export class Perf {
    /** Wall-clock delta between the last two frame starts, in ms. */
    dtMs = 0;
    /** Seconds, clamped — safe to integrate against. */
    dt = 0;
    /** Total frames since boot. */
    frameId = 0;
    /** CPU time from frameBegin() to frameEnd(), in ms. */
    cpuFrameMs = 0;

    readonly stats: FrameStats = {
        count: 0,
        meanMs: 0,
        medianMs: 0,
        p95Ms: 0,
        low1Ms: 0,
        low1Fps: 0,
        minMs: 0,
        maxMs: 0,
    };

    private readonly _ring: Float32Array;
    private readonly _scratch: Float32Array;
    private _sorted: Float32Array;
    private _sortedCount = -1;
    private _head = 0;
    private _filled = 0;

    private readonly _sections: Section[] = [];
    private _lastFrameStart = -1;
    private _frameStart = 0;

    constructor(historySize = 512) {
        this._ring = new Float32Array(historySize);
        this._scratch = new Float32Array(historySize);
        this._sorted = this._scratch;
    }

    /**
     * Register a CPU timing section. Call once at construction and hold the id —
     * the id is an array index, so begin/end are free on the hot path.
     */
    section(name: string): number {
        const existing = this._sections.findIndex((s) => s.name === name);
        if (existing >= 0) return existing;
        this._sections.push({ name, acc: 0, open: -1, lastMs: 0, avgMs: 0 });
        return this._sections.length - 1;
    }

    get sections(): readonly Section[] {
        return this._sections;
    }

    begin(id: number): void {
        this._sections[id].open = performance.now();
    }

    end(id: number): void {
        const s = this._sections[id];
        if (s.open < 0) return;
        s.acc += performance.now() - s.open;
        s.open = -1;
    }

    frameBegin(nowMs: number): void {
        this._frameStart = nowMs;
        if (this._lastFrameStart >= 0) {
            const dt = nowMs - this._lastFrameStart;
            this.dtMs = dt;
            // Clamp so an alt-tab or a breakpoint cannot teleport the simulation.
            this.dt = Math.min(dt, 100) * 0.001;
            this._ring[this._head] = dt;
            this._head = (this._head + 1) % this._ring.length;
            if (this._filled < this._ring.length) this._filled++;
        }
        this._lastFrameStart = nowMs;
        this.frameId++;

        for (let i = 0; i < this._sections.length; i++) {
            const s = this._sections[i];
            s.acc = 0;
            s.open = -1;
        }
    }

    frameEnd(nowMs: number): void {
        this.cpuFrameMs = nowMs - this._frameStart;
        for (let i = 0; i < this._sections.length; i++) {
            const s = this._sections[i];
            s.lastMs = s.acc;
            s.avgMs = s.avgMs === 0 ? s.acc : s.avgMs + (s.acc - s.avgMs) * EMA_ALPHA;
        }
    }

    /**
     * Recompute percentiles. Called at overlay refresh rate (~10 Hz), never per frame.
     * Sorts in place into a preallocated scratch buffer.
     */
    recomputeStats(): void {
        const n = this._filled;
        const st = this.stats;
        st.count = n;
        if (n === 0) return;

        // Copy the ring in whatever order — sorting discards order anyway.
        for (let i = 0; i < n; i++) this._scratch[i] = this._ring[i];
        if (this._sortedCount !== n) {
            this._sorted = n === this._scratch.length ? this._scratch : this._scratch.subarray(0, n);
            this._sortedCount = n;
        }
        const sorted = this._sorted;
        sorted.sort();

        let sum = 0;
        for (let i = 0; i < n; i++) sum += sorted[i];
        st.meanMs = sum / n;
        st.minMs = sorted[0];
        st.maxMs = sorted[n - 1];
        st.medianMs = percentile(sorted, n, 0.5);
        st.p95Ms = percentile(sorted, n, 0.95);

        // 1% low: mean of the slowest 1% of frames, minimum one sample.
        const worst = Math.max(1, Math.round(n * 0.01));
        let wsum = 0;
        for (let i = n - worst; i < n; i++) wsum += sorted[i];
        st.low1Ms = wsum / worst;
        st.low1Fps = st.low1Ms > 0 ? 1000 / st.low1Ms : 0;
    }

    /** Most recent `out.length` frame times, oldest first. Fills `out`, returns valid length. */
    readHistory(out: Float32Array): number {
        const n = Math.min(this._filled, out.length);
        const cap = this._ring.length;
        for (let i = 0; i < n; i++) {
            out[i] = this._ring[(this._head - n + i + cap) % cap];
        }
        return n;
    }

    reset(): void {
        this._head = 0;
        this._filled = 0;
        this._sortedCount = -1;
        this._lastFrameStart = -1;
        for (let i = 0; i < this._sections.length; i++) {
            const s = this._sections[i];
            s.acc = 0;
            s.avgMs = 0;
            s.lastMs = 0;
            s.open = -1;
        }
    }
}

/** Linear-interpolated percentile over an ascending-sorted array. */
function percentile(sorted: Float32Array, n: number, q: number): number {
    if (n === 1) return sorted[0];
    const pos = (n - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.min(n - 1, lo + 1);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
