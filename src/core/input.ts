/**
 * Input. Pointer lock, WASD relative to camera, mouse look, wheel zoom, sprint.
 *
 * Deltas accumulate on the event thread and are consumed once per frame by
 * endFrame(). Nothing here allocates after construction.
 */

const KEY_FORWARD = ["KeyW", "ArrowUp"];
const KEY_BACK = ["KeyS", "ArrowDown"];
const KEY_LEFT = ["KeyA", "ArrowLeft"];
const KEY_RIGHT = ["KeyD", "ArrowRight"];
const KEY_SPRINT = ["ShiftLeft", "ShiftRight"];
/** Hold to slide. Ctrl rather than Space, which Phase 9 will want for a jump. */
const KEY_SLIDE = ["ControlLeft", "ControlRight"];

export class Input {
    /** Local move intent. x = strafe (+right), y = forward (+forward). Length <= 1. */
    readonly move = { x: 0, y: 0 };
    /** True while any movement key is held. */
    moving = false;
    sprint = false;
    /** Held: drop onto the surface and let gravity do the work. */
    slide = false;
    /** Right mouse held — the carve input (Phase 8). */
    carve = false;
    /**
     * Pressed THIS FRAME — the ignite verb (Phase 10).
     *
     * Edge triggered, unlike everything above it, and the difference is the point: `move`
     * and `carve` are states the world samples continuously, while a verb is an event that
     * happens once. Holding the key must not light a new fire every frame, so this is set
     * on the press and cleared by endFrame(), and auto-repeat is filtered — a held key
     * repeats about thirty times a second and would otherwise stack thirty ignitions.
     */
    ignite = false;
    /**
     * Held — gather material into the hands, and put it back.
     *
     * States rather than events, unlike `ignite` above, and the difference follows the
     * physics rather than the input convention: lighting a fire is a moment, and digging is
     * a rate. A verb that moves a quantity per second has to be sampled per frame or the
     * amount moved would depend on the frame rate.
     */
    gather = false;
    place = false;
    /** Held — tread the ground down. A rate, like the two above. */
    pack = false;
    /**
     * Held - command the ground up, or down.
     *
     * Rates, like the digging verbs, because terrain answers continuously rather than in
     * discrete shovelfuls. These are the BENDING inputs and they are a different grammar
     * from the carrying ones, not a variant of them.
     */
    raise = false;
    lower = false;
    /** Held - raise the ground under your own feet and ride it. */
    pedestal = false;
    /**
     * Held - carry material sideways, away from you and back toward you.
     *
     * The bending verbs above act on ONE SPOT: they make the ground in front of you higher
     * or lower and the material comes from directly around it. These two have a bearing.
     * They are the first verbs that could not have been written before Phase 12, because
     * until shove() existed the substrate had no way to express "over there".
     */
    sweep = false;
    draw = false;
    /**
     * Pressed this frame - send a ridge running away from you. An event, like throw.
     *
     * The only bending input that is not a rate, and the reason is that it is not a rate:
     * the other five command ground for as long as they are held, and this one launches
     * something that then travels on its own. Holding it would stack waves rather than make
     * a longer one.
     */
    ridge = false;
    /** Pressed this frame - throw a wall up across your facing. An event, like the ridge. */
    wall = false;
    /** Pressed this frame - throw what is carried. An event, like ignite. */
    throwIt = false;
    /** Pressed this frame - leave the ground. */
    jump = false;
    /** Accumulated mouse delta in raw pixels since the last endFrame(). */
    lookX = 0;
    lookY = 0;
    /** Accumulated wheel delta since the last endFrame(). Positive = zoom out. */
    wheel = 0;
    pointerLocked = false;

    private readonly _canvas: HTMLCanvasElement;
    private readonly _down = new Set<string>();
    private readonly _disposers: (() => void)[] = [];

