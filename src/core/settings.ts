import { BIOME_IDS } from "../elements/registry";

/**
 * The single source of truth.
 *
 * Every art parameter and every subsystem toggle in this project lives in SCHEMA below.
 * Adding a slider or a toggle is exactly one line here — the overlay builds itself from
 * this table, values are typed at the call site, and persistence comes free.
 *
 * Nothing in this file allocates once constructed. `settings.v['key']` is a plain
 * property read and is safe on the hot path.
 */

interface CtrlBase {
    group: string;
    label: string;
    hint?: string;
    /** Hidden behind the overlay's "advanced" reveal. */
    advanced?: boolean;
}

export interface BoolCtrl extends CtrlBase {
    kind: "bool";
    def: boolean;
}
export interface NumCtrl extends CtrlBase {
    kind: "num";
    def: number;
    min: number;
    max: number;
    step: number;
    unit?: string;
}
export interface EnumCtrl<T extends string = string> extends CtrlBase {
    kind: "enum";
    def: T;
    options: readonly T[];
    /** Optional pretty labels, parallel to `options`. */
    optionLabels?: readonly string[];
}
export type AnyCtrl = BoolCtrl | NumCtrl | EnumCtrl;

const bool = (d: Omit<BoolCtrl, "kind">): BoolCtrl => ({ kind: "bool", ...d });
const num = (d: Omit<NumCtrl, "kind">): NumCtrl => ({ kind: "num", ...d });
const enm = <T extends string>(d: Omit<EnumCtrl<T>, "kind">): EnumCtrl<T> => ({ kind: "enum", ...d });

/** Rule 6: debug views are first-class. Each phase adds its entries here. */
export const DEBUG_VIEWS = [
    "off",
    "normals",
    "linearDepth",
    "depthBuffer",
    "reprojection",
    "terrain.rings",
    "terrain.morph",
    "terrain.slope",
    "sky.irradiance",
    "sky.aerial",
    "cascades",
    "shadowMap",
    "substrate.depression",
    "substrate.mass",
    "substrate.compaction",
    "substrate.phase",
    "surface.specular",
    "surface.roughness",
    "surface.subsurface",
    "surface.glints",
    "wind",
    "airborne",
    "fuel",
    "heat",
    "overdraw",
] as const;

export const TONEMAPS = ["agx", "aces", "none"] as const;

// ---------------------------------------------------------------------------
// The schema. One line per control.
// ---------------------------------------------------------------------------

