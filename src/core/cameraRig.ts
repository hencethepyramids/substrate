import { TargetCamera } from "@babylonjs/core/Cameras/targetCamera";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";
import type { Input } from "./input";
import type { Settings } from "./settings";

const DEG2RAD = Math.PI / 180;

/**
 * Spring-arm third-person rig.
 *
 * Yaw/pitch come from the mouse, arm length from the wheel. The wheel writes back
 * into `cam.armLength` rather than keeping its own number, so the slider and the
 * wheel can never disagree — settings stay the single source of truth.
 *
 * Allocation-free: every vector below is a member, and the frame path only mutates.
 */
export class CameraRig {
    readonly camera: TargetCamera;

    /** Yaw in radians. Movement input is resolved against this. */
    yaw = 0;
    /** Pitch in radians, positive looks down. */
    pitch = 0.28;

    /** Horizontal forward basis for movement, refreshed every update(). */
    readonly forward = new Vector3(0, 0, 1);
    /** Horizontal right basis for movement, refreshed every update(). */
    readonly right = new Vector3(1, 0, 0);

    /** Additive shake offset, written by gameplay (Phase 8), decayed here. */
    readonly shake = new Vector3(0, 0, 0);

    private readonly _settings: Settings;
    private readonly _pivot = new Vector3(0, 0, 0);
    private readonly _smoothPivot = new Vector3(0, 0, 0);
    private readonly _dir = new Vector3(0, 0, 1);
    private _armLength: number;
    private _initialised = false;

    constructor(scene: Scene, settings: Settings) {
        this._settings = settings;
        this._armLength = settings.get("cam.armLength");

        const camera = new TargetCamera("rig", new Vector3(0, 2, -6), scene);
        camera.minZ = 0.1;
        camera.maxZ = 4000;
        camera.fov = settings.get("render.fov") * DEG2RAD;
        camera.rotation.set(this.pitch, this.yaw, 0);
        scene.activeCamera = camera;
        this.camera = camera;

        settings.on("render.fov", (deg) => {
            camera.fov = deg * DEG2RAD;
        });
    }

    /**
     * @param target World-space point to orbit — normally the character's feet.
     * @param dt Seconds since the last frame.
     */
    update(input: Input, target: Vector3, dt: number): void {
        const s = this._settings.v;

        // -- look ------------------------------------------------------------
        if (input.pointerLocked) {
            const sens = s["cam.sensitivity"] * 0.0022;
            this.yaw += input.lookX * sens;
            this.pitch += input.lookY * sens * (s["cam.invertY"] ? -1 : 1);
        }
        const pitchMin = s["cam.pitchMin"] * DEG2RAD;
        const pitchMax = s["cam.pitchMax"] * DEG2RAD;
        this.pitch = this.pitch < pitchMin ? pitchMin : this.pitch > pitchMax ? pitchMax : this.pitch;
        // Keep yaw in range so it never loses float precision on a long session.
        if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
        else if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;

        // -- zoom ------------------------------------------------------------
        if (input.wheel !== 0) {
            const current = s["cam.armLength"];
            this._settings.set("cam.armLength", current * (1 + input.wheel * 0.0012));
        }

        // -- bases -----------------------------------------------------------
        const sinYaw = Math.sin(this.yaw);
        const cosYaw = Math.cos(this.yaw);
        this.forward.set(sinYaw, 0, cosYaw);
        this.right.set(cosYaw, 0, -sinYaw);

        // -- spring ----------------------------------------------------------
        this._pivot.set(target.x, target.y + s["cam.height"], target.z);
        if (!this._initialised) {
            this._smoothPivot.copyFrom(this._pivot);
            this._armLength = s["cam.armLength"];
            this._initialised = true;
        }

        // Frame-rate independent exponential smoothing: the same feel at 60 and 240 Hz.
        const k = expSmooth(s["cam.smoothing"], dt);
        this._smoothPivot.x += (this._pivot.x - this._smoothPivot.x) * k;
        this._smoothPivot.y += (this._pivot.y - this._smoothPivot.y) * k;
        this._smoothPivot.z += (this._pivot.z - this._smoothPivot.z) * k;
        this._armLength += (s["cam.armLength"] - this._armLength) * k;

        // -- placement -------------------------------------------------------
        const cosPitch = Math.cos(this.pitch);
        this._dir.set(sinYaw * cosPitch, -Math.sin(this.pitch), cosYaw * cosPitch);

        const camera = this.camera;
        camera.rotation.set(this.pitch, this.yaw, 0);
        camera.position.set(
            this._smoothPivot.x - this._dir.x * this._armLength + this.shake.x,
            this._smoothPivot.y - this._dir.y * this._armLength + this.shake.y,
            this._smoothPivot.z - this._dir.z * this._armLength + this.shake.z,
        );

        // Phase 1 replaces this floor with a heightfield sample.
        const floor = target.y + 0.25;
        if (camera.position.y < floor) camera.position.y = floor;

        // Shake is written by gameplay each frame and bled off here.
        this.shake.scaleInPlace(Math.pow(0.86, dt * 60));
    }

    /** Snap the rig to the target with no interpolation — used after a teleport or biome switch. */
    snap(): void {
        this._initialised = false;
    }
}

/**
 * Converts a 0..1 "smoothing" dial into a lerp factor that is independent of frame
 * rate. The dial is the fraction of remaining error retained per 60 Hz frame, so
 * 0 snaps instantly and 0.99 is very heavy — and 144 Hz feels the same as 60 Hz.
 */
function expSmooth(retainPerFrame: number, dt: number): number {
    if (retainPerFrame <= 0) return 1;
    if (retainPerFrame >= 1) return 0;
    return 1 - Math.pow(retainPerFrame, dt * 60);
}
