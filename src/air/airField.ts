import { Vector2, Vector4 } from "@babylonjs/core/Maths/math.vector";
import type { Settings } from "../core/settings";

/**
 * The air velocity field.
 *
 * There is no buffer here on purpose. Wind over a heightfield is a pure function of the
 * heightfield and the free-stream wind, so a texture would be a second copy of something
 * already known, kept in sync by hand, at a resolution someone would have to justify.
 * The whole field is `sbAirAt` in shaders/lib/air.wgsl; this class is only the parameter
 * block and the clock.
 *
 * Phase 5's second pass adds the airborne MATERIAL, which does carry history and does
 * need a buffer.
 *
 * Allocation-free after construction.
 */

export const AIR_UNIFORMS = ["swBase", "swParams", "swTime"] as const;

/** Anything with the setter shape — a ShaderMaterial or a ProceduralTexture. */
export interface AirParamTarget {
    setFloat(name: string, value: number): unknown;
    setVector2(name: string, value: Vector2): unknown;
    setVector4(name: string, value: Vector4): unknown;
}

const DEG2RAD = Math.PI / 180;

export class AirField {
    /** Free-stream velocity in m/s. The one CPU-side number other systems may want. */
    readonly base = new Vector2(0, 0);
    /** Seconds of simulated wind. Gusts advect on this, so pausing freezes them. */
    time = 0;

    private readonly _settings: Settings;
    private readonly _params = new Vector4(0, 0, 0, 0);

    constructor(settings: Settings) {
        this._settings = settings;
    }

    /** @param dt simulation seconds, already scaled and zeroed by the pause. */
    update(dt: number): void {
        const s = this._settings.v;
        this.time += dt;

        // Bearing is the direction the wind comes FROM, as every weather report quotes
        // it, so the velocity points the opposite way.
        const bearing = s["world.windBearing"] * DEG2RAD;
        const speed = s["sys.air"] ? s["world.windStrength"] * s["air.maxSpeed"] : 0;
        this.base.set(-Math.sin(bearing) * speed, -Math.cos(bearing) * speed);
    }

    /** Push the parameter block. Once per frame, per material. */
    pushTo(target: AirParamTarget): void {
        const s = this._settings.v;
        target.setVector2("swBase", this.base);
        this._params.set(s["air.speedup"], s["air.separation"], s["air.gustScale"], s["air.gustAmount"]);
        target.setVector4("swParams", this._params);
        target.setFloat("swTime", this.time);
    }
}
