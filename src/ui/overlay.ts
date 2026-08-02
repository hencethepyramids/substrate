import type { Scene } from "@babylonjs/core/scene";
import { SceneInstrumentation } from "@babylonjs/core/Instrumentation/sceneInstrumentation";
import type { AnyCtrl, SettingKey, Settings } from "../core/settings";
import type { Perf } from "../core/perf";
import type { GpuTimings } from "../core/gpuTimer";
import type { Capability } from "../core/capability";
import type { BiomeState } from "../core/biome";
import { isTypingTarget, type Input } from "../core/input";
import { OVERLAY_CSS } from "./overlayStyles";

/**
 * Settings + performance overlay. F1 or ` to toggle.
 *
 * The settings pane builds itself from the SCHEMA table, which is what makes
 * "adding a toggle or a slider is one line" literally true — nothing in this file
 * needs to change when a control is added.
 *
 * Refreshes at ~15 Hz, not per frame. Building strings and touching the DOM 240
 * times a second would show up in the very numbers it is trying to report.
 */

const REFRESH_HZ = 15;
const GRAPH_SAMPLES = 240;

export interface OverlayDeps {
    root: HTMLElement;
    settings: Settings;
    perf: Perf;
    gpu: GpuTimings;
    scene: Scene;
    input: Input;
    biome: BiomeState;
    capability: Capability;
}

export class Overlay {
    private readonly _d: OverlayDeps;
    private readonly _root: HTMLDivElement;
    private readonly _instr: SceneInstrumentation;
    private readonly _refreshers = new Map<SettingKey, () => void>();
    private readonly _disposers: (() => void)[] = [];

    private readonly _hist = new Float32Array(GRAPH_SAMPLES);
    private _graph!: HTMLCanvasElement;
    private _gctx!: CanvasRenderingContext2D;
    private _graphW = 0;
    private _graphH = 0;

    private _fpsEl!: HTMLElement;
    private _msEl!: HTMLElement;
    private _statBody!: HTMLElement;
    private _sceneBody!: HTMLElement;
    private _gpuBody!: HTMLElement;
    private _cpuBody!: HTMLElement;
    private _actionsBody!: HTMLElement;
    private _biomeBlurb!: HTMLElement;
    private _toastEl!: HTMLElement;

    private _nextRefresh = 0;
    private _toastUntil = 0;
    /**
     * The one key currently being written by a control. Only that control is skipped
     * on the echo — a blanket flag would also swallow the knock-on writes a change
     * triggers (biome presets moving the sun and wind sliders, for one).
     */
    private _writingKey: SettingKey | null = null;

    constructor(deps: OverlayDeps) {
        this._d = deps;
        this._instr = new SceneInstrumentation(deps.scene);

        injectStyles();

        const root = document.createElement("div");
        root.className = "sb-root";
        this._root = root;
        deps.root.appendChild(root);

        root.appendChild(this._buildPerfPanel());
        root.appendChild(this._buildSettingsPanel());

        this._toastEl = div("sb-toast");
        root.appendChild(this._toastEl);

        this._applyScale(deps.settings.get("perf.overlayScale"));
        this._applyOpen(deps.settings.get("ui.overlayOpen"));
        this._applyAdvanced(deps.settings.get("ui.showAdvanced"));

        // Keep the DOM in step with code-side writes (biome presets, hotkeys, replays).
        this._disposers.push(
            deps.settings.onAny((key) => {
                if (key === this._writingKey) return;
                this._refreshers.get(key)?.();
            }),
        );
        this._disposers.push(deps.settings.on("perf.overlayScale", (v) => this._applyScale(v)));
        this._disposers.push(deps.settings.on("ui.overlayOpen", (v) => this._applyOpen(v)));
        this._disposers.push(deps.settings.on("ui.showAdvanced", (v) => this._applyAdvanced(v)));
        this._disposers.push(
            deps.biome.onChange((def) => {
                this._biomeBlurb.textContent = def.blurb;
            }),
        );

        const onKey = (e: KeyboardEvent) => {
            if (isTypingTarget(e.target)) return;
            if (e.code === "F1" || e.code === "Backquote") {
                e.preventDefault();
                this.toggle();
            }
        };
        window.addEventListener("keydown", onKey);
        this._disposers.push(() => window.removeEventListener("keydown", onKey));

        // Grabbing the pointer hides the settings pane — controls you cannot click are
        // worse than no controls — but the perf pane stays up. Playing is exactly when
        // the frame graph is worth reading, and the overlay's own open state is left
        // alone so releasing the pointer brings the settings straight back.
        const onLock = () => {
            this._root.dataset.locked = document.pointerLockElement ? "1" : "0";
        };
        document.addEventListener("pointerlockchange", onLock);
        this._disposers.push(() => document.removeEventListener("pointerlockchange", onLock));
    }

