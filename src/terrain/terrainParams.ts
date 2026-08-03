import { Vector2 } from "@babylonjs/core/Maths/math.vector";
import type { Settings } from "../core/settings";
import type { ElementDef } from "../elements/types";

/**
 * The terrain parameter block, pushed to a shader.
 *
 * The names match shaders/lib/terrainParams.wgsl one for one, and this is the only
 * place that writes them. Three consumers now evaluate sbTerrainD — the heightfield
 * bake, the probe that checks the bake, and the sky's far-range raymarch — and if any
 * of them were fed a different seed or a different wind bearing, the world would
 * quietly fork at whichever boundary that consumer owns.
 */
export const TERRAIN_PARAM_UNIFORMS = [
    "bkOrigin",
    "bkExtent",
    "bkWind",
    "bkSeed",
    "bkSwellAmp",
    "bkSwellFreq",
    "bkDuneAmp",
    "bkDuneFreq",
    "bkDuneStretch",
    "bkDuneOctaves",
    "bkShearAmp",
    "bkShearFreq",
    "bkDetailAmp",
    "bkDetailFreq",
    "bkDamping",
    "bkRidgeAmp",
    "bkRidgeFreq",
    "bkOutcropAmp",
    "bkOutcropFreq",
    "bkOutcropThreshold",
    "bkChannelDepth",
    "bkChannelFreq",
] as const;

/** Anything with the setter shape — a ShaderMaterial or a ProceduralTexture. */
export interface TerrainParamTarget {
    setFloat(name: string, value: number): unknown;
    setVector2(name: string, value: Vector2): unknown;
}

const wind = new Vector2(0, 1);

/** Allocation-free after the first call. */
export function pushTerrainParams(target: TerrainParamTarget, element: ElementDef, settings: Settings, origin: Vector2, extent: number): void {
    const t = element.terrain;
    const bearing = settings.v["world.windBearing"] * (Math.PI / 180);
    wind.set(Math.sin(bearing), Math.cos(bearing));

    target.setVector2("bkOrigin", origin);
    target.setFloat("bkExtent", extent);
    target.setVector2("bkWind", wind);
    target.setFloat("bkSeed", settings.v["world.seed"]);

    target.setFloat("bkSwellAmp", t.swellAmp);
    target.setFloat("bkSwellFreq", t.swellFreq);
    target.setFloat("bkDuneAmp", t.duneAmp);
    target.setFloat("bkDuneFreq", t.duneFreq);
    target.setFloat("bkDuneStretch", t.duneStretch);
    target.setFloat("bkDuneOctaves", t.duneOctaves);
    target.setFloat("bkShearAmp", t.shearAmp);
    target.setFloat("bkShearFreq", t.shearFreq);
    target.setFloat("bkDetailAmp", t.detailAmp);
    target.setFloat("bkDetailFreq", t.detailFreq);
    target.setFloat("bkDamping", t.damping);
    target.setFloat("bkRidgeAmp", t.ridgeAmp);
    target.setFloat("bkRidgeFreq", t.ridgeFreq);
    target.setFloat("bkOutcropAmp", t.outcropAmp);
    target.setFloat("bkOutcropFreq", t.outcropFreq);
    target.setFloat("bkOutcropThreshold", t.outcropThreshold);
    target.setFloat("bkChannelDepth", t.channelDepth);
    target.setFloat("bkChannelFreq", t.channelFreq);
}
