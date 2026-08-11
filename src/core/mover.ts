import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Input } from "./input";
import type { CameraRig } from "./cameraRig";
import type { Settings } from "./settings";

/**
 * Locomotion. Owns a feet position, a facing and a distance travelled, and nothing else —
 * the contract Phase 7's gait consumes rather than replaces.
 *
 * PHASE 8 GAVE THE GROUND A SAY. Until now a 40 degree dune cost exactly as much to climb
 * as flat ground did, which is the sort of thing you stop noticing and should not. The
 * slope term is not a curve someone drew: it is the tangential component of gravity,
 * projected back into the horizontal plane the mover works in. For a surface with
 * gradient g, tan(theta) = |g|, so sin(theta)cos(theta) = |g| / (1 + |g|^2) — which is
 * exact, costs one divide, and correctly goes to zero on the flat AND on a cliff, because
 * you cannot be pushed along a wall you are not standing on.
 *
 * Sliding is the same equation with the friction turned down. That is the whole feature:
 * a walk is gravity plus a lot of grip, a slide is gravity plus very little, and what
 * makes a slide read is that the player stops choosing the speed and the hill starts.
 */

/** Whatever knows where the drawn ground is. The gait supplies it, so the mover and the
 * feet cannot disagree about which surface they are on. */
export interface Surface {
    groundAt(x: number, z: number): number;
}

/** Gravity. */
const G = 9.81;

/**
 * How far apart the slope is measured, in metres.
 *
 * Over a stride rather than at a point: the substrate window is 6 cm texels and its
 * bilinear surface has derivative jumps at every one of them, so a point derivative would
 * have the character shoved about by the texel it happened to be standing on. A body
 * responds to the hill, not to the grain.
 */
const SLOPE_SPAN = 0.6;
export class Mover {
    /** Feet position. The camera rig orbits this, offset by cam.height. */
    readonly position = new Vector3(0, 0, 0);
    readonly velocity = new Vector3(0, 0, 0);
    /** Yaw in radians. Phase 7's gait phase will advance from ground travelled, not from this. */
    facing = 0;
    /** Horizontal speed, m/s. Read by the wake and spray systems in Phase 8. */
    speed = 0;
    /** Distance travelled since boot, m. Phase 7 drives stride phase from exactly this. */
    distance = 0;
    /** True while the slide input is held. The gait poses differently for it. */
    sliding = false;
    /**
     * Off the ground, and the reason the mover now owns its own Y.
     *
     * Through Phase 8 the character was GLUED to the surface: main.ts set position.y from
     * the ground every frame and the mover was a purely horizontal solver. That is a fine
     * model for walking and it makes a leap impossible, because there is no state in which
     * the feet are somewhere the ground is not.
     */
    airborne = false;
    /** Vertical speed in m/s. Only meaningful while airborne. */
    velocityY = 0;
    /**
     * How hard the last landing was, in m/s downward, and zero once someone has read it.
     *
     * A one-shot rather than a flag, because what reads it wants the MAGNITUDE — the
     * crater a landing punches should be a landing-sized crater, and a drop off a ridge is
     * not the same event as stepping off a kerb.
     */
    landedAt = 0;

    private readonly _settings: Settings;

    constructor(settings: Settings) {
        this._settings = settings;
    }