    get open(): boolean {
        return this._d.settings.get("ui.overlayOpen");
    }

    toggle(): void {
        this._d.settings.set("ui.overlayOpen", !this.open);
    }

    /** Register a one-click demo button. Phase 10 hangs the element interactions off this. */
    addAction(label: string, fn: () => void): void {
        const btn = document.createElement("button");
        btn.className = "sb-btn";
        btn.textContent = label;
        btn.addEventListener("click", () => {
            fn();
            this.toast(label);
        });
        this._actionsBody.appendChild(btn);
    }

    toast(text: string): void {
        this._toastEl.textContent = text;
        this._toastEl.dataset.on = "1";
        this._toastUntil = performance.now() + 1400;
    }

    /** Call once per frame. Throttles internally. */
    update(nowMs: number): void {
        if (this._toastUntil !== 0 && nowMs > this._toastUntil) {
            this._toastEl.dataset.on = "0";
            this._toastUntil = 0;
        }
        if (nowMs < this._nextRefresh) return;
        this._nextRefresh = nowMs + 1000 / REFRESH_HZ;
        if (!this.open) return;

        const { perf } = this._d;
        perf.recomputeStats();
        this._paintNumbers();
        this._paintGraph();
    }

    dispose(): void {
        for (const off of this._disposers) off();
        this._disposers.length = 0;
        this._instr.dispose();
        this._root.remove();
    }

    // -- panels --------------------------------------------------------------

    private _buildPerfPanel(): HTMLElement {
        const panel = div("sb-panel sb-perf");

        const big = div("sb-big");
        this._fpsEl = div("sb-fps");
        this._fpsEl.textContent = "--";
        const unit = div("sb-fps-unit");
        unit.textContent = "FPS median";
        this._msEl = div("sb-ms");
        this._msEl.textContent = "-- ms";
        big.append(this._fpsEl, unit, this._msEl);

        this._graph = document.createElement("canvas");
        this._graph.className = "sb-graph";
        this._gctx = this._graph.getContext("2d", { alpha: false })!;

        this._statBody = div("sb-sec");
        this._sceneBody = div("sb-sec");
        this._gpuBody = div("sb-sec");
        this._cpuBody = div("sb-sec");

        const adapter = div("sb-sec");
        adapter.style.color = "#3d4a58";
        adapter.textContent = this._d.capability.adapterLabel;

        panel.append(big, this._graph, this._statBody, this._sceneBody, this._gpuBody, this._cpuBody, adapter);
        return panel;
    }

