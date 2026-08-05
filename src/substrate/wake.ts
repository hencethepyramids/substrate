import type { Settings } from "../core/settings";
import type { Mover } from "../core/mover";
import type { Substrate } from "./substrate";

/**
 * The swept wake: the channel a body ploughs through loose material at speed.
 *
 * THE STAMP IS ALREADY VOLUME-NEUTRAL, so this needs no new physics. `substrate.stamp`
 * lays `(1 - u^2) * e^(-u^2)`, which is negative in the middle and positive around the
 * rim and integrates to nothing — it does not delete material, it MOVES it. Drag that
 * along a path and what comes out the other side is a trench with a berm either side of
 * it, because every stamp's rim lands on its neighbour's rim and the middles all dig.
 * The berms are not modelled; they are what conservation does when you push.
 *
 * EMITTED ON DISTANCE, NOT ON TIME — the same discipline as the footfalls, and for the
 * same reason. A wake laid per frame is a wake whose depth depends on the frame rate,
 * and one laid per second is a wake that bunches up when you slow down. Spacing is a
 * distance, so the channel is the same channel at 60 fps and at 240.
 *
 * What the ground then DOES with the trench is the element's business and was settled in
 * Phase 3: snow holds the walls, sand slumps them back to its angle of repose in a few
 * seconds, ash collapses once and then keeps the shape for ever.
 *
 * Nothing here allocates.
 */

/** Stamps chased in one frame. A hitch shortens the wake; it does not spend a frame laying it. */
const MAX_PER_FRAME = 8;

export class Wake {
    private readonly _settings: Settings;
    /** Ground distance at which the last stamp was laid. */
    private _lastAt = 0;
    /** Smoothed turn rate, rad/s, for the bias to the outside of a carve. */
    private _turn = 0;
    private _facingPrev = 0;
    private _seeded = false;

    constructor(settings: Settings) {
        this._settings = settings;
    }

    /** Re-phase onto wherever the character now is. A teleport does not drag a wake. */
    resync(mover: Mover): void {
        this._lastAt = mover.distance;
        this._facingPrev = mover.facing;
        this._turn = 0;
        this._seeded = true;
    }

    /** @param dt simulation seconds, already scaled and zeroed by the pause. */
    update(mover: Mover, substrate: Substrate, dt: number): void {
        const s = this._settings.v;
        if (!this._seeded) this.resync(mover);
        if (!s["sys.wake"] || !s["sys.substrate"]) {
            this._lastAt = mover.distance;
            return;
        }

        // Turn rate, for the bias. Wrapped, because facing crosses pi walking south.
        let turned = mover.facing - this._facingPrev;
        while (turned > Math.PI) turned -= Math.PI * 2;
        while (turned < -Math.PI) turned += Math.PI * 2;
        this._facingPrev = mover.facing;
        const rate = dt > 1e-5 ? turned / dt : 0;
        this._turn += (rate - this._turn) * (dt > 0 ? 1 - Math.exp(-10 * dt) : 0);

        // Below the threshold a body is walking over the ground, not through it.
        const from = s["wake.speedMin"];
        const span = Math.max(s["wake.speedFull"] - from, 0.1);
        const hard = clamp01((mover.speed - from) / span);
        if (hard <= 0) {
            this._lastAt = mover.distance;
            return;
        }

        const spacing = Math.max(s["wake.spacing"], 0.02);
        if (mover.distance < this._lastAt) this._lastAt = mover.distance; // teleport
        const radius = s["wake.width"] * (0.55 + 0.45 * hard);
        const depth = s["wake.depth"] * hard;

        // A CARVE LEANS ON ITS OUTSIDE EDGE. Turning hard at speed does not plough a
        // channel down the middle of the track — the load goes onto the outside of the
        // turn, which is where the wall of thrown material builds. tan(bank) = v*omega/g
        // is the same balance the gait leans the body by, so the wake and the figure over
        // it agree about which way the turn is being taken.
        const bank = clampAbs((mover.speed * this._turn) / 9.81, 0.6) * s["wake.bias"];
        // facing is atan2(vx, vz), so right is (cos, -sin).
        const offX = Math.cos(mover.facing) * bank * radius;
        const offZ = -Math.sin(mover.facing) * bank * radius;

        let laid = 0;
        while (mover.distance - this._lastAt >= spacing && laid < MAX_PER_FRAME) {
            this._lastAt += spacing;
            laid++;
            substrate.stamp(mover.position.x + offX, mover.position.z + offZ, radius, depth);
        }
        // Skipped stamps are gone, not owed — otherwise a hitch pays itself back as a
        // pile of overlapping carves all landing in the same metre of track.
        if (mover.distance - this._lastAt >= spacing) this._lastAt = mover.distance;
    }
}

function clamp01(v: number): number {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clampAbs(v: number, limit: number): number {
    return v < -limit ? -limit : v > limit ? limit : v;
}