export const SCHEMA = {
    // -- World ---------------------------------------------------------------
    "world.biome": enm({ group: "World", label: "Biome", def: "snow", options: BIOME_IDS, hint: "Switches live. No reload." }),
    "world.applyBiomePresets": bool({ group: "World", label: "Apply biome presets", def: true, hint: "Biome switch overwrites sun + wind with its defaults." }),
    "world.seed": num({ group: "World", label: "Seed", def: 1337, min: 0, max: 99999, step: 1 }),
    "world.sunElevation": num({ group: "World", label: "Sun elevation", def: 12, min: -6, max: 90, step: 0.5, unit: "deg" }),
    "world.sunAzimuth": num({ group: "World", label: "Sun azimuth", def: 135, min: 0, max: 360, step: 1, unit: "deg" }),
    "world.windStrength": num({ group: "World", label: "Wind strength", def: 0.25, min: 0, max: 1, step: 0.01, hint: "Calm to whiteout on one slider." }),
    "world.windBearing": num({ group: "World", label: "Wind bearing", def: 290, min: 0, max: 360, step: 1, unit: "deg" }),
    "world.timeScale": num({ group: "World", label: "Time scale", def: 1, min: 0, max: 4, step: 0.05 }),
    "world.paused": bool({ group: "World", label: "Pause simulation", def: false }),

    // -- Systems: a toggle for every subsystem that will ever exist -----------
    "sys.terrain": bool({ group: "Systems", label: "Terrain clipmap", def: true }),
    "sys.farRange": bool({ group: "Systems", label: "Far range raymarch", def: true }),
    "sys.sky": bool({ group: "Systems", label: "Sky + IBL", def: true }),
    "sys.shadows": bool({ group: "Systems", label: "Shadow cascades", def: true }),
    "sys.depthPrepass": bool({ group: "Systems", label: "Depth prepass", def: true }),
    "sys.substrate": bool({ group: "Systems", label: "Substrate buffer", def: true }),
    "sys.air": bool({ group: "Systems", label: "Air velocity field", def: true }),
    "sys.airborne": bool({ group: "Systems", label: "Airborne material", def: true }),
    "sys.fire": bool({ group: "Systems", label: "Fire propagation", def: true }),
    "sys.smoke": bool({ group: "Systems", label: "Volumetric smoke", def: true }),
    "sys.embers": bool({ group: "Systems", label: "Embers", def: true }),
    "sys.lightPool": bool({ group: "Systems", label: "Dynamic light pool", def: true }),
    "sys.character": bool({ group: "Systems", label: "Character", def: true }),
    "sys.cloth": bool({ group: "Systems", label: "Cloth solver", def: true }),
    "sys.displacement": bool({ group: "Systems", label: "Displace terrain by substrate", def: true, hint: "Off leaves the clipmap on the bare heightfield and the buffer as a normal map, which is what Phases 3 to 7 shipped." }),
    "sys.wake": bool({ group: "Systems", label: "Swept wake", def: true }),
    "sys.spray": bool({ group: "Systems", label: "Spray + particles", def: true }),
    "sys.post": bool({ group: "Systems", label: "Post chain", def: true }),

    // -- Terrain -------------------------------------------------------------
    "terrain.heightScale": num({ group: "Terrain", label: "Height scale", def: 1, min: 0.05, max: 2.5, step: 0.01, hint: "Applied when the field is read, so it is live with no rebake." }),
    "terrain.morph": bool({ group: "Terrain", label: "CDLOD morphing", def: true, hint: "Turn off to see exactly where the LOD seams are." }),
    "terrain.followCamera": bool({ group: "Terrain", label: "Clipmap follows camera", def: true, hint: "Freeze to walk out of the clipmap and inspect the rings." }),

    // -- Sky -----------------------------------------------------------------
    // Every control here rebakes the sky-view LUT and the SH irradiance behind it.
    // Two textures, ~0.3 ms, only when one of these moves.
    "sky.multiScatter": num({
        group: "Sky",
        label: "Multiple scattering",
        def: 0.5,
        min: 0,
        max: 0.9,
        step: 0.01,
        hint: "Per-order gain of the scattering series. 0 is single-scatter only, which reads as a flat navy card.",
    }),
    "sky.groundBounce": num({ group: "Sky", label: "Ground bounce", def: 1, min: 0, max: 3, step: 0.01, hint: "Multiplies the element's own bounce gain. Drop to 0 to see how much of snow's white is bounce." }),
    "sky.aerialScale": num({ group: "Sky", label: "Aerial perspective", def: 1.5, min: 0, max: 6, step: 0.05, hint: "Scales distance extinction only, not the sky. Above 1 while the clipmap still stops at 870 m." }),
    "sky.sunDisc": bool({ group: "Sky", label: "Sun disc", def: true }),
    "sky.farSteps": num({ group: "Sky", label: "Far range steps", def: 40, min: 8, max: 160, step: 4, hint: "Raymarch steps per background pixel past the clipmap. The one genuinely expensive number in the sky." }),
    "sky.farDistance": num({ group: "Sky", label: "Far range", def: 12000, min: 1000, max: 40000, step: 500, unit: "m", hint: "How far the horizon is marched. Beyond this the ray falls back to the bounced plane." }),
    "sky.skyVisibility": num({ group: "Sky", label: "Sky visibility", def: 0.88, min: 0.2, max: 1, step: 0.01, advanced: true, hint: "Fraction of the sky an average ground point sees. Drives the bounce solve." }),
    "sky.steps": num({ group: "Sky", label: "LUT raymarch steps", def: 24, min: 8, max: 64, step: 1, advanced: true, hint: "Per direction, in the sky-view bake. Costs nothing per frame — only per rebake." }),

    // -- Shadows -------------------------------------------------------------
    "shadow.resolution": num({ group: "Shadows", label: "Cascade resolution", def: 2048, min: 512, max: 4096, step: 512, hint: "Per cascade. The atlas is three of these wide." }),
    "shadow.distance": num({ group: "Shadows", label: "Shadow distance", def: 320, min: 50, max: 1000, step: 10, unit: "m", hint: "Past this the sun is unoccluded. The clipmap still draws to 870 m." }),
    "shadow.softness": num({ group: "Shadows", label: "Softness", def: 1, min: 0, max: 3, step: 0.05, hint: "Scales the PCSS penumbra. 0 gives hard shadows at one texel." }),
    "shadow.lightSize": num({ group: "Shadows", label: "Sun angular size", def: 0.012, min: 0, max: 0.1, step: 0.001, hint: "As a fraction of a cascade. The real sun is about half a degree, which is very small — this is a look control." }),
    "shadow.blend": num({ group: "Shadows", label: "Cascade blend", def: 6, min: 0, max: 30, step: 0.5, unit: "m", advanced: true, hint: "Cross-fade band at each cascade edge." }),
    "shadow.bias": num({ group: "Shadows", label: "Depth bias", def: 0.0012, min: 0, max: 0.01, step: 0.0001, advanced: true }),
    "shadow.normalBias": num({ group: "Shadows", label: "Normal offset", def: 1.5, min: 0, max: 8, step: 0.1, unit: "texels", advanced: true, hint: "Offsets the lookup along the normal instead of biasing depth. This is what keeps steep slopes free of acne." }),
    "shadow.pcfTaps": num({ group: "Shadows", label: "PCF taps", def: 16, min: 4, max: 64, step: 4, advanced: true }),
    "shadow.blockerTaps": num({ group: "Shadows", label: "Blocker search taps", def: 12, min: 4, max: 32, step: 4, advanced: true }),
    "shadow.depthRange": num({ group: "Shadows", label: "Caster depth range", def: 200, min: 20, max: 800, step: 10, unit: "m", advanced: true, hint: "How far above a cascade a caster can be and still be included." }),

    // -- Substrate -----------------------------------------------------------
    // What the ground remembers. The seven numbers that make snow differ from sand
    // live in elements/registry.ts, not here — these are the window the simulation
    // runs in and the rate it runs at.
    "substrate.extent": num({ group: "Substrate", label: "Window size", def: 64, min: 16, max: 256, step: 8, unit: "m", hint: "Square, centred on the camera. Wider covers more ground at coarser texels; the buffer is cleared when this moves." }),
    "substrate.resolution": num({ group: "Substrate", label: "Window resolution", def: 1024, min: 256, max: 2048, step: 256, hint: "Texels per side. 1024 over 64 m is 6.25 cm — about a bootprint's worth of detail." }),
    "substrate.relaxRate": num({ group: "Substrate", label: "Relaxation rate", def: 4, min: 0, max: 8, step: 0.1, hint: "Scales slump and diffusion together. 0 freezes the ground without freezing the simulation." }),
    "substrate.relief": num({ group: "Substrate", label: "Surface relief", def: 1, min: 0, max: 3, step: 0.05, hint: "How hard the depression channel bends the surface normal. 0 makes the ground forget it was ever carved, which is the A/B for everything Phase 4 does." }),
    "substrate.carveRadius": num({ group: "Substrate", label: "Carve radius", def: 0.4, min: 0.1, max: 4, step: 0.05, unit: "m", hint: "Shared by the held carve and the test pit." }),
    "substrate.carveRate": num({ group: "Substrate", label: "Carve rate", def: 1.2, min: 0, max: 6, step: 0.05, unit: "m/s", hint: "Depth per second while right mouse is held, so how long you hold it is what decides how deep it goes." }),
    "substrate.testDepth": num({ group: "Substrate", label: "Test pit depth", def: 0.5, min: 0.01, max: 1.5, step: 0.01, unit: "m", hint: "One-shot, for the acceptance test. A stamp's steepest face is 0.736 x depth / radius: the default is 43 degrees, past sand's limit and nowhere near snow's." }),

    // -- Air -----------------------------------------------------------------
    // The wind is a function of the terrain, not a buffer. world.windStrength and
    // world.windBearing say how hard and from where; these say what the ground does to it.
    "air.maxSpeed": num({ group: "Air", label: "Wind speed at full", def: 18, min: 0, max: 40, step: 0.5, unit: "m/s", hint: "What world.windStrength = 1 means in metres per second." }),
    "air.speedup": num({ group: "Air", label: "Slope speed-up", def: 1.2, min: 0, max: 4, step: 0.05, hint: "How much a windward face accelerates the flow. This is the term that strips a stoss face and fills the trough, so it is what actually migrates a dune." }),
    "air.separation": num({ group: "Air", label: "Separation slope", def: 0.4, min: 0.02, max: 2, step: 0.01, hint: "Lee slope at which the flow fully detaches, as a gradient. Measured against this terrain by scripts/checkWind.mjs rather than taken from a textbook: 0.4 sits between the 90th and 97th percentile in both snow and desert, so the bubble is the slip faces and not the whole downwind world. Detachment begins at half of it." }),
    "airborne.threshold": num({ group: "Air", label: "Fluid threshold", def: 5, min: 0.5, max: 25, step: 0.5, unit: "m/s", hint: "Wind speed at which material starts to move. Below it nothing is picked up however long you wait — which is why a still day leaves a dune alone." }),
    "airborne.liftRate": num({ group: "Air", label: "Lift rate", def: 1.4, min: 0, max: 8, step: 0.05, hint: "How fast loose material past liftThreshold leaves the ground where the shear is high enough. Scaled per element by windSusceptibility." }),
    "airborne.settleRate": num({ group: "Air", label: "Settle rate", def: 2.2, min: 0, max: 12, step: 0.1, hint: "How fast suspended material drops out where the flow has slowed or separated. This is what builds a slip face." }),
    "air.gustScale": num({ group: "Air", label: "Gust scale", def: 0.02, min: 0.002, max: 0.2, step: 0.002, unit: "1/m", advanced: true }),
    "air.gustAmount": num({ group: "Air", label: "Gust amount", def: 0.35, min: 0, max: 1, step: 0.01, advanced: true, hint: "Gusts advect downwind rather than pulsing in place." }),

    // -- Fire ----------------------------------------------------------------
    // Heat, and the phase change it drives. What each element DOES with heat lives in
    // elements/registry.ts; these are the ignition source and nothing else.
    "fire.igniteRadius": num({ group: "Fire", label: "Ignite radius", def: 1.6, min: 0.2, max: 12, step: 0.1, unit: "m" }),
    "fire.igniteRate": num({ group: "Fire", label: "Ignite rate", def: 3, min: 0.1, max: 20, step: 0.1, unit: "/s", hint: "Heat poured in per second while igniting. Normalised: 1 is as hot as this world gets." }),
    "fire.igniteSeconds": num({ group: "Fire", label: "Ignite duration", def: 1.5, min: 0.05, max: 10, step: 0.05, unit: "s", hint: "An ignition is a press, not a permanent flame. What happens afterwards is the element's business. In SECONDS, so it does not get four times hotter on a faster machine." }),
    "fire.lightPool": num({ group: "Fire", label: "Light pool", def: 14, min: 0, max: 60, step: 0.5, hint: "How brightly molten ground lights what is around it. Reads high because basalt's albedo is 0.09 — the pool is multiplied by what it is falling on, and volcanic ground is nearly black. Costs nothing in snow or desert, whose emissive gain is zero, so the taps never happen." }),
    "smoke.rate": num({ group: "Fire", label: "Smoke rate", def: 1.6, min: 0, max: 10, step: 0.05, hint: "Smoke made per second per unit of heat above the threshold. It rides the same wind, the same advection and the same Jacobian correction as blown sand, because it is the same buffer." }),
    "smoke.thinning": num({ group: "Fire", label: "Smoke thinning", def: 0.6, min: 0.01, max: 3, step: 0.01, unit: "/s", hint: "Stands in for a plume climbing out of the layer this buffer represents. Material comes back down; smoke does not. Sets the plume's length as much as its density: lifetime times wind speed is how far it reaches, and at 0.28 it outran the whole window and read as global fog." }),
    "smoke.threshold": num({ group: "Fire", label: "Smoke threshold", def: 0.18, min: 0, max: 1, step: 0.01, advanced: true, hint: "Heat below which nothing smokes." }),
    "smoke.density": num({ group: "Fire", label: "Smoke opacity", def: 0.9, min: 0, max: 6, step: 0.05, hint: "How strongly the marched smoke obscures what is behind it." }),
    "embers.life": num({ group: "Fire", label: "Ember life", def: 2.6, min: 0.2, max: 12, step: 0.1, unit: "s" }),
    "embers.rise": num({ group: "Fire", label: "Ember rise", def: 1.8, min: 0, max: 12, step: 0.1, unit: "m/s", hint: "Vertical climb. The horizontal drift is the real wind field, so a spark rounds a dune exactly as the plume above it does." }),
    "embers.size": num({ group: "Fire", label: "Ember size", def: 0.11, min: 0.005, max: 0.5, step: 0.005, unit: "m" }),
    "embers.threshold": num({ group: "Fire", label: "Ember threshold", def: 0.18, min: 0, max: 1, step: 0.01, advanced: true, hint: "Heat below which no ember is born. The FIRE decides which of the particles are real, not the CPU — which is why the mesh can be static, and also why a small fire makes few sparks without anyone arranging it." }),
    "fire.crust": num({ group: "Fire", label: "Crust", def: 1, min: 0, max: 1, step: 0.01, hint: "How much of the glow is hidden behind cooled plates. 0 is a uniformly molten disc, which is the wrong shape for lava however well its brightness is tuned." }),
    "fire.lightRadius": num({ group: "Fire", label: "Light pool radius", def: 6, min: 0.5, max: 24, step: 0.5, unit: "m" }),

    // -- Surface -------------------------------------------------------------
    // The look controls Phase 4 owns. Everything that differs BETWEEN elements is in
    // elements/registry.ts; these scale all of them at once.
    "surface.glintStrength": num({ group: "Surface", label: "Glints", def: 1, min: 0, max: 3, step: 0.05, hint: "Scales the per-facet sparkle. Density and lattice come from the element; this is the global dial. 0 turns it off." }),

    // -- Render --------------------------------------------------------------
    "render.resolutionScale": num({ group: "Render", label: "Resolution scale", def: 1, min: 0.5, max: 2, step: 0.05 }),
    "render.fpsCap": num({ group: "Render", label: "FPS cap", def: 0, min: 0, max: 360, step: 10, hint: "0 = uncapped." }),
    "render.exposure": num({ group: "Render", label: "Exposure", def: 0, min: -4, max: 4, step: 0.05, unit: "EV" }),
    "render.fov": num({ group: "Render", label: "Field of view", def: 62, min: 40, max: 110, step: 1, unit: "deg" }),

    // -- Post ----------------------------------------------------------------
    "post.tonemap": enm({ group: "Post", label: "Tonemap", def: "agx", options: TONEMAPS }),
    "post.taa": bool({ group: "Post", label: "TAA", def: true }),
    "post.bloom": bool({ group: "Post", label: "Bloom", def: true }),
    "post.godrays": bool({ group: "Post", label: "Light shafts", def: true }),
    "post.dof": bool({ group: "Post", label: "Depth of field", def: true }),
    "post.ssr": bool({ group: "Post", label: "Screen-space reflections", def: true }),
    "post.heatDistortion": bool({ group: "Post", label: "Heat distortion", def: true }),
    "post.sharpen": bool({ group: "Post", label: "Contrast-adaptive sharpen", def: true }),
    "post.grain": bool({ group: "Post", label: "Grain", def: true }),
    "post.vignette": bool({ group: "Post", label: "Vignette", def: true }),
    "post.bloomIntensity": num({ group: "Post", label: "Bloom intensity", def: 0.6, min: 0, max: 3, step: 0.01, advanced: true }),
    "post.dofAperture": num({ group: "Post", label: "Aperture (f-number)", def: 2.8, min: 1.2, max: 22, step: 0.1, advanced: true, hint: "Smaller is a wider lens and a shallower focus. The focal length comes from the field of view, so this is the only lens dial." }),
    "post.dofStrength": num({ group: "Post", label: "Defocus exaggeration", def: 6, min: 0, max: 20, step: 0.1, advanced: true, hint: "NOT physical. 1 is the real lens, which at this field of view defocuses the horizon by under a pixel. See the note in post.ts." }),
    "post.dofFocus": num({ group: "Post", label: "Focus distance", def: 0, min: 0, max: 200, step: 0.5, unit: "m", advanced: true, hint: "0 focuses on the character, which is what a camera operator would do." }),
    "post.godrayIntensity": num({ group: "Post", label: "Light shaft intensity", def: 1, min: 0, max: 3, step: 0.01, advanced: true }),
    "post.grainAmount": num({ group: "Post", label: "Grain amount", def: 0.35, min: 0, max: 2, step: 0.01, advanced: true }),
    "post.vignetteAmount": num({ group: "Post", label: "Vignette amount", def: 0.4, min: 0, max: 2, step: 0.01, advanced: true }),
    "post.sharpenAmount": num({ group: "Post", label: "Sharpen amount", def: 0.35, min: 0, max: 1, step: 0.01, advanced: true }),

    // -- Camera --------------------------------------------------------------
    "cam.armLength": num({ group: "Camera", label: "Arm length", def: 5.5, min: 1.5, max: 14, step: 0.1, unit: "m" }),
    "cam.height": num({ group: "Camera", label: "Pivot height", def: 1.6, min: 0, max: 3, step: 0.05, unit: "m" }),
    "cam.sensitivity": num({ group: "Camera", label: "Look sensitivity", def: 0.22, min: 0.02, max: 1, step: 0.01 }),
    "cam.invertY": bool({ group: "Camera", label: "Invert Y", def: false }),
    "cam.smoothing": num({ group: "Camera", label: "Arm smoothing", def: 0.82, min: 0, max: 0.99, step: 0.01 }),
    "cam.pitchMin": num({ group: "Camera", label: "Pitch min", def: -72, min: -89, max: 0, step: 1, unit: "deg", advanced: true }),
    "cam.pitchMax": num({ group: "Camera", label: "Pitch max", def: 74, min: 0, max: 89, step: 1, unit: "deg", advanced: true }),
    "cam.shake": num({ group: "Camera", label: "Shake scale", def: 1, min: 0, max: 2, step: 0.05 }),

    // -- Character -----------------------------------------------------------
    "char.walkSpeed": num({ group: "Character", label: "Walk speed", def: 3.2, min: 0.5, max: 10, step: 0.1, unit: "m/s" }),
    "char.sprintMultiplier": num({ group: "Character", label: "Sprint multiplier", def: 2.4, min: 1, max: 4, step: 0.05 }),
    "char.acceleration": num({ group: "Character", label: "Acceleration", def: 22, min: 2, max: 80, step: 1, unit: "m/s2", advanced: true }),
    "char.turnRate": num({ group: "Character", label: "Turn rate", def: 540, min: 90, max: 1440, step: 10, unit: "deg/s", advanced: true }),
    // The gait, and the footfalls it lays. Stride length is the one number both the legs
    // and the prints are phased on, which is why a print stays under the foot that made it.
    "char.strideLength": num({ group: "Character", label: "Stride scale", def: 0.75, min: 0.2, max: 2.5, step: 0.05, unit: "m", hint: "Scales the stride the gait derives from speed and leg length. 0.75 leaves it unchanged. Still phased on distance, not time." }),
    "char.stanceWidth": num({ group: "Character", label: "Stance width", def: 0.28, min: 0, max: 1, step: 0.01, unit: "m" }),
    "char.stepLift": num({ group: "Character", label: "Step lift", def: 0.13, min: 0, max: 0.6, step: 0.01, unit: "m", hint: "Ground clearance at mid-swing. A swinging foot never drops below the terrain regardless." }),
    "char.armSwing": num({ group: "Character", label: "Arm swing", def: 34, min: 0, max: 90, step: 1, unit: "deg", hint: "Counter-phased against the legs. Zero reads as a shuffle." }),
    "char.footRoll": num({ group: "Character", label: "Foot roll", def: 26, min: 0, max: 60, step: 1, unit: "deg", advanced: true }),
    "char.lean": num({ group: "Character", label: "Forward lean", def: 9, min: 0, max: 30, step: 0.5, unit: "deg", advanced: true }),
    "char.bank": num({ group: "Character", label: "Bank into turns", def: 1, min: 0, max: 2, step: 0.05, advanced: true, hint: "Scales the real balance angle, tan(bank) = v*omega/g. 1 is what physics asks for." }),
    // Traversal. A walk is gravity plus a lot of grip; a slide is gravity plus very little.
    "char.slopeWalk": num({ group: "Character", label: "Slope pull, walking", def: 0.35, min: 0, max: 1, step: 0.01, hint: "Share of the along-slope gravity a walking body feels. Boots grip; they do not weld." }),
    "char.slopeClimb": num({ group: "Character", label: "Climb cost", def: 0.55, min: 0, max: 2, step: 0.05, hint: "How much a gradient takes off the top speed when heading up it." }),
    "char.slideFriction": num({ group: "Character", label: "Slide friction", def: 0.3, min: 0.02, max: 4, step: 0.01, unit: "1/s", hint: "Low is ice, high is gravel. What the hill gives, this takes back." }),
    "char.slideSteer": num({ group: "Character", label: "Slide steering", def: 7, min: 0, max: 30, step: 0.5, unit: "m/s2", hint: "Steering authority while sliding. You lean; you do not walk." }),
    "char.footRadius": num({ group: "Character", label: "Foot radius", def: 0.12, min: 0.02, max: 0.6, step: 0.01, unit: "m" }),
    "char.footDepth": num({ group: "Character", label: "Foot depth", def: 0.09, min: 0, max: 0.6, step: 0.005, unit: "m", hint: "At walking pace; a run presses harder. The load is the character's, the response is the element's." }),
    "char.clothRoughness": num({ group: "Character", label: "Cloth roughness", def: 0.72, min: 0.04, max: 1, step: 0.01, advanced: true }),
    "char.skinRoughness": num({ group: "Character", label: "Skin roughness", def: 0.44, min: 0.04, max: 1, step: 0.01, advanced: true }),
    "char.subsurface": num({ group: "Character", label: "Subsurface", def: 0.35, min: 0, max: 1, step: 0.01, advanced: true, hint: "Wrapped light through the surface, tinted the way blood tints it." }),

    // -- Wake ----------------------------------------------------------------
    // The channel a body ploughs at speed. The stamp is volume-neutral, so the berms
    // either side are conservation rather than a second effect.
    "wake.speedMin": num({ group: "Wake", label: "Starts at", def: 4.2, min: 0, max: 12, step: 0.1, unit: "m/s", hint: "Below this a body walks over the ground rather than through it." }),
    "wake.speedFull": num({ group: "Wake", label: "Full at", def: 8, min: 1, max: 20, step: 0.5, unit: "m/s" }),
    "wake.width": num({ group: "Wake", label: "Width", def: 0.5, min: 0.1, max: 2, step: 0.05, unit: "m" }),
    "wake.depth": num({ group: "Wake", label: "Depth", def: 0.075, min: 0, max: 0.5, step: 0.005, unit: "m", hint: "Per stamp at full speed. What the ground then does with it is the element's business." }),
    "wake.spacing": num({ group: "Wake", label: "Stamp spacing", def: 0.14, min: 0.04, max: 0.6, step: 0.01, unit: "m", advanced: true, hint: "Distance between stamps, not time — so the channel is the same at 60 fps and at 240." }),
    "wake.bias": num({ group: "Wake", label: "Carve bias", def: 0.9, min: 0, max: 2, step: 0.05, advanced: true, hint: "How far the channel leans to the outside of a turn, as a share of its own width." }),

    // -- Spray ---------------------------------------------------------------
    // What a wake throws. Gated on the substrate's loose mass, so broken ground throws
    // and packed ground does not.
    "spray.speedMin": num({ group: "Spray", label: "Starts at", def: 3.6, min: 0, max: 12, step: 0.1, unit: "m/s" }),
    "spray.massMin": num({ group: "Spray", label: "Loose mass floor", def: 0.0002, min: 0, max: 0.01, step: 0.0001, hint: "Below this the ground has nothing to throw. It is what tells a fresh track from a packed one." }),
    "spray.radius": num({ group: "Spray", label: "Throw radius", def: 1.0, min: 0.2, max: 6, step: 0.1, unit: "m", hint: "How far from the body grains are picked up." }),
    "spray.launch": num({ group: "Spray", label: "Launch speed", def: 3.4, min: 0, max: 14, step: 0.1, unit: "m/s" }),
    "spray.life": num({ group: "Spray", label: "Lifetime", def: 1.1, min: 0.1, max: 4, step: 0.05, unit: "s" }),
    "spray.size": num({ group: "Spray", label: "Grain size", def: 0.028, min: 0.005, max: 0.3, step: 0.005, unit: "m" }),

    // -- Cloth ---------------------------------------------------------------
    // The cloak, on the same wind that carves the dunes and carries the smoke.
    "cloth.drag": num({ group: "Cloth", label: "Wind drag", def: 1.6, min: 0, max: 20, step: 0.1, hint: "How hard the air pushes on the sheet. Applied along the surface normal, which is why cloth fills instead of being shoved." }),
    "cloth.damping": num({ group: "Cloth", label: "Damping", def: 1.6, min: 0, max: 12, step: 0.05, unit: "1/s" }),
    "cloth.iterations": num({ group: "Cloth", label: "Solver iterations", def: 8, min: 1, max: 16, step: 1, advanced: true, hint: "Constraint passes per substep. More is stiffer, not more accurate." }),
    "cloth.width": num({ group: "Cloth", label: "Width", def: 0.38, min: 0.1, max: 1.2, step: 0.02, unit: "m", advanced: true, hint: "Read once, at construction." }),
    "cloth.length": num({ group: "Cloth", label: "Length", def: 0.82, min: 0.2, max: 1.6, step: 0.02, unit: "m", advanced: true, hint: "Read once, at construction." }),
    "cloth.subsurface": num({ group: "Cloth", label: "Subsurface", def: 0.4, min: 0, max: 1, step: 0.01, advanced: true, hint: "Cloth is thin, so a good deal of light comes through the far side of it." }),

    // -- Debug ---------------------------------------------------------------
    "debug.view": enm({ group: "Debug", label: "Debug view", def: "off", options: DEBUG_VIEWS }),
    "debug.wireframe": bool({ group: "Debug", label: "Wireframe", def: false }),
    "debug.freezeCulling": bool({ group: "Debug", label: "Freeze culling", def: false }),
    "debug.showSubstrateWindow": bool({ group: "Debug", label: "Show substrate window", def: false }),

    // -- Perf ----------------------------------------------------------------
    "perf.gpuTiming": bool({ group: "Perf", label: "GPU timestamp queries", def: true, hint: "Requires the timestamp-query feature." }),
    "perf.graphRangeMs": num({ group: "Perf", label: "Graph range", def: 12, min: 4, max: 64, step: 1, unit: "ms" }),
    "perf.targetFps": num({ group: "Perf", label: "Target FPS line", def: 90, min: 30, max: 360, step: 10 }),
    "perf.overlayScale": num({ group: "Perf", label: "Overlay scale", def: 1, min: 0.75, max: 1.6, step: 0.05 }),

    // -- UI state (persisted here so there is exactly one source of truth) ----
    "ui.overlayOpen": bool({ group: "UI", label: "Overlay open", def: true, advanced: true }),
    "ui.showAdvanced": bool({ group: "UI", label: "Show advanced controls", def: false, advanced: true }),
} satisfies Record<string, AnyCtrl>;

