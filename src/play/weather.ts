import type { Settings } from "../core/settings";

/**
 * Weather, which is the first thing in this project that is not on the player's side.
 *
 * PHASE 14 IS ABOUT OPPOSITION, and the gap it opens on is not a missing simulation — it is
 * that nothing has ever pushed back. Every phase so far added a capability: ground that
 * remembers, air that carries, fire that spreads, verbs that command, a body that performs.
 * A player can build a wall and it stands there for as long as the tab is open. There is no
 * reason to build one thing rather than another, and no reason to hurry.
 *
 * WHAT THIS IS NOT: a new simulation. Wind already lifts material off the ground, carries it
 * and puts it down again — that whole loop has been measured since Phase 5, and the elements
 * already differ in how susceptible they are to it. Sand migrates and snow packs. So weather
 * here is a DRIVER over machinery that already exists, and the whole of it is a schedule:
 * when is it calm, when does it blow, and how hard. Building the erosion again inside a file
 * called weather.ts would be a second physics next to the real one, which is the mistake
 * groundProbe.ts documents at length.
 *
 * IT WRITES world.windStrength RATHER THAN HOLDING ITS OWN NUMBER, which is the same
 * contract the camera's wheel zoom keeps with cam.armLength: one source of truth, so the
 * overlay cannot drift out of sync with what the air is actually doing, and a player who
 * drags the slider during a lull sees the storm take it back.
 */

/**
 * Written back only when it moves by this much.
 *
 * settings.set() early-returns on an unchanged value, but a continuously varying float
 * changes every frame — which would emit to every listener and reschedule the debounced save
 * sixty times a second forever. A hundredth of the slider's range is far below anything the
 * air can be seen responding to and turns a per-frame write into a few dozen per cycle.
 */
const WRITE_QUANTUM = 0.01;

export type Sky = "calm" | "gathering" | "storm" | "easing";

export class Weather {
    /** Seconds into the current cycle. */
    clock = 0;
    /** 0 in the calm, 1 at the height of the storm. */
    intensity = 0;
    /** What the sky is doing, for the overlay and for a probe to assert against. */
    sky: Sky = "calm";
    /** Storms since boot. */
    storms = 0;

    private readonly _settings: Settings;
    private _wasStorm = false;
    private _written = -1;

    /** Told when a storm arrives, so the caller can say so. The goal layer is not involved. */
    onStorm: (() => void) | null = null;

    constructor(settings: Settings) {
        this._settings = settings;
    }

    /**
     * One frame of weather. Allocates nothing (Rule 1).
     *
     * THE CYCLE HAS A REAL CALM IN IT, which matters more than the shape of the storm. A
     * world that is always eroding is not opposition, it is a tax: everything decays at some
     * rate and the player's only strategy is to build faster. A world that is quiet and then
     * is not gives the build a DEADLINE, which is the thing that makes one plan better than
     * another — pack it before the wind comes, or put it in the lee of something, or accept
     * that this one is not going to survive.
     */
    update(dt: number): void {
        const s = this._settings.v;
        if (!(s["sys.weather"] as boolean)) {
            this.intensity = 0;
            this.sky = "calm";
            return;
        }

        const period = Math.max(s["weather.period"] as number, 1);
        this.clock = (this.clock + Math.max(dt, 0)) % period;

        // A RAISED COSINE OVER THE STORM WINDOW, and flat calm outside it. The alternative —
        // a sine over the whole period — is never actually quiet, which is the one property
        // the cycle exists to have.
        const t = this.clock / period;
        const half = Math.max((s["weather.stormFraction"] as number) * 0.5, 1e-3);
        const d = Math.abs(t - 0.5) / half;
        this.intensity = d >= 1 ? 0 : 0.5 * (1 + Math.cos(Math.PI * d));

        const rising = t < 0.5;
        this.sky = this.intensity <= 0.02 ? "calm" : this.intensity > 0.75 ? "storm" : rising ? "gathering" : "easing";

        const isStorm = this.sky === "storm";
        if (isStorm && !this._wasStorm) {
            this.storms++;
            this.onStorm?.();
        }
        this._wasStorm = isStorm;

        const calm = s["weather.calmWind"] as number;
        const peak = s["weather.stormWind"] as number;
        const want = calm + (peak - calm) * this.intensity;
        if (this._written < 0 || Math.abs(want - this._written) >= WRITE_QUANTUM || (this.intensity === 0 && this._written !== calm)) {
            this._written = want;
            this._settings.set("world.windStrength", want);
        }
    }
}
