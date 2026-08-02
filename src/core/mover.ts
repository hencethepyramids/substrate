import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Input } from "./input";
import type { CameraRig } from "./cameraRig";
import type { Settings } from "./settings";

/**
 * PHASE 0 PLACEHOLDER LOCOMOTION — replaced by the Phase 7 solved gait machine.
 *
 * Kinematic, camera-relative, ground-plane only. Its one real job is to give the
 * spring arm something honest to follow, and to establish the contract the Phase 7
 * character will satisfy: it owns a feet position and a facing, nothing else.
 */
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

    private readonly _settings: Settings;

    constructor(settings: Settings) {
        this._settings = settings;
    }

    update(input: Input, rig: CameraRig, dt: number): void {
        if (dt <= 0) return;
        const s = this._settings.v;

        const target = s["char.walkSpeed"] * (input.sprint ? s["char.sprintMultiplier"] : 1);
        const desiredX = (rig.right.x * input.move.x + rig.forward.x * input.move.y) * target;
        const desiredZ = (rig.right.z * input.move.x + rig.forward.z * input.move.y) * target;

        // Exponential approach to the desired velocity — no impulse, no overshoot.
        const k = 1 - Math.exp(-s["char.acceleration"] * dt);
        this.velocity.x += (desiredX - this.velocity.x) * k;
        this.velocity.z += (desiredZ - this.velocity.z) * k;

        this.position.x += this.velocity.x * dt;
        this.position.z += this.velocity.z * dt;

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
