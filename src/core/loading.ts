/**
 * Loading screen with real progress.
 *
 * Progress is weighted by declared task cost and advances only when a task actually
 * finishes, so the bar cannot lie. Tasks may report sub-progress, which is what the
 * Phase 2+ pipeline warm-up uses while it compiles and draws each pipeline once.
 *
 * Rule 2: every pipeline is warmed behind this screen. The first ignition must not
 * compile a shader mid-frame.
 */

interface Task {
    label: string;
    weight: number;
    run: (report: (fraction: number) => void) => Promise<void> | void;
}

export class LoadingScreen {
    private readonly _root: HTMLElement;
    private readonly _el: HTMLDivElement;
    private readonly _bar: HTMLDivElement;
    private readonly _label: HTMLDivElement;
    private readonly _pct: HTMLDivElement;
    private readonly _tasks: Task[] = [];

    private _totalWeight = 0;
    private _doneWeight = 0;

    constructor(root: HTMLElement) {
        this._root = root;

        const el = document.createElement("div");
        el.style.cssText = [
            "position:absolute",
            "inset:0",
            "display:flex",
            "flex-direction:column",
            "align-items:center",
            "justify-content:center",
            "gap:18px",
            "background:radial-gradient(120% 90% at 50% 40%, #0b1018 0%, #05070b 70%)",
            "transition:opacity .45s ease",
            "z-index:50",
        ].join(";");

        const mark = document.createElement("div");
        mark.textContent = "SUBSTRATE";
        mark.style.cssText = "font-size:15px;letter-spacing:.55em;text-indent:.55em;color:#8a9bab;font-weight:600";

        const sub = document.createElement("div");
        sub.textContent = "four elements, one simulation core";
        sub.style.cssText = "font-size:11px;letter-spacing:.18em;color:#41505f;margin-top:-10px";

        const track = document.createElement("div");
        track.style.cssText = "width:min(420px,60vw);height:2px;background:#1a2430;overflow:hidden;border-radius:1px";

        const bar = document.createElement("div");
        bar.style.cssText = "width:0%;height:100%;background:linear-gradient(90deg,#4a7fb5,#9ec9f0);transition:width .18s ease";
        track.appendChild(bar);

        const row = document.createElement("div");
        row.style.cssText = "display:flex;gap:12px;width:min(420px,60vw);font-size:11px;color:#5b6b7d";

        const label = document.createElement("div");
        label.style.cssText = "flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
        label.textContent = "starting";

        const pct = document.createElement("div");
        pct.style.cssText = "font-variant-numeric:tabular-nums;color:#8a9bab";
        pct.textContent = "0%";

        row.append(label, pct);
        el.append(mark, sub, track, row);
        root.appendChild(el);

        this._el = el;
        this._bar = bar;
        this._label = label;
        this._pct = pct;
    }

    /** Declare a unit of load work. Weight is relative cost — it only needs to be roughly right. */
    add(label: string, weight: number, run: Task["run"]): void {
        this._tasks.push({ label, weight, run });
        this._totalWeight += weight;
    }

    async run(): Promise<void> {
        for (const task of this._tasks) {
            this._label.textContent = task.label;
            // Yield so the label and bar actually paint before the work blocks.
            await nextFrame();

            const base = this._doneWeight;
            await task.run((fraction) => {
                const clamped = fraction < 0 ? 0 : fraction > 1 ? 1 : fraction;
                this._paint(base + task.weight * clamped);
            });

            this._doneWeight = base + task.weight;
            this._paint(this._doneWeight);
        }
        this._label.textContent = "ready";
        await nextFrame();
    }

    async dismiss(): Promise<void> {
        this._el.style.opacity = "0";
        await new Promise<void>((resolve) => setTimeout(resolve, 470));
        this._el.remove();
    }

    fail(err: unknown): void {
        const message = err instanceof Error ? err.message : String(err);
        this._label.style.color = "#e0704f";
        this._label.textContent = message;
        this._bar.style.background = "#e0704f";
        console.error("[substrate] load failed", err);
    }

    /** Escape hatch for a hard failure before any task ran. */
    get root(): HTMLElement {
        return this._root;
    }

    private _paint(weight: number): void {
        const fraction = this._totalWeight > 0 ? weight / this._totalWeight : 1;
        this._bar.style.width = `${(fraction * 100).toFixed(1)}%`;
        this._pct.textContent = `${Math.round(fraction * 100)}%`;
    }
}

export function nextFrame(): Promise<void> {
    return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}