    private _buildSettingsPanel(): HTMLElement {
        const panel = div("sb-panel sb-settings");

        const hdr = div("sb-hdr");
        const title = div("sb-title");
        title.textContent = "SUBSTRATE";
        const advBtn = document.createElement("button");
        advBtn.className = "sb-btn";
        advBtn.textContent = "adv";
        advBtn.title = "Show advanced controls";
        advBtn.addEventListener("click", () => this._d.settings.set("ui.showAdvanced", !this._d.settings.get("ui.showAdvanced")));
        const resetBtn = document.createElement("button");
        resetBtn.className = "sb-btn";
        resetBtn.textContent = "reset";
        resetBtn.addEventListener("click", () => {
            this._d.settings.reset();
            this.toast("settings reset");
        });
        hdr.append(title, advBtn, resetBtn);

        const scroll = div("sb-scroll");

        // Actions first — Phase 10 demo buttons live here.
        const actions = this._group("Actions", scroll, false);
        this._actionsBody = div("sb-actions");
        actions.body.appendChild(this._actionsBody);

        const settings = this._d.settings;
        const byGroup = new Map<string, HTMLElement>();
        for (const group of settings.groups) {
            const allAdvanced = settings.keys.every((k) => {
                const c = settings.ctrl(k);
                return c.group !== group || c.advanced === true;
            });
            const g = this._group(group, scroll, allAdvanced);
            byGroup.set(group, g.body);
        }

        for (const key of settings.keys) {
            const ctrl = settings.ctrl(key);
            const body = byGroup.get(ctrl.group)!;
            this._buildRow(key, ctrl, body);
        }

        // The biome blurb sits under the World group so the selector explains itself.
        this._biomeBlurb = div("sb-hint");
        this._biomeBlurb.textContent = this._d.biome.current.blurb;
        byGroup.get("World")?.insertBefore(this._biomeBlurb, byGroup.get("World")!.children[1] ?? null);

        const foot = div("sb-foot");
        foot.textContent = "F1 or ` toggles · click to lock pointer · WASD, shift to sprint";

        panel.append(hdr, scroll, foot);
        return panel;
    }

    private _group(name: string, parent: HTMLElement, advancedOnly: boolean): { root: HTMLElement; body: HTMLElement } {
        const root = div("sb-group" + (advancedOnly ? " sb-group-adv" : ""));
        const storageKey = `substrate.group.${name}`;
        let open = true;
        try {
            open = localStorage.getItem(storageKey) !== "0";
        } catch {
            /* storage blocked */
        }
        root.dataset.open = open ? "1" : "0";

        const hdr = div("sb-group-hdr");
        const caret = div("sb-caret");
        caret.textContent = "▾";
        const label = document.createElement("span");
        label.textContent = name;
        const reset = div("sb-reset");
        reset.textContent = "reset";
        reset.addEventListener("click", (e) => {
            e.stopPropagation();
            this._d.settings.resetGroup(name);
        });
        hdr.append(caret, label, reset);
        hdr.addEventListener("click", () => {
            const next = root.dataset.open === "1" ? "0" : "1";
            root.dataset.open = next;
            try {
                localStorage.setItem(storageKey, next);
            } catch {
                /* storage blocked */
            }
        });

        const body = div("sb-body");
        root.append(hdr, body);
        parent.appendChild(root);
        return { root, body };
    }