    update(input: Input, rig: CameraRig, surface: Surface, dt: number): void {
        if (dt <= 0) return;
        const s = this._settings.v;

        // Take off before anything else this frame, so the leap starts with the run-up's
        // full horizontal speed rather than with whatever the ground steering leaves after
        // a frame of drag. A jump that quietly costs you a metre of run-up feels wrong in a
        // way players describe as "floaty" without being able to say why.
        if (input.jump && !this.airborne) {
            this.airborne = true;
            this.velocityY = s["char.jumpSpeed"] as number;
        }

        // The hill under the feet, measured on the surface that is actually drawn — so a
        // wake carved into a slope changes how the slope pushes back.
        const x = this.position.x;
        const z = this.position.z;
        const gx = (surface.groundAt(x + SLOPE_SPAN, z) - surface.groundAt(x - SLOPE_SPAN, z)) / (2 * SLOPE_SPAN);
        const gz = (surface.groundAt(x, z + SLOPE_SPAN) - surface.groundAt(x, z - SLOPE_SPAN)) / (2 * SLOPE_SPAN);
        const grade = gx * gx + gz * gz;
        const pull = G / (1 + grade);
        const slopeX = -gx * pull;
        const slopeZ = -gz * pull;

        const wantX = rig.right.x * input.move.x + rig.forward.x * input.move.y;
        const wantZ = rig.right.z * input.move.x + rig.forward.z * input.move.y;

        this.sliding = input.slide && !this.airborne;
        if (this.airborne) {
            // AIR CONTROL, DELIBERATELY POOR. A body in flight has nothing to push against;
            // the only honest steering is what the limbs can do against their own inertia,
            // which is very little. Keeping a fraction rather than zero is the concession —
            // no control at all reads as a bug to anyone who has played anything else.
            const air = (s["char.airControl"] as number) * (s["char.acceleration"] as number);
            const target = s["char.walkSpeed"] * (input.sprint ? s["char.sprintMultiplier"] : 1);
            const k = 1 - Math.exp(-air * dt);
            this.velocity.x += (wantX * target - this.velocity.x) * k;
            this.velocity.z += (wantZ * target - this.velocity.z) * k;
        } else if (this.sliding) {
            // NO TARGET SPEED. The hill decides, the player only steers — which is the
            // entire difference between running down a dune and riding one.
            //
            // AND STEERING ACTS ACROSS THE TRACK, NOT ALONG IT. Applying the stick as a
            // straight acceleration made sliding a speed boost you could use on the flat:
            // steering authority of 7 m/s^2 against 0.55/s of drag settles at 12.7 m/s
            // with no hill involved at all, which is faster than sprinting and turns the
            // whole mechanic into a run button. Keeping only the component perpendicular
            // to travel means the player chooses the LINE and gravity chooses the speed.
            let pushX = wantX;
            let pushZ = wantZ;
            const sp = Math.hypot(this.velocity.x, this.velocity.z);
            if (sp > 0.6) {
                const fx = this.velocity.x / sp;
                const fz = this.velocity.z / sp;
                const along = wantX * fx + wantZ * fz;
                pushX = wantX - fx * along;
                pushZ = wantZ - fz * along;
            }
            this.velocity.x += (slopeX + pushX * s["char.slideSteer"]) * dt;
            this.velocity.z += (slopeZ + pushZ * s["char.slideSteer"]) * dt;
            const drag = Math.exp(-s["char.slideFriction"] * dt);
            this.velocity.x *= drag;
            this.velocity.z *= drag;
        } else {
            // Climbing costs speed and descending does not give it back in full, because
            // a walk is a body spending effort rather than coasting.
            const climb = wantX * gx + wantZ * gz;
            const target = s["char.walkSpeed"] * (input.sprint ? s["char.sprintMultiplier"] : 1) * Math.max(1 - Math.max(climb, 0) * s["char.slopeClimb"], 0.25);
            const desiredX = wantX * target;
            const desiredZ = wantZ * target;

            // Exponential approach to the desired velocity — no impulse, no overshoot.
            const k = 1 - Math.exp(-s["char.acceleration"] * dt);
            this.velocity.x += (desiredX - this.velocity.x) * k;
            this.velocity.z += (desiredZ - this.velocity.z) * k;
            // Gravity still has a say, just a smaller one — boots grip.
            this.velocity.x += slopeX * s["char.slopeWalk"] * dt;
            this.velocity.z += slopeZ * s["char.slopeWalk"] * dt;
        }

        this.position.x += this.velocity.x * dt;
        this.position.z += this.velocity.z * dt;

        // THE MOVER OWNS Y NOW. Ground-following used to happen in main.ts, which meant
        // there was no frame in which the feet could be above the surface. Doing it here
        // keeps the two cases in one place: airborne integrates, grounded snaps.
        const ground = surface.groundAt(this.position.x, this.position.z);
        if (this.airborne) {
            this.velocityY -= G * dt;
            this.position.y += this.velocityY * dt;
            // Landing is a CROSSING, like the thrown load's — at 8 m/s down a frame covers
            // 13 cm, and a proximity test would be stepped straight over.
            if (this.position.y <= ground && this.velocityY <= 0) {
                this.airborne = false;
                this.position.y = ground;
                this.landedAt = -this.velocityY;
                this.velocityY = 0;
            }
        } else {
            this.position.y = ground;
        }

        const stepX = this.velocity.x * dt;
        const stepZ = this.velocity.z * dt;
        const step = Math.sqrt(stepX * stepX + stepZ * stepZ);
        this.distance += step;
        this.speed = step / dt;

        // Face the direction of travel, rate-limited so a flick of the stick does not snap.
        if (this.speed > 0.05) {
            const targetYaw = Math.atan2(this.velocity.x, this.velocity.z);
            let delta = targetYaw - this.facing;
            while (delta > Math.PI) delta -= Math.PI * 2;
            while (delta < -Math.PI) delta += Math.PI * 2;
            const maxTurn = s["char.turnRate"] * (Math.PI / 180) * dt;
            this.facing += delta < -maxTurn ? -maxTurn : delta > maxTurn ? maxTurn : delta;
        }
    }

    teleport(x: number, z: number): void {
        this.position.set(x, 0, z);
        this.velocity.setAll(0);
        this.speed = 0;
    }
}