export type Schema = typeof SCHEMA;
export type SettingKey = keyof Schema & string;

type ValOf<C> = C extends BoolCtrl ? boolean : C extends NumCtrl ? number : C extends EnumCtrl<infer T> ? T : never;
export type SettingValue<K extends SettingKey> = ValOf<Schema[K]>;
export type SettingsValues = { [K in SettingKey]: SettingValue<K> };

export type SettingListener<K extends SettingKey = SettingKey> = (value: SettingValue<K>, key: K) => void;

/**
 * Bumped whenever the schema changes materially. Phase 1 added the Terrain group and
 * new debug views; Phase 2 added the Sky group; Phase 3 added the Substrate group.
 * More importantly, a stale persisted `ui.overlayOpen: false` from an earlier build
 * would hide the overlay on first run with no obvious way to know why.
 */
const STORAGE_KEY = "substrate.settings.v4";

export class Settings {
    /** Direct value access for the hot path: `settings.v["sys.terrain"]`. */
    readonly v: SettingsValues;

    readonly keys: readonly SettingKey[];
    readonly groups: readonly string[];

    private readonly _perKey = new Map<string, SettingListener<never>[]>();
    private readonly _any: ((key: SettingKey) => void)[] = [];
    private _saveTimer = 0;
    private _muted = false;