    private _buildRow(key: SettingKey, ctrl: AnyCtrl, parent: HTMLElement): void {
        const settings = this._d.settings;
        const row = div("sb-row" + (ctrl.advanced ? " sb-adv" : ""));
        const label = div("sb-row-label");
        label.textContent = ctrl.label;
        if (ctrl.hint) label.title = ctrl.hint;
        row.appendChild(label);

        const write = (value: unknown) => {
            this._writingKey = key;
            settings.set(key, value as never);
            this._writingKey = null;
        };

        if (ctrl.kind === "bool") {
            const box = document.createElement("input");
            box.type = "checkbox";
            box.className = "sb-check";
            box.checked = settings.get(key) as boolean;
            box.addEventListener("change", () => write(box.checked));
            row.appendChild(box);
            this._refreshers.set(key, () => {
                box.checked = settings.get(key) as boolean;
            });
        } else if (ctrl.kind === "num") {
            const wrap = div("sb-num");
            const range = document.createElement("input");
            range.type = "range";
            range.className = "sb-range";
            range.min = String(ctrl.min);
            range.max = String(ctrl.max);
            range.step = String(ctrl.step);
            const box = document.createElement("input");
            box.type = "number";
            box.className = "sb-val";
            box.min = range.min;
            box.max = range.max;
            box.step = range.step;
            if (ctrl.unit) box.title = ctrl.unit;

            const sync = () => {
                const v = settings.get(key) as number;
                range.value = String(v);
                // Do not fight the user mid-keystroke.
                if (document.activeElement !== box) box.value = String(v);
            };
            range.addEventListener("input", () => {
                write(Number(range.value));
                box.value = range.value;
            });
            box.addEventListener("change", () => {
                write(Number(box.value));
                sync();
            });
            sync();

            wrap.append(range, box);
            row.appendChild(wrap);
            this._refreshers.set(key, sync);
        } else {
            const select = document.createElement("select");
            select.className = "sb-select";
            for (let i = 0; i < ctrl.options.length; i++) {
                const opt = document.createElement("option");
                opt.value = ctrl.options[i];
                opt.textContent = ctrl.optionLabels?.[i] ?? ctrl.options[i];
                select.appendChild(opt);
            }
            select.value = settings.get(key) as string;
            select.addEventListener("change", () => write(select.value));
            row.appendChild(select);
            this._refreshers.set(key, () => {
                select.value = settings.get(key) as string;
            });
        }

        parent.appendChild(row);
        if (ctrl.hint && ctrl.kind !== "enum") {
            const hint = div("sb-hint" + (ctrl.advanced ? " sb-adv" : ""));
            hint.textContent = ctrl.hint;
            parent.appendChild(hint);
        }
    }

    // -- painting ------------------------------------------------------------

    private _paintNumbers(): void {
        const { perf, gpu, scene } = this._d;
        const st = perf.stats;

        this._fpsEl.textContent = st.medianMs > 0 ? (1000 / st.medianMs).toFixed(0) : "--";
        this._msEl.textContent = `${st.medianMs.toFixed(2)} ms`;

        setRows(this._statBody, "frame time", [
            ["median", `${st.medianMs.toFixed(2)} ms`],
            ["p95", `${st.p95Ms.toFixed(2)} ms`],
            ["1% low", `${st.low1Ms.toFixed(2)} ms  (${st.low1Fps.toFixed(0)} fps)`],
            ["cpu frame", `${perf.cpuFrameMs.toFixed(2)} ms`],
        ]);

        setRows(this._sceneBody, "scene", [
            ["draw calls", String(this._instr.drawCallsCounter.current)],
            ["triangles", formatCount(scene.getActiveIndices() / 3)],
            ["active meshes", String(scene.getActiveMeshes().length)],
        ]);

        if (!gpu.supported) {
            setRows(this._gpuBody, "gpu passes", [["unavailable", "no timestamp-query"]], true);
        } else if (!gpu.enabled) {
            setRows(this._gpuBody, "gpu passes", [["disabled", "perf.gpuTiming"]]);
        } else {
            const rows: [string, string][] = [];
            for (let i = 0; i < gpu.passes.length; i++) {
                const p = gpu.passes[i];
                rows.push([p.name, `${p.avgMs.toFixed(3)} ms`]);
            }
            rows.push(["measured total", `${gpu.totalMs.toFixed(3)} ms`]);
            setRows(this._gpuBody, "gpu passes", rows);
        }

        const cpuRows: [string, string][] = [];
        const sections = perf.sections;
        for (let i = 0; i < sections.length; i++) {
            cpuRows.push([sections[i].name, `${sections[i].avgMs.toFixed(3)} ms`]);
        }
        setRows(this._cpuBody, "cpu systems", cpuRows);
    }

