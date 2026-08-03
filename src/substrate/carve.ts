import type { Settings } from "../core/settings";
import type { Input } from "../core/input";
import type { Mover } from "../core/mover";
import type { Substrate } from "./substrate";

/**
 * What writes into the substrate buffer: footfalls and the carve button.
 *
 * The relaxation pass decides what the ground DOES with a disturbance. This decides
 * where disturbances come from, and it is deliberately the thin half — every element
 * difference lives on the other side of `substrate.stamp()`. A print in snow and a
 * print in sand are the same call with the same numbers; what happens next is not.
 *
 * Nothing here allocates.
 */

/** Footfalls chased in one frame. A hitch should drop prints, not spend a frame laying them. */
const MAX_FOOTFALLS_PER_FRAME = 4;

export class Carve {
    private readonly _settings: Settings;
    /** Ground distance at which the last print was laid, metres. */
    private _lastFoot = 0;
    /** Which foot is next. Flipped on every print. */
    private _side = 1;

    constructor(settings: Settings) {
        this._settings = settings;
    }

    /**
     * Emit this frame's stamps. Runs after the mover and before `substrate.update()`,
     * which is the step that consumes them.
     *
     * @param dt simulation seconds, already scaled and zeroed by the pause.
     */
    update(input: Input, mover: Mover, substrate: Substrate, dt: number): void {
        const s = this._settings.v;
        if (!s["sys.substrate"]) return;

        // FOOTFALLS ARE PHASED ON GROUND TRAVELLED, NOT ON TIME. Stride length is then a
        // distance the player can measure by walking past their own prints, and it holds
        // at any speed and through any frame rate. It is also the exact contract Phase 7
        // states its gait machine will use — "stride phase from distance travelled" — so
        // the prints will not move underfoot when the real legs arrive.
        const stride = Math.max(s["char.strideLength"], 0.05);
        if (mover.distance < this._lastFoot) this._lastFoot = mover.distance; // teleport
        let chased = 0;
        while (mover.distance - this._lastFoot >= stride && chased < MAX_FOOTFALLS_PER_FRAME) {
            this._lastFoot += stride;
            this._side = -this._side;
            chased++;

            // facing is atan2(vx, vz), so forward is (sin, cos) and right is (cos, -sin).
            const half = s["char.stanceWidth"] * 0.5 * this._side;
            const x = mover.position.x + Math.cos(mover.facing) * half;
            const z = mover.position.z - Math.sin(mover.facing) * half;

            // A run presses harder than a walk. Capped, because sprinting is 2.4x walking
            // and a print two and a half times as deep reads as a crater.
            const load = 1 + Math.min(mover.speed / Math.max(s["char.walkSpeed"], 0.1), 3) * 0.4;
            substrate.stamp(x, z, s["char.footRadius"], s["char.footDepth"] * load);
        }
        // Skipped prints are gone, not owed. Otherwise a hitch pays itself back as a
        // burst of stamps all landing in the same footstep.
        if (mover.distance - this._lastFoot >= stride) this._lastFoot = mover.distance;

        // The carve button, held. Depth is a RATE, so holding twice as long digs twice as
        // deep and the frame rate does not decide how fast the ground gives way.
        if (input.carve && dt > 0) {
            substrate.stamp(mover.position.x, mover.position.z, s["substrate.carveRadius"], s["substrate.carveRate"] * dt);
        }
    }

    /** Re-phase the gait. Called on a teleport, so a jump does not lay a print. */
    resync(mover: Mover): void {
        this._lastFoot = mover.distance;
    }
}
