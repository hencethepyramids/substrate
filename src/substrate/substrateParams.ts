import type { ElementDef } from "../elements/types";

/**
 * The substrate parameter block, pushed to a shader.
 *
 * The names match shaders/lib/substrateParams.wgsl one for one, and this is the only
 * place that writes them — the same arrangement terrainParams.ts has, for the same
 * reason. Phases 5 and 6 add consumers of this block, and if any of them were fed a
 * different cohesion than the relaxation pass, snow would hold a wall while the wind
 * treated it as sand.
 *
 * windSusceptibility and liftThreshold are deliberately not here: nothing consumes them
 * yet, and a uniform nothing reads still costs a UBO slot. Phase 5 adds them alongside
 * the code that reads them.
 */
export const SUBSTRATE_PARAM_UNIFORMS = ["spCohesion", "spReposeDeg", "spSlumpAnisotropy", "spDiffusionRate", "spDecayHalfLife", "spThermalCoupling"] as const;

/** Anything with the setter shape — a ShaderMaterial or a ProceduralTexture. */
export interface SubstrateParamTarget {
    setFloat(name: string, value: number): unknown;
}

/** Allocation-free. */
export function pushSubstrateParams(target: SubstrateParamTarget, element: ElementDef): void {
    const p = element.substrate;
    target.setFloat("spCohesion", p.cohesion);
    target.setFloat("spReposeDeg", p.angleOfRepose);
    target.setFloat("spSlumpAnisotropy", p.slumpAnisotropy);
    target.setFloat("spDiffusionRate", p.diffusionRate);
    target.setFloat("spDecayHalfLife", p.decayHalfLife);
    target.setFloat("spThermalCoupling", p.thermalCoupling);
}
