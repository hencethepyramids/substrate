/**
 * WebGPU capability gate.
 *
 * WebGPU only. There is deliberately no WebGL path — half this project is compute
 * and storage-texture ping-pong, and a fallback would be a second renderer to
 * maintain, not a graceful degradation.
 */

/** Optional device features we take if the adapter offers them. */
const WANTED_FEATURES = [
    // Rule 7: per-pass GPU timings.
    "timestamp-query",
    // Phase 1 bakes height+derivative into RG32F and samples it with filtering.
    "float32-filterable",
    // Phase 3/6 field buffers are cheaper at half precision where it is available.
    "shader-f16",
] as const;

export interface Capability {
    ok: boolean;
    reason: string;
    features: ReadonlySet<string>;
    /** Mutable because GPUDeviceDescriptor.requiredFeatures is typed as a mutable array. */
    grantedFeatures: GPUFeatureName[];
    adapterLabel: string;
    maxTextureDimension2D: number;
    maxStorageBufferBindingSize: number;
    has(feature: string): boolean;
}

const FAIL = (reason: string): Capability => ({
    ok: false,
    reason,
    features: new Set<string>(),
    grantedFeatures: [],
    adapterLabel: "",
    maxTextureDimension2D: 0,
    maxStorageBufferBindingSize: 0,
    has: () => false,
});

export async function probeWebGPU(): Promise<Capability> {
    if (typeof navigator === "undefined" || !("gpu" in navigator) || !navigator.gpu) {
        return FAIL("This browser does not expose navigator.gpu.");
    }

    let adapter: GPUAdapter | null = null;
    try {
        adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    } catch (err) {
        return FAIL(`requestAdapter() threw: ${(err as Error).message}`);
    }
    if (!adapter) {
        return FAIL("No WebGPU adapter available. On a laptop, check that the browser is allowed to use the discrete GPU.");
    }

    const features = new Set<string>();
    adapter.features.forEach((f) => features.add(f));

    const granted = WANTED_FEATURES.filter((f) => features.has(f)) as unknown as GPUFeatureName[];

    // GPUAdapter.info is the current spec surface; requestAdapterInfo() was the older one.
    const info = (adapter as unknown as { info?: GPUAdapterInfo }).info;
    const label = info ? [info.vendor, info.architecture, info.description].filter(Boolean).join(" ") || "unknown adapter" : "unknown adapter";

    return {
        ok: true,
        reason: "",
        features,
        grantedFeatures: granted,
        adapterLabel: label,
        maxTextureDimension2D: adapter.limits.maxTextureDimension2D,
        maxStorageBufferBindingSize: Number(adapter.limits.maxStorageBufferBindingSize),
        has: (f: string) => features.has(f),
    };
}

/** Prints the reason and stops. No fallback, by design. */
export function showCapabilityFailure(reason: string): void {
    const stage = document.getElementById("stage");
    if (!stage) return;
    stage.innerHTML = "";
    const panel = document.createElement("div");
    panel.style.cssText = [
        "position:absolute",
        "inset:0",
        "display:flex",
        "flex-direction:column",
        "align-items:center",
        "justify-content:center",
        "gap:14px",
        "padding:40px",
        "text-align:center",
        "background:#05070b",
    ].join(";");
    panel.innerHTML = `
    <div style="font-size:13px;letter-spacing:.42em;color:#5b6b7d">SUBSTRATE</div>
    <div style="font-size:22px;font-weight:600;color:#e6edf3">WebGPU is required</div>
    <div style="max-width:52ch;font-size:13px;line-height:1.6;color:#8a9bab">${escapeHtml(reason)}</div>
    <div style="max-width:52ch;font-size:12px;line-height:1.6;color:#5b6b7d">
      Chrome 113+, Edge 113+, or Firefox 141+ on a machine with a discrete GPU.
      There is no WebGL fallback.
    </div>`;
    stage.appendChild(panel);
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
