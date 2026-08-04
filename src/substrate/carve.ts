import type { Settings } from "../core/settings";
import type { Input } from "../core/input";
import type { Mover } from "../core/mover";
import type { Gait } from "../character/gait";
import type { Substrate } from "./substrate";

/**
 * What writes into the substrate buffer: footfalls and the carve button.
 *
 * The relaxation pass decides what the ground DOES with a disturbance. This decides
 * where disturbances come from, and it is deliberately the thin half — every element
 * difference lives on the other side of `substrate.stamp()`. A print in snow and a
 * print in sand are the same call with the same numbers; what happens next is not.
 *
 * FOOTFALLS ARE NOT COMPUTED HERE ANY MORE. Through Phases 3 to 6 this file carried its
 * own copy of the stride phase, because there were no legs to ask. There are now, and
 * two copies of "which foot, and where" is exactly how prints end up drifting out from
 * under the feet that made them. The gait owns the contact; this reads it. The numbers
 * that stayed are the ones about the GROUND — how wide a foot is and how hard it presses
 * — rather than about the walk.
 *
 * Nothing here allocates.
 */
export class Carve {
    private readonly _settings: Settings;

    constructor(settings: Settings) {
        this._settings = settings;
    }

    /**
     * Emit this frame's stamps. Runs after the gait, which decides where the feet
     * landed, and before `substrate.update()`, which is the step that consumes them.
     *
     * @param dt simulation seconds, already scaled and zeroed by the pause.
     */
    update(input: Input, mover: Mover, gait: Gait, substrate: Substrate, dt: number): void {
        const s = this._settings.v;
        if (!s["sys.substrate"]) return;

        for (let i = 0; i < gait.plantCount; i++) {
            const plant = gait.plants[i];
            substrate.stamp(plant.x, plant.z, s["char.footRadius"], s["char.footDepth"] * plant.load);
        }

        // The carve button, held. Depth is a RATE, so holding twice as long digs twice as
        // deep and the frame rate does not decide how fast the ground gives way.
        if (input.carve && dt > 0) {
            substrate.stamp(mover.position.x, mover.position.z, s["substrate.carveRadius"], s["substrate.carveRate"] * dt);
        }
    }
}
