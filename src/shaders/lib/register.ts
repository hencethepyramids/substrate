import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import noise from "./noise.wgsl?raw";
import heightfield from "./heightfield.wgsl?raw";
import pack from "./pack.wgsl?raw";
import terrainField from "./terrainField.wgsl?raw";

/**
 * Registers the shared WGSL includes.
 *
 * Rule 4: shared logic lives in one include, never two copies. Everything in lib/
 * is textually included by whatever needs it, so the beauty pass and the shadow
 * cascades are compiled from the same source lines rather than from two files that
 * drift apart over a few phases.
 */
let registered = false;

export function registerShaderIncludes(): void {
    if (registered) return;
    registered = true;
    const store = ShaderStore.IncludesShadersStoreWGSL;
    store["substrateNoise"] = noise;
    store["substrateHeightfield"] = heightfield;
    store["substratePack"] = pack;
    store["substrateTerrainField"] = terrainField;
}