    constructor() {
        const values = {} as Record<string, unknown>;
        const keys: SettingKey[] = [];
        const groups: string[] = [];
        for (const key of Object.keys(SCHEMA) as SettingKey[]) {
            const ctrl = SCHEMA[key] as AnyCtrl;
            values[key] = ctrl.def;
            keys.push(key);
            if (!groups.includes(ctrl.group)) groups.push(ctrl.group);
        }
        this.v = values as SettingsValues;
        this.keys = keys;
        this.groups = groups;
        this._loadPersisted();
    }

    ctrl(key: SettingKey): AnyCtrl {
        return SCHEMA[key] as AnyCtrl;
    }

    get<K extends SettingKey>(key: K): SettingValue<K> {
        return this.v[key];
    }

    set<K extends SettingKey>(key: K, value: SettingValue<K>): void {
        const next = this._coerce(key, value);
        if (this.v[key] === next) return;
        (this.v as Record<string, unknown>)[key] = next;
        if (!this._muted) this._emit(key);
        this._scheduleSave();
    }

    /** Apply many values, emitting each change. Used by biome presets and reset. */
    apply(patch: Partial<SettingsValues>): void {
        for (const key of Object.keys(patch) as SettingKey[]) {
            const value = patch[key];
            if (value !== undefined) this.set(key, value as never);
        }
    }

