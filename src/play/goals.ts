import type { Settings } from "../core/settings";

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
 * THE FIRST GOAL IS A MOUND, because it is the one thing this world's verbs are already
 * good at and because it is honest about the trade. Volume deposited near a point is not
 * the same as volume STILL near that point — snow slumps, and a tall pile becomes a wide
 * one within a few relaxation steps. So this counts what was delivered rather than what
 * survives, and says so. Scoring what survives needs the buffer read back, which is a
 * later problem with a real cost attached.
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

    constructor(settings: Settings) {
        this._settings = settings;
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

    /** Fraction of the target delivered, clamped to 1. */
    get progress(): number {
        const target = (this._settings.v["goal.moundLitres"] as number) / 1000;
        return target > 0 ? Math.min(this.delivered / target, 1) : 0;
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
            this.onFounded?.(x, z);
        }

        const dx = x - this.site.x;
        const dz = z - this.site.z;
        if (dx * dx + dz * dz > SITE_RADIUS * SITE_RADIUS) {
            this.strayed += volume;
            return;
        }

        this.delivered += volume;
        if (!this.complete && this.progress >= 1) {
            this.complete = true;
            this.onComplete?.(this.delivered * 1000);
        }
    }

    /** Start again. The overlay hangs a button off this. */
    reset(): void {
        this.started = false;
        this.delivered = 0;
        this.strayed = 0;
        this.complete = false;
    }
}
