import type { ElementDef } from "../elements/types";

/**
 * The fire parameter block, pushed to a shader.
 *
 * Names match shaders/lib/fireParams.wgsl one for one, and this is the only place that
 * writes them — the same arrangement terrainParams.ts and substrateParams.ts have, for
 * the same reason. The heat pass and the relaxation pass both read these, and if either
 * were fed a different ignition point the ground would soften at a temperature it never
 * reached.
 */
export const FIRE_PARAM_UNIFORMS = ["fpIgnition", "fpConductivity", "fpCooling", "fpLatent", "fpPhaseLag"] as const;

export interface FireParamTarget {
    setFloat(name: string, value: number): unknown;
}

/** Allocation-free. */
export function pushFireParams(target: FireParamTarget, element: ElementDef): void {
    const f = element.fire;
    target.setFloat("fpIgnition", f.ignition);
    target.setFloat("fpConductivity", f.conductivity);
    target.setFloat("fpCooling", f.cooling);
    target.setFloat("fpLatent", f.latent);
    target.setFloat("fpPhaseLag", f.phaseLag);
}