    private _paintGraph(): void {
        const canvas = this._graph;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const cssW = canvas.clientWidth;
        const cssH = canvas.clientHeight;
        if (cssW === 0 || cssH === 0) return;
        const w = Math.round(cssW * dpr);
        const h = Math.round(cssH * dpr);
        if (w !== this._graphW || h !== this._graphH) {
            canvas.width = w;
            canvas.height = h;
            this._graphW = w;
            this._graphH = h;
        }

        const ctx = this._gctx;
        const range = this._d.settings.get("perf.graphRangeMs");
        const n = this._d.perf.readHistory(this._hist);

        ctx.fillStyle = "#070b10";
        ctx.fillRect(0, 0, w, h);

        // Target line — the budget this project is actually held to.
        const targetMs = 1000 / this._d.settings.get("perf.targetFps");
        const ty = h - (targetMs / range) * h;
        if (ty > 0 && ty < h) {
            ctx.strokeStyle = "#243343";
            ctx.setLineDash([3 * dpr, 3 * dpr]);
            ctx.beginPath();
            ctx.moveTo(0, ty);
            ctx.lineTo(w, ty);
            ctx.stroke();
            ctx.setLineDash([]);
        }

        if (n === 0) return;
        const barW = w / n;
        const good = targetMs;
        const bad = targetMs * 1.6;
        for (let i = 0; i < n; i++) {
            const ms = this._hist[i];
            let bh = (ms / range) * h;
            if (bh > h) bh = h;
            ctx.fillStyle = ms <= good ? "#4a7fb5" : ms <= bad ? "#c9a04b" : "#c9564b";
            ctx.fillRect(i * barW, h - bh, Math.max(1, barW - dpr * 0.5), bh);
        }

        // p95 marker so the graph and the numbers agree at a glance.
        const py = h - (this._d.perf.stats.p95Ms / range) * h;
        if (py > 0 && py < h) {
            ctx.strokeStyle = "rgba(158,201,240,.5)";
            ctx.beginPath();
            ctx.moveTo(0, py);
            ctx.lineTo(w, py);
            ctx.stroke();
        }
    }

    // -- state ---------------------------------------------------------------

    private _applyScale(scale: number): void {
        this._root.style.setProperty("--sb-scale", String(scale));
    }

    private _applyOpen(open: boolean): void {
        this._root.hidden = !open;
        // An open overlay you cannot click is a decoration.
        if (open) this._d.input.releaseLock();
    }

    private _applyAdvanced(on: boolean): void {
        this._root.dataset.adv = on ? "1" : "0";
    }
}

// -- small DOM helpers -------------------------------------------------------

function div(className: string): HTMLDivElement {
    const el = document.createElement("div");
    el.className = className;
    return el;
}

/**
 * Rebuilds a titled key/value block. Reuses existing row elements so a steady-state
 * refresh only writes textContent — no element churn, no layout thrash.
 */
function setRows(host: HTMLElement, title: string, rows: readonly [string, string][], warn = false): void {
    let header = host.firstElementChild as HTMLElement | null;
    if (!header || !header.classList.contains("sb-sec-title")) {
        header = div("sb-sec-title");
        host.insertBefore(header, host.firstChild);
    }
    if (header.textContent !== title) header.textContent = title;

    while (host.children.length - 1 > rows.length) host.lastElementChild!.remove();
    while (host.children.length - 1 < rows.length) {
        const row = div("sb-kv");
        row.append(document.createElement("span"), document.createElement("span"));
        host.appendChild(row);
    }
    for (let i = 0; i < rows.length; i++) {
        const row = host.children[i + 1] as HTMLElement;
        row.className = warn ? "sb-kv sb-warn" : "sb-kv";
        const k = row.children[0];
        const v = row.children[1];
        if (k.textContent !== rows[i][0]) k.textContent = rows[i][0];
        if (v.textContent !== rows[i][1]) v.textContent = rows[i][1];
    }
}

function formatCount(n: number): string {
    if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
    return n.toFixed(0);
}

let stylesInjected = false;
function injectStyles(): void {
    if (stylesInjected) return;
    stylesInjected = true;
    const style = document.createElement("style");
    style.textContent = OVERLAY_CSS;
    document.head.appendChild(style);
}
