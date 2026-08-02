import type { BiomeId, ElementDef } from "./types";

/**
 * The material registry. Adding an element is adding an entry to this file.
 *
 * If you ever find yourself unable to express an element here and reach for a code
 * branch elsewhere, stop and fix the shared system instead — that is the whole point.
 */

/** Snow's spec target: ~71% of depth survives one minute. t_half = 60 * ln(0.5) / ln(0.71) */
const SNOW_DECAY_HALF_LIFE = (60 * Math.LN2) / -Math.log(0.71); // ~121.4 s

const SNOW: ElementDef = {
    id: "snow",
    label: "Snowfield",
    blurb: "High cohesion, holds a vertical wall, packs when compressed.",
    sunElevation: 12,
    windStrength: 0.25,
    sunTint: [1.0, 0.976, 0.945],
    terrain: {
        // Broad transverse ridges on one long swell, with sparse rock breaking through.
        swellAmp: 38,
        swellFreq: 1 / 900,
        duneAmp: 9,
        duneFreq: 1 / 95,
        duneStretch: 3.4,
        duneOctaves: 4,
        shearAmp: 26,
        shearFreq: 1 / 260,
        detailAmp: 2.6,
        detailFreq: 1 / 26,
        damping: 1.4,
        ridgeAmp: 0,
        ridgeFreq: 0,
        outcropAmp: 14,
        outcropFreq: 1 / 210,
        outcropThreshold: 0.42,
        channelDepth: 0,
        channelFreq: 0,
    },
    substrate: {
        cohesion: 0.82,
        angleOfRepose: 38,
        slumpAnisotropy: 3.0,
        diffusionRate: 0.055,
        decayHalfLife: SNOW_DECAY_HALF_LIFE,
        windSusceptibility: 0.35,
        thermalCoupling: 1.0,
        liftThreshold: 0.06,
    },
    atmosphere: {
        groundAlbedo: [0.85, 0.88, 0.93],
        groundBounce: 1.0,
        turbidity: 2.2,
        hazeDensity: 0.00018,
        mieG: 0.76,
        emissiveAmbient: [0, 0, 0],
        rayleighScale: 1.0,
    },
    surface: {
        albedo: [0.86, 0.89, 0.94],
        albedoCompacted: [0.72, 0.78, 0.88],
        baseRoughness: 0.42,
        subsurfaceTint: [0.42, 0.58, 0.86],
        subsurfaceStrength: 1.0,
        glintDensity: 90,
        glintBasis: 0,
        dualLobeMix: 0.0,
        emissiveGain: 0.0,
    },
    wake: {
        maxCurlDeg: 284,
        peakWall: 2.4,
        collapseLife: 0.88,
        airborneFraction: 0.25,
    },
};

const DESERT: ElementDef = {
    id: "desert",
    label: "Desert",
    blurb: "Near-zero cohesion, hard 34-degree repose limit, migrates constantly.",
    sunElevation: 18,
    windStrength: 0.4,
    sunTint: [1.0, 0.902, 0.741],
    terrain: {
        // The same construction pushed harder: taller crescents, more shear for
        // sharper slip faces, and heavy damping to flatten the interdunes to hardpan.
        swellAmp: 30,
        swellFreq: 1 / 1100,
        duneAmp: 22,
        duneFreq: 1 / 80,
        duneStretch: 4.2,
        duneOctaves: 4,
        shearAmp: 40,
        shearFreq: 1 / 240,
        detailAmp: 1.6,
        detailFreq: 1 / 22,
        damping: 2.2,
        ridgeAmp: 0,
        ridgeFreq: 0,
        outcropAmp: 5,
        outcropFreq: 1 / 250,
        outcropThreshold: 0.55,
        channelDepth: 0,
        channelFreq: 0,
    },
    substrate: {
        cohesion: 0.02,
        angleOfRepose: 34,
        slumpAnisotropy: 1.15,
        diffusionRate: 0.34,
        decayHalfLife: 8,
        windSusceptibility: 0.85,
        thermalCoupling: 0.15,
        liftThreshold: 0.015,
    },
    atmosphere: {
        groundAlbedo: [0.55, 0.42, 0.27],
        groundBounce: 0.65,
        turbidity: 5.5,
        hazeDensity: 0.00042,
        mieG: 0.8,
        emissiveAmbient: [0, 0, 0],
        rayleighScale: 0.9,
    },
    surface: {
        albedo: [0.62, 0.47, 0.3],
        albedoCompacted: [0.34, 0.24, 0.15],
        baseRoughness: 0.58,
        subsurfaceTint: [0.85, 0.62, 0.38],
        subsurfaceStrength: 0.45,
        glintDensity: 40,
        glintBasis: 1,
        dualLobeMix: 0.55,
        emissiveGain: 0.0,
    },
    wake: {
        maxCurlDeg: 96,
        peakWall: 1.5,
        collapseLife: 0.35,
        airborneFraction: 0.45,
    },
};

