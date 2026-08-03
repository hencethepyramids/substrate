import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import noise from "./noise.wgsl?raw";
import heightfield from "./heightfield.wgsl?raw";
import pack from "./pack.wgsl?raw";
import terrainField from "./terrainField.wgsl?raw";
import terrainParams from "./terrainParams.wgsl?raw";
import clipmap from "./clipmap.wgsl?raw";
import shadow from "./shadow.wgsl?raw";
import farField from "./farField.wgsl?raw";
import atmosphere from "./atmosphere.wgsl?raw";
import sh from "./sh.wgsl?raw";
import skyMap from "./skyMap.wgsl?raw";
import skyLutTex from "./skyLutTex.wgsl?raw";
import skyData from "./skyData.wgsl?raw";
import substrateParams from "./substrateParams.wgsl?raw";
import substrateBuffer from "./substrateBuffer.wgsl?raw";
import brdf from "./brdf.wgsl?raw";

/**
 * Registers the shared WGSL includes.
 *
 * Rule 4: shared logic lives in one include, never two copies. Everything in lib/
 * is textually included by whatever needs it, so the beauty pass and the shadow
 * cascades are compiled from the same source lines rather than from two files that
 * drift apart over a few phases.
 *
 * The sky splits into four rather than one for a mechanical reason: an include that
 * declares a texture obliges every shader including it to bind that texture. The
 * LUT bake needs the direction mapping but must not declare the LUT it is writing,
 * and the SH bake needs the LUT but not the data texture it is producing. Splitting
 * the declarations from the maths is what keeps each pass binding only what it uses.
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
    store["substrateTerrainParams"] = terrainParams;
    store["substrateClipmap"] = clipmap;
    store["substrateShadow"] = shadow;
    store["substrateFarField"] = farField;
    store["substrateAtmosphere"] = atmosphere;
    store["substrateSh"] = sh;
    store["substrateSkyMap"] = skyMap;
    store["substrateSkyLut"] = skyLutTex;
    store["substrateSkyData"] = skyData;
    // Same split, same reason: substrateParams is numbers, substrateBuffer declares the
    // texture. The relaxation pass writes that texture and must not bind it.
    store["substrateParams"] = substrateParams;
    store["substrateBuffer"] = substrateBuffer;
    // Declares nothing, binds nothing — pure maths, so anything that shades can include
    // it. Phase 7's character takes the same lines the terrain does.
    store["substrateBrdf"] = brdf;
}