    constructor(canvas: HTMLCanvasElement) {
        this._canvas = canvas;

        this._listen(window, "keydown", (e) => {
            const ev = e as KeyboardEvent;
            if (isTypingTarget(ev.target)) return;
            this._down.add(ev.code);
            if (ev.code === "KeyE" && !ev.repeat) this.ignite = true;
            if (ev.code === "KeyT" && !ev.repeat) this.throwIt = true;
            if (ev.code === "KeyB" && !ev.repeat) this.ridge = true;
            if (ev.code === "KeyN" && !ev.repeat) this.wall = true;
            if (ev.code === "Space" && !ev.repeat) this.jump = true;
        });
        this._listen(window, "keyup", (e) => this._down.delete((e as KeyboardEvent).code));
        // A lost focus with keys held would otherwise leave the character sprinting forever.
        this._listen(window, "blur", () => this._down.clear());

        this._listen(canvas, "pointerdown", (e) => {
            const ev = e as PointerEvent;
            if (ev.button === 0 && !this.pointerLocked) this.requestLock();
            if (ev.button === 2) this.carve = true;
        });
        this._listen(window, "pointerup", (e) => {
            if ((e as PointerEvent).button === 2) this.carve = false;
        });
        this._listen(canvas, "contextmenu", (e) => e.preventDefault());

        this._listen(window, "pointermove", (e) => {
            if (!this.pointerLocked) return;
            const ev = e as PointerEvent;
            this.lookX += ev.movementX;
            this.lookY += ev.movementY;
        });

        this._listen(
            canvas,
            "wheel",
            (e) => {
                const ev = e as WheelEvent;
                ev.preventDefault();
                // Normalise line-mode wheels to roughly pixel scale.
                this.wheel += ev.deltaMode === 1 ? ev.deltaY * 16 : ev.deltaY;
            },
            { passive: false },
        );

        this._listen(document, "pointerlockchange", () => {
            this.pointerLocked = document.pointerLockElement === this._canvas;
            if (!this.pointerLocked) {
                this.carve = false;
                this.lookX = 0;
                this.lookY = 0;
            }
        });
    }

    requestLock(): void {
        // unadjustedMovement skips OS pointer acceleration; not every platform grants it.
        const el = this._canvas as HTMLCanvasElement & {
            requestPointerLock(options?: { unadjustedMovement?: boolean }): Promise<void> | void;
        };
        try {
            const result = el.requestPointerLock({ unadjustedMovement: true });
            if (result && typeof (result as Promise<void>).catch === "function") {
                (result as Promise<void>).catch(() => el.requestPointerLock());
            }
        } catch {
            el.requestPointerLock();
        }
    }

    releaseLock(): void {
        if (this.pointerLocked) document.exitPointerLock();
    }

    isDown(code: string): boolean {
        return this._down.has(code);
    }

    /** Recompute continuous state. Call at the top of the frame. */
    update(): void {
        const forward = (anyDown(this._down, KEY_FORWARD) ? 1 : 0) - (anyDown(this._down, KEY_BACK) ? 1 : 0);
        const strafe = (anyDown(this._down, KEY_RIGHT) ? 1 : 0) - (anyDown(this._down, KEY_LEFT) ? 1 : 0);

        // Normalise so diagonals are not faster than cardinals.
        const lengthSq = forward * forward + strafe * strafe;
        if (lengthSq > 1e-6) {
            const inv = 1 / Math.sqrt(lengthSq);
            this.move.x = strafe * inv;
            this.move.y = forward * inv;
            this.moving = true;
        } else {
            this.move.x = 0;
            this.move.y = 0;
            this.moving = false;
        }

        this.sprint = anyDown(this._down, KEY_SPRINT);
        this.slide = anyDown(this._down, KEY_SLIDE);
        this.gather = this._down.has("KeyQ");
        this.place = this._down.has("KeyF");
        this.pack = this._down.has("KeyR");
        this.raise = this._down.has("KeyC");
        this.lower = this._down.has("KeyV");
        this.pedestal = this._down.has("KeyG");
        // Z X C V, left to right: carry away, carry back, raise, lower. One row, and the
        // two that have a direction sit next to each other rather than next to the digging.
        this.sweep = this._down.has("KeyZ");
        this.draw = this._down.has("KeyX");
    }

    /** Zero the accumulated deltas. Call at the bottom of the frame, after everything has read them. */
    endFrame(): void {
        this.lookX = 0;
        this.lookY = 0;
        this.wheel = 0;
        // Verbs are consumed by the frame that saw them, like the deltas above.
        this.ignite = false;
        this.throwIt = false;
        this.jump = false;
        this.ridge = false;
        this.wall = false;
    }

    dispose(): void {
        for (const off of this._disposers) off();
        this._disposers.length = 0;
        this._down.clear();
    }

    private _listen(target: EventTarget, type: string, fn: (e: Event) => void, options?: AddEventListenerOptions): void {
        target.addEventListener(type, fn, options);
        this._disposers.push(() => target.removeEventListener(type, fn, options));
    }
}

function anyDown(set: Set<string>, codes: string[]): boolean {
    for (let i = 0; i < codes.length; i++) if (set.has(codes[i])) return true;
    return false;
}

/** True when a keystroke belongs to a form field rather than to the game. */
export function isTypingTarget(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el || !el.tagName) return false;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}
