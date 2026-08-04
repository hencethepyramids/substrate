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
        //
        // Amplitudes read high because sbFbmD normalises by the sum of its octave
        // amplitudes and gradient noise sits around +-0.35 after that, so the relief
        // you actually get is roughly a third of the number here. What matters is the
        // ratio to wavelength: 20 m over 70 m is a ~15 degree face, which reads as a
        // drift. The first pass used 9 m over 95 m — about 4 degrees — and looked like
        // a flat field with a wobble in it.
        swellAmp: 38,
        swellFreq: 1 / 900,
        duneAmp: 20,
        duneFreq: 1 / 70,
        duneStretch: 3.4,
        duneOctaves: 4,
        shearAmp: 26,
        shearFreq: 1 / 260,
        detailAmp: 4.5,
        detailFreq: 1 / 18,
        damping: 0.9,
        ridgeAmp: 0,
        ridgeFreq: 0,
        // Outcrops have to be small to read as rock. Spread over 200 m they were just
        // another swell.
        outcropAmp: 18,
        outcropFreq: 1 / 70,
        outcropThreshold: 0.3,
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
    fire: {
        // Melts at the slightest provocation, and then stops. Ice's latent heat is the
        // largest of any common material: a snowfield under a blowtorch holds at melting
        // point for a long time rather than disappearing, and that plateau is this number.
        ignition: 0.12,
        conductivity: 0.3,
        cooling: 0.55,
        latent: 0.8,
        phaseLag: 0.4,
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
        // Nearly twice snow's relief at a similar wavelength: ~30 degree faces, which
        // is what a slip face at the angle of repose should look like.
        duneAmp: 40,
        duneFreq: 1 / 85,
        duneStretch: 4.2,
        duneOctaves: 4,
        shearAmp: 55,
        shearFreq: 1 / 240,
        detailAmp: 2.4,
        detailFreq: 1 / 16,
        // Heavy damping flattens the interdunes toward exposed hardpan.
        damping: 1.8,
        ridgeAmp: 0,
        ridgeFreq: 0,
        outcropAmp: 8,
        outcropFreq: 1 / 90,
        outcropThreshold: 0.42,
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
    fire: {
        // Sand does very little until it does a great deal. High ignition, and dry
        // grains are a poor conductor, so heat stays where it was put.
        ignition: 0.78,
        conductivity: 0.16,
        cooling: 0.38,
        latent: 0.25,
        phaseLag: 1.2,
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
        duneAmp: 8,
        duneFreq: 1 / 125,
        duneStretch: 1.4,
        duneOctaves: 3,
        shearAmp: 8,
        shearFreq: 1 / 330,
        // High-frequency fracture over a low-frequency base, per the spec.
        detailAmp: 6,
        detailFreq: 1 / 12,
        damping: 0.6,
        // Ridged levees are the dominant landform here, not the dunes.
        ridgeAmp: 26,
        ridgeFreq: 1 / 140,
        outcropAmp: 14,
        outcropFreq: 1 / 80,
        outcropThreshold: 0.34,
        channelDepth: 18,
        channelFreq: 1 / 260,
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
    fire: {
        // Goes molten readily, conducts well, and holds its heat. The long phase lag IS
        // the crust: the surface sets while the rock underneath is still hot, which is
        // what lets a flow carry a solid skin on top of moving lava.
        ignition: 0.22,
        conductivity: 0.55,
        cooling: 0.1,
        latent: 0.35,
        phaseLag: 6.0,
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