    on<K extends SettingKey>(key: K, fn: SettingListener<K>): () => void {
        let list = this._perKey.get(key);
        if (!list) {
            list = [];
            this._perKey.set(key, list);
        }
        list.push(fn as SettingListener<never>);
        return () => {
            const i = list!.indexOf(fn as SettingListener<never>);
            if (i >= 0) list!.splice(i, 1);
        };
    }

    /** Fires for every change. The overlay uses this to stay in sync with code-side writes. */
    onAny(fn: (key: SettingKey) => void): () => void {
        this._any.push(fn);
        return () => {
            const i = this._any.indexOf(fn);
            if (i >= 0) this._any.splice(i, 1);
        };
    }

    reset(): void {
        for (const key of this.keys) this.set(key, (SCHEMA[key] as AnyCtrl).def as never);
    }

    resetGroup(group: string): void {
        for (const key of this.keys) {
            const ctrl = SCHEMA[key] as AnyCtrl;
            if (ctrl.group === group) this.set(key, ctrl.def as never);
        }
    }

    private _emit(key: SettingKey): void {
        const list = this._perKey.get(key);
        if (list !== undefined) {
            for (let i = 0; i < list.length; i++) {
                (list[i] as SettingListener)(this.v[key], key);
            }
        }
        for (let i = 0; i < this._any.length; i++) this._any[i](key);
    }

