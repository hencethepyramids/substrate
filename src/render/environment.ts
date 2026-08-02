import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";
import type { Settings } from "../core/settings";
import type { ElementDef } from "../elements/types";

/**
 * Sun, ambient and sky, in one place so every material is lit by the same numbers.
 *
 * PHASE 1 STAND-IN. Phase 2 replaces the internals with Nishita single-scattering,
 * a multiple-scattering approximation and an iteratively-solved ground bounce baked
 * to an equirectangular LUT with SH irradiance. The *interface* is meant to survive
 * that: consumers already read a sun direction, a sun colour, an ambient term and a
 * linear sky colour, and none of them will need to change.
 *
 * Allocation-free after construction.
 */
const DEG2RAD = Math.PI / 180;

export class Environment {
    /** Direction toward the sun. */
    readonly sunDir = new Vector3(0, 1, 0);
    readonly sunColor = new Color3(1, 1, 1);
    /** Bounce + emission. Volcanic gets most of its ambient from the second term. */
    readonly ambient = new Color3(0, 0, 0);
    /** Linear sky colour. Fog mixes toward this, and the engine clears to its encoded form. */
    readonly skyLinear = new Color3(0, 0, 0);

    fogDensity = 0;
    /** 0..1, how far above the horizon the sun is in lighting terms. */
    horizonFade = 0;

    update(settings: Settings, element: ElementDef, scene: Scene): void {
        const s = settings.v;

        const elevation = s["world.sunElevation"] * DEG2RAD;
        const azimuth = s["world.sunAzimuth"] * DEG2RAD;
        const cosE = Math.cos(elevation);
        this.sunDir.set(cosE * Math.sin(azimuth), Math.sin(elevation), cosE * Math.cos(azimuth));

        // Direct sun dims and warms as it drops. Gains stay conservative because there
        // is no tonemapper yet: snow's albedo is ~0.9, so anything near 2.0 clips the
        // whole surface to flat white. Phase 9 earns the right to push light harder.
        const fade = Math.max(0, Math.min(1, (s["world.sunElevation"] + 4) / 14));
        this.horizonFade = fade;
        const intensity = 0.15 + 1.05 * fade * fade;
        const tint = element.sunTint;
        this.sunColor.set(tint[0] * intensity, tint[1] * intensity, tint[2] * intensity);

        const atm = element.atmosphere;
        const bounce = atm.groundBounce * (0.05 + 0.2 * fade);
        this.ambient.set(
            atm.groundAlbedo[0] * bounce + atm.emissiveAmbient[0],
            atm.groundAlbedo[1] * bounce + atm.emissiveAmbient[1],
            atm.groundAlbedo[2] * bounce + atm.emissiveAmbient[2],
        );

        // Turbidity washes the zenith toward the sun's colour; emission lifts the floor.
        const clarity = 1 / (1 + atm.turbidity * 0.22);
        const brightness = 0.1 + 0.9 * fade;
        const wash = 1 - clarity;
        this.skyLinear.set(
            (0.1 * atm.rayleighScale * clarity + tint[0] * 0.55 * wash) * brightness + atm.emissiveAmbient[0],
            (0.19 * atm.rayleighScale * clarity + tint[1] * 0.55 * wash) * brightness + atm.emissiveAmbient[1],
            (0.38 * atm.rayleighScale * clarity + tint[2] * 0.55 * wash) * brightness + atm.emissiveAmbient[2],
        );

        // The real densities are tuned for the Phase 2 far-range raymarch, which puts
        // terrain at the horizon. Until then the clipmap simply stops at 870 m, so fog
        // has to work harder to hide the edge.
        this.fogDensity = atm.hazeDensity * 5;

        // Materials mix toward the LINEAR sky and then apply the transfer, so the clear
        // colour has to be encoded the same way or the horizon shows a hard seam.
        const e = Math.pow(2, s["render.exposure"]);
        scene.clearColor.set(encode(this.skyLinear.r * e), encode(this.skyLinear.g * e), encode(this.skyLinear.b * e), 1);
    }
}

/** The transfer every Phase 1 material applies. Phase 9 replaces it with AgX. */
function encode(linear: number): number {
    return Math.pow(Math.max(0, linear), 1 / 2.2);
}