const VOLCANIC: ElementDef = {
    id: "volcanic",
    label: "Volcanic",
    blurb: "Ash: near-zero cohesion, lifts and never returns. Crust hardens as it cools.",
    sunElevation: 8,
    windStrength: 0.3,
    sunTint: [0.85, 0.62, 0.45],
    terrain: {
        // Lower-frequency base with high-frequency fracture, ridged levees, and
        // carved channels that Phase 6 fills with lava.
        swellAmp: 26,
        swellFreq: 1 / 1250,
        duneAmp: 4,
        duneFreq: 1 / 125,
        duneStretch: 1.4,
        duneOctaves: 3,
        shearAmp: 8,
        shearFreq: 1 / 330,
        detailAmp: 3.4,
        detailFreq: 1 / 17,
        damping: 0.8,
        ridgeAmp: 18,
        ridgeFreq: 1 / 180,
        outcropAmp: 9,
        outcropFreq: 1 / 285,
        outcropThreshold: 0.48,
        channelDepth: 12,
        channelFreq: 1 / 385,
    },
    substrate: {
        cohesion: 0.008,
        angleOfRepose: 30,
        slumpAnisotropy: 1.0,
        diffusionRate: 0.46,
        // Fine grade lifts and never returns: decay is effectively disabled.
        decayHalfLife: 1e9,
        windSusceptibility: 1.0,
        // High: this is what freezes lava crust in place as phase state cools.
        thermalCoupling: 0.9,
        liftThreshold: 0.006,
    },
    atmosphere: {
        groundAlbedo: [0.06, 0.055, 0.05],
        groundBounce: 0.05,
        turbidity: 7.0,
        hazeDensity: 0.00065,
        mieG: 0.88,
        emissiveAmbient: [0.3, 0.075, 0.018],
        rayleighScale: 0.7,
    },
    surface: {
        albedo: [0.09, 0.085, 0.082],
        albedoCompacted: [0.05, 0.048, 0.047],
        baseRoughness: 0.92,
        subsurfaceTint: [0.2, 0.09, 0.05],
        subsurfaceStrength: 0.1,
        glintDensity: 12,
        glintBasis: 2,
        dualLobeMix: 0.15,
        emissiveGain: 1.0,
    },
    wake: {
        maxCurlDeg: 48,
        peakWall: 0.9,
        collapseLife: 0.22,
        airborneFraction: 0.8,
    },
};

const REGISTRY: Record<BiomeId, ElementDef> = {
    snow: SNOW,
    desert: DESERT,
    volcanic: VOLCANIC,
};

export const BIOME_IDS = ["snow", "desert", "volcanic"] as const;

export function getElement(id: BiomeId): ElementDef {
    return REGISTRY[id];
}

export function allElements(): readonly ElementDef[] {
    return BIOME_IDS.map((id) => REGISTRY[id]);
}