    private _coerce<K extends SettingKey>(key: K, value: SettingValue<K>): SettingValue<K> {
        const ctrl = SCHEMA[key] as AnyCtrl;
        if (ctrl.kind === "num") {
            let n = typeof value === "number" ? value : Number(value);
            if (!Number.isFinite(n)) n = ctrl.def;
            n = Math.min(ctrl.max, Math.max(ctrl.min, n));
            // Snap to step so slider and code-side writes agree exactly.
            if (ctrl.step > 0) {
                n = ctrl.min + Math.round((n - ctrl.min) / ctrl.step) * ctrl.step;
                n = Math.min(ctrl.max, Math.max(ctrl.min, n));
                // Kill float dust from the snap (0.30000000000000004 -> 0.3).
                n = Number(n.toFixed(6));
            }
            return n as SettingValue<K>;
        }
        if (ctrl.kind === "bool") return !!value as SettingValue<K>;
        return (ctrl.options.includes(value as string) ? value : ctrl.def) as SettingValue<K>;
    }

    // -- persistence ---------------------------------------------------------

    private _loadPersisted(): void {
        let raw: string | null = null;
        try {
            raw = localStorage.getItem(STORAGE_KEY);
        } catch {
            return; // Private mode / blocked storage: defaults are fine.
        }
        if (!raw) return;
        try {
            const parsed = JSON.parse(raw) as Record<string, unknown>;
            this._muted = true;
            for (const key of this.keys) {
                if (Object.hasOwn(parsed, key)) this.set(key, parsed[key] as never);
            }
        } catch {
            /* Corrupt blob: ignore and keep defaults. */
        } finally {
            this._muted = false;
        }
    }

    /** Debounced so a slider drag writes storage once, never per frame. */
    private _scheduleSave(): void {
        if (this._saveTimer !== 0) return;
        this._saveTimer = window.setTimeout(() => {
            this._saveTimer = 0;
            try {
                localStorage.setItem(STORAGE_KEY, JSON.stringify(this.v));
            } catch {
                /* Storage unavailable: settings simply do not persist. */
            }
        }, 400);
    }
}
