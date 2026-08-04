/**
 * Element parameter blocks.
 *
 * The architectural test for this whole project (see the build spec) is that adding
 * an element means adding a row of numbers here and NOTHING else. Every field on
 * these interfaces must be consumed by shared code. If a field is only ever read by
 * an `if (biome === 'x')` branch, the abstraction has already failed and the branch
 * is the bug, not the field.
 */

export type BiomeId = "snow" | "desert" | "volcanic";

/**
 * Consumed by the single substrate relaxation pass (Phase 3). These seven fields are
 * the entire difference between snow, sand and ash at the simulation level.
 */
export interface SubstrateParams {
    /** Resistance to slump. Snow high, sand ~0. 0..1 */
    cohesion: number;
    /** Hard slope limit in degrees. Sand enforces ~34 strictly. */
    angleOfRepose: number;
    /** Berm-vs-floor slump rate ratio. Snow ~3:1. */
    slumpAnisotropy: number;
    /** Isotropic spreading per second. */
    diffusionRate: number;
    /** Seconds for depression depth to halve. Ash is effectively permanent. */
    decayHalfLife: number;
    /** Coupling strength to the Phase 5 velocity field. 0..1 */
    windSusceptibility: number;
    /** How much phase-state change alters cohesion (Phase 6). Drives lava crust hardening. */
    thermalCoupling: number;
    /** Depth in metres above which loose material lifts into the air field (Phase 5). */
    liftThreshold: number;
}

/**
 * Consumed by the single heat pass (Phase 6).
 *
 * "Fire" here is not combustion — it is HEAT DRIVING A PHASE CHANGE, which is the only
 * reading that unifies the three elements instead of privileging one. Snow melts, sand
 * needs far more before it does anything, and rock goes molten and then sets into crust.
 * Same pass, same five numbers, and the phase channel it produces already has two
 * consumers waiting for it from earlier phases: `thermalCoupling` softens cohesion so
 * molten material flows, and `emissiveGain` makes it glow.
 */
export interface FireParams {
    /** Heat at which the material starts changing phase. Normalised, 0..1. */
    ignition: number;
    /** How fast heat spreads through the material, in m2/s. Rock conducts; snow does not. */
    conductivity: number;
    /** Fraction of its heat the surface loses to the air per second. */
    cooling: number;
    /**
     * Heat the phase change swallows before phase can advance further. This is what
     * gives melting a plateau rather than a ramp — ice absorbs an enormous amount at
     * constant temperature, which is exactly why a snowfield does not vanish at once.
     */
    latent: number;
    /**
     * Seconds for phase to catch up with heat. Lava crust lags badly and that lag IS
     * the crust: the rock is still hot underneath long after the surface has set.
     */
    phaseLag: number;
}

/**
 * Consumed by the analytic sky + IBL bake (Phase 2). The ground bounce term is what
 * differentiates the biomes at the lighting level, so it is a first-class parameter.
 */
export interface AtmosphereParams {
    /** Ground albedo fed into the iterative bounce solve. Linear RGB. */
    groundAlbedo: [number, number, number];
    /** Bounce gain multiplier. Snow very high, volcanic near zero. */
    groundBounce: number;
    /** Aerosol loading. Desert high, volcanic ash-loaded. */
    turbidity: number;
    /** Distance haze density (1/m). */
    hazeDensity: number;
    /** Mie asymmetry. Higher = stronger forward scattering. */
    mieG: number;
    /** Ambient that comes from emission rather than bounce (volcanic). Linear RGB. */
    emissiveAmbient: [number, number, number];
    /** Rayleigh tint multiplier, lets each biome push its zenith gradient. */
    rayleighScale: number;
}

/**
 * Consumed by the one surface uber-shader (Phase 4).
 */
export interface SurfaceParams {
    /** Linear RGB base albedo of undisturbed material. */
    albedo: [number, number, number];
    /** Albedo of fully compacted material (packed snow, wet sand, crushed ash). */
    albedoCompacted: [number, number, number];
    baseRoughness: number;
    /** Subsurface back-scatter tint. Snow's depth-dependent blue is the headline case. */
    subsurfaceTint: [number, number, number];
    subsurfaceStrength: number;
    /** Glints per square metre, and the noise basis they sit on (kept distinct per element). */
    glintDensity: number;
    glintBasis: number;
    /** Specular lobe blend for dual-lobe sand. 0 = single lobe. */
    dualLobeMix: number;
    /** Blackbody emissive gain driven by the heat channel. Zero for non-volcanic. */
    emissiveGain: number;
}

/**
 * Governs the swept wake cross-section (Phase 8). Element decides how far the lip
 * can curl before the repose angle collapses it.
 */
export interface WakeParams {
    /** Curl sweep in degrees at full carve. Snow reaches a hanging lip, sand does not. */
    maxCurlDeg: number;
    /** Peak wall height in metres at full-speed carve. */
    peakWall: number;
    /** Seconds from laid to collapsed. Wake length is life x speed, no second constant. */
    collapseLife: number;
    /** Fraction of displaced material that becomes airborne instead of banking. */
    airborneFraction: number;
}

/**
 * Consumed by the one heightfield function (Phase 1). Every biome is the same
 * construction — swell, sheared dunes, drifts, ridges, outcrops, channels — with
 * different numbers. Amplitudes are metres, frequencies are cycles per metre.
 */
export interface TerrainDef {
    /** One long low swell. Single octave: this is the horizon silhouette. */
    swellAmp: number;
    swellFreq: number;

    /** Broad dune ridges, stretched across the wind so they read as transverse. */
    duneAmp: number;
    duneFreq: number;
    duneStretch: number;
    duneOctaves: number;

    /** Domain shear along the wind, in metres of displacement. Makes lee faces steepen. */
    shearAmp: number;
    shearFreq: number;

    /** Medium drifts riding on the sheared domain. */
    detailAmp: number;
    detailFreq: number;
    /** Slope damping. Higher = smoother hollows and crisper crests. */
    damping: number;

    /** Ridged multifractal for volcanic flow levees. Zero elsewhere. */
    ridgeAmp: number;
    ridgeFreq: number;

    /** Sparse hard outcrops pushing through the loose material. */
    outcropAmp: number;
    outcropFreq: number;
    /** Noise value above which rock emerges. Higher = sparser. */
    outcropThreshold: number;

    /** Carved channels for Phase 6's lava. Zero elsewhere. */
    channelDepth: number;
    channelFreq: number;
}

export interface ElementDef {
    id: BiomeId;
    label: string;
    /** Short description shown in the overlay's biome selector. */
    blurb: string;
    terrain: TerrainDef;
    substrate: SubstrateParams;
    fire: FireParams;
    atmosphere: AtmosphereParams;
    surface: SurfaceParams;
    wake: WakeParams;
    /** Default sun elevation in degrees when this biome is selected. */
    sunElevation: number;
    /** Default wind strength 0..1 when this biome is selected. */
    windStrength: number;
    /** Linear RGB of direct sunlight at the reference elevation. */
    sunTint: [number, number, number];
}
