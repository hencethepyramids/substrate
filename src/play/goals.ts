import type { Settings } from "../core/settings";

/** Ground height, for measuring what is actually standing there. */
export interface Heights {
    groundAt(x: number, z: number): number;
}

/**
 * The game layer — rules laid over a world that does not need them.
 *
 * PHASE 11 STARTS WHERE PHASE 10 LEFT OFF, AND OWES IT NOTHING BACK. The simulations do not
 * know about goals and must not: snow settles at its angle of repose whether or not anyone
 * wanted a mound there, and a fire burns the same in a scored session as in an idle one.
 * That separation is the whole reason this is a layer rather than a set of hooks scattered
 * through the substrate. Everything here READS the world's own events and adds meaning; if
 * this file were deleted the world would carry on identically, which is the test of whether
 * a game layer is sitting on top of a simulation or tangled into it.
 *
 * WHAT IT WATCHES. Phase 10's verbs already move a conserved quantity to known places — a
 * deposit knows its position and its volume, whether it arrived from a hand or off the end
 * of a throw. That is enough to score a construction without reading a single texel back
 * from the GPU, which matters more than it sounds: a readback is a stall, and a game layer
 * that stalls the frame to find out how it is doing would be paying for its own scoreboard
 * in frame time.
 *
 * THE FIRST GOAL IS A MOUND, and it is scored by HOW TALL IT IS rather than by how much
 * was tipped into it. Pass A did the latter and said so, on the reasoning that measuring
 * what survives meant reading the substrate buffer back and paying a stall for it. That was
 * wrong, and pleasantly so: gait.groundAt() already returns the deformed surface — it is
 * what the character's feet stand on, it is what measured a dug hole at 26 cm, and it is
 * already called every frame. The height of the pile was free the whole time.
 *
 * WHICH MAKES THE SIMULATION THE GAME. Snow slumps at its angle of repose, so a mound
 * fights back: tip material faster than it settles and the pile grows, stop and it spreads.
 * Delivered volume is still counted, but only as a statistic, and the gap between it and
 * the height is the interesting number — it is how much of the work the ground took back.
 * A goal scored on delivery could be finished by shovelling into a hole. This one cannot.
 */

/** How far from the site a deposit still counts as part of it, in metres. */
const SITE_RADIUS = 2.5;

export class Goals {
    /** Where the current construction is centred, once anything has been deposited. */
    readonly site = { x: 0, z: 0 };
    /** Whether a site exists yet. The first deposit places it. */
    started = false;
    /** Volume delivered to the site, in cubic metres. */
    delivered = 0;
    /** Volume that missed — deposited, but not near the site. Worth seeing. */
    strayed = 0;
    /** Ground height at the site when it was founded, in metres. The datum. */
    baseHeight = 0;
    /** How far the ground at the site now stands above that datum. */
    height = 0;
    /** The tallest it has ever been, which is what the goal is scored against. */
    peakHeight = 0;
    /** True once `delivered` reaches the target. Latches; a mound is not un-built. */
    complete = false;

    /**
     * Told when something worth saying happens, rather than saying it.
     *
     * THE GOAL LAYER DOES NOT KNOW WHAT AN OVERLAY IS, and that is the same separation this
     * file claims from the simulations one level down. It knows a site was founded and a
     * mound was finished; whether that becomes a toast, a sound, or nothing at all is the
     * caller's business. A rule that reached into the UI would be as tangled as a rule that
     * reached into the substrate, just in the other direction.
     *
     * Fired once each. `complete` latches, so a mound is not un-built by the next deposit
     * and the message does not repeat every frame the player keeps shovelling.
     */
    onFounded: ((x: number, z: number) => void) | null = null;
    onComplete: ((litres: number) => void) | null = null;

    private readonly _settings: Settings;
    private readonly _heights: Heights;

    constructor(settings: Settings, heights: Heights) {
        this._settings = settings;
        this._heights = heights;
    }

    /**
     * Measure the pile. Called once a frame; allocates nothing.
     *
     * SCORED ON THE PEAK, NOT THE CURRENT HEIGHT, and that is a deliberate kindness rather
     * than an oversight. Snow keeps creeping for several seconds after the last shovelful,
     * so a mound scored on its instantaneous height would be finished and then unfinished
     * again while the player stood watching it. The peak latches what was actually built;
     * `height` is still reported alongside it, so the settling is visible rather than
     * hidden — which is the part worth watching.
     */
    update(): void {
        if (!this.started || !(this._settings.v["sys.goals"] as boolean)) return;
        this.height = this._heights.groundAt(this.site.x, this.site.z) - this.baseHeight;
        if (this.height > this.peakHeight) this.peakHeight = this.height;
        if (!this.complete && this.progress >= 1) {
            this.complete = true;
            this.onComplete?.(this.peakHeight);
        }
    }

    /** Metres from a point to the current site, or -1 if there is no site yet. */
    distanceFrom(x: number, z: number): number {
        if (!this.started) return -1;
        return Math.hypot(x - this.site.x, z - this.site.z);
    }

    /** How far a deposit may land from the site and still count. */
    get siteRadius(): number {
        return SITE_RADIUS;
    }

    /** Fraction of the target height reached, clamped to 1. */
    get progress(): number {
        const target = this._settings.v["goal.moundHeight"] as number;
        return target > 0 ? Math.min(this.peakHeight / target, 1) : 0;
    }

    /**
     * How far the pile has settled from its own high-water mark, in metres.
     *
     * A MEASUREMENT, NOT A MODEL. An earlier version of this compared the peak against what
     * the delivered volume "should" have stood as, using a made-up spread area — and it
     * duly reported 0% settling for a site that had collapsed into a hole, because the
     * invented denominator happened to come out smaller than the peak. A number that reads
     * healthy while the thing it describes has failed is worse than no number, so it is
     * gone. This subtracts two heights that were both actually measured, and cannot say
     * anything that is not true of the ground.
     */
    get settled(): number {
        return Math.max(0, this.peakHeight - this.height);
    }

    /**
     * A deposit happened. Called by the verb layer for BOTH a placed load and a thrown one
     * landing, because to a mound they are the same event — which is the point of routing
     * both through one scoop() in the first place.
     *
     * The FIRST deposit places the site rather than the site being chosen in advance. There
     * is no map, no marker and nobody to have put one there; a construction in this world
     * starts wherever someone starts building, and the rule follows the fiction rather than
     * the fiction being bent to fit a rule.
     */
    deposit(x: number, z: number, volume: number): void {
        if (!(this._settings.v["sys.goals"] as boolean)) return;

        if (!this.started) {
            this.started = true;
            this.site.x = x;
            this.site.z = z;
            // The datum, taken BEFORE this deposit has had a chance to settle into the
            // buffer. Taken after, the first shovelful would measure as zero height and
            // every mound would read one load short.
            this.baseHeight = this._heights.groundAt(x, z);
            this.onFounded?.(x, z);
        }

        const dx = x - this.site.x;
        const dz = z - this.site.z;
        if (dx * dx + dz * dz > SITE_RADIUS * SITE_RADIUS) {
            this.strayed += volume;
            return;
        }

        this.delivered += volume;
    }

    /** Start again. The overlay hangs a button off this. */
    reset(): void {
        this.started = false;
        this.delivered = 0;
        this.strayed = 0;
        this.complete = false;
        this.baseHeight = 0;
        this.height = 0;
        this.peakHeight = 0;
    }
}
