import { ProceduralTexture } from "@babylonjs/core/Materials/Textures/Procedurals/proceduralTexture";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Constants } from "@babylonjs/core/Engines/constants";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { Vector2, Vector3, Vector4 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";
import type { TargetCamera } from "@babylonjs/core/Cameras/targetCamera";
import { type Settings } from "../core/settings";
import type { BiomeState } from "../core/biome";
import type { ElementDef } from "../elements/types";
import { compileOrWarn, nextFrame } from "../core/loading";
import { debugCode } from "./debugViews";
import { TERRAIN_PARAM_UNIFORMS, pushTerrainParams } from "../terrain/terrainParams";
import skyLutBake from "../shaders/skyLutBake.fragment.wgsl?raw";
import skyDataBake from "../shaders/skyDataBake.fragment.wgsl?raw";
import skyVertex from "../shaders/sky.vertex.wgsl?raw";
import skyFragment from "../shaders/sky.fragment.wgsl?raw";

/**
 * Sky, sun and image-based lighting.
 *
 * Two baked textures and one fullscreen draw:
 *
 *   sky-view LUT   256x128 RGBA16F. Nishita single scattering with a
 *                  multiple-scattering approximation, one raymarch per direction.
 *   sky data       16x1 RGBA32F. The LUT projected into SH irradiance, plus the
 *                  direct sun, the iteratively-solved ground bounce and the aerial
 *                  extinction. See shaders/lib/skyData.wgsl for the layout.
 *
 * Both are baked on demand — when the sun moves, when a sky control changes, or on
 * a biome switch — and never once the scene is static. Nothing here reads back to
 * the CPU: consumers sample the data texture directly, so the sun and the ambient
 * a surface is lit by cannot drift from the sky drawn behind it.
 */

const LUT_WIDTH = 256;
const LUT_HEIGHT = 128;
/** 17 in use, 20 for room. See shaders/lib/skyData.wgsl. */
const DATA_TEXELS = 20;
/** Texel pairs (LUT sample, direct evaluation) that score the LUT's orientation. */
const PROBE_PAIRS = [
    [13, 14],
    [15, 16],
];

/**
 * Solar irradiance at the top of the atmosphere, perpendicular to the sun.
 *
 * The atmosphere model fixes every RATIO in the scene — sun to sky, sky to bounce,
 * red to blue — but the overall scale is a unit choice, and the unit has to suit the
 * display transfer we actually have. Until Phase 9 lands AgX, that transfer is a
 * bare gamma with no highlight rolloff, so the scale is picked to put a full-albedo
 * surface facing a high sun just under 1.0 at 0 EV: 0.9 albedo * 4.0 * 0.8
 * transmittance / pi * 0.93 N.L is about 0.85. Push it and snow clips to a flat
 * white card, which is exactly what the Phase 1 lighting had to be tuned around.
 */
const SUN_IRRADIANCE = 4.0;

/**
 * Uniforms a material needs to declare to include the sky lighting headers.
 *
 * `sbTonemapMode` used to ride along here, on the argument that a material which shades
 * also has to encode, and that the dome and the ground under it must be on the same
 * curve. Phase 9 pass A keeps the conclusion and removes the mechanism: materials emit
 * linear radiance and the composite owns the curve, so there is now exactly one place
 * that could put them on different transfers, and it does not.
 */
export const SKY_UNIFORMS = ["sbSunDir"] as const;
/** Samplers likewise. Bind them with `sky.bindTo(material)`. */
export const SKY_SAMPLERS = ["sbSkyLut", "sbSkyData"] as const;

/** Rendering group for the sky. Everything else draws in group 1, over the top. */
/**
 * The sky draws LAST, not first, and is depth-tested against the world.
 *
 * Drawn first it shaded every pixel the terrain then painted over. Drawn last with
 * LEQUAL against a depth buffer the world has already written, it runs only on
 * background pixels — which is the difference between a per-pixel far-range march
 * being affordable and not.
 */
export const WORLD_GROUP = 1;
export const SKY_GROUP = 2;

const DEG2RAD = Math.PI / 180;

/** Settings that change what is baked rather than how it is drawn. */
const BAKE_KEYS = ["world.sunElevation", "world.sunAzimuth", "sky.multiScatter", "sky.groundBounce", "sky.skyVisibility", "sky.aerialScale", "sky.steps"] as const;

export class Sky {
    /** Direction toward the sun. The one CPU-side lighting number anything else needs. */
    readonly sunDir = new Vector3(0, 1, 0);

    readonly lut: ProceduralTexture;
    readonly data: ProceduralTexture;
    readonly mesh: Mesh;
    readonly material: ShaderMaterial;

    /** False if any of the three sky pipelines failed to compile. */
    compiled = false;
    /** Bakes since boot. Shown in the overlay so a rebake storm is visible, not guessed at. */
    bakes = 0;

    private readonly _settings: Settings;
    private readonly _scene: Scene;
    private readonly _disposers: (() => void)[] = [];

    private _element: ElementDef;
    private _dirty = true;
    private _prepared = false;
    /** Which way v runs in the LUT. Measured at boot, never assumed. */
    private _flipV = 0;

    // Preallocated: update() runs every frame and rule 1 says it allocates nothing.
    private readonly _sunIrradiance = new Vector3(0, 0, 0);
    private readonly _groundAlbedo = new Vector3(0, 0, 0);
    private readonly _emissive = new Vector3(0, 0, 0);
    private readonly _sunTint = new Vector3(1, 1, 1);
    private readonly _lutSize = new Vector2(LUT_WIDTH, LUT_HEIGHT);
    private readonly _right = new Vector3(1, 0, 0);
    private readonly _up = new Vector3(0, 1, 0);
    private readonly _forward = new Vector3(0, 0, 1);
    private readonly _params = new Vector4(0, 0, 0, 0);
    private readonly _far = new Vector4(0, 0, 0, 0);
    private readonly _albedo = new Vector3(1, 1, 1);
    private readonly _albedoSteep = new Vector3(1, 1, 1);
    private readonly _fieldOrigin = new Vector2(0, 0);
    /** Where the clipmap stops and the march starts. Set by main once terrain exists. */
    private _farStart = 870;
    private _fieldExtent = 2048;
    /** Both bake targets take the same atmosphere block; iterated, never rebuilt. */
    private readonly _bakeTargets: ProceduralTexture[];

    constructor(scene: Scene, settings: Settings, biome: BiomeState) {
        this._scene = scene;
        this._settings = settings;
        this._element = biome.current;

        this.lut = new ProceduralTexture(
            "skyLut",
            { width: LUT_WIDTH, height: LUT_HEIGHT },
            { fragmentSource: skyLutBake },
            scene,
            {
                shaderLanguage: ShaderLanguage.WGSL,
                format: Constants.TEXTUREFORMAT_RGBA,
                // Half float, not float: this is the one sky texture that wants
                // bilinear filtering, and rgba16float filters without the adapter
                // having to grant float32-filterable.
                type: Constants.TEXTURETYPE_HALF_FLOAT,
                samplingMode: Constants.TEXTURE_BILINEAR_SAMPLINGMODE,
                generateMipMaps: false,
                skipSceneRegistration: true,
            },
        );
        this.lut.refreshRate = 0;
        // Azimuth is periodic and elevation is not.
        this.lut.wrapU = Constants.TEXTURE_WRAP_ADDRESSMODE;
        this.lut.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;

        this.data = new ProceduralTexture(
            "skyData",
            { width: DATA_TEXELS, height: 1 },
            { fragmentSource: skyDataBake },
            scene,
            {
                shaderLanguage: ShaderLanguage.WGSL,
                format: Constants.TEXTUREFORMAT_RGBA,
                type: Constants.TEXTURETYPE_FLOAT,
                samplingMode: Constants.TEXTURE_NEAREST_SAMPLINGMODE,
                generateMipMaps: false,
                skipSceneRegistration: true,
            },
        );
        this.data.refreshRate = 0;
        this.data.wrapU = Constants.TEXTURE_CLAMP_ADDRESSMODE;
        this.data.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
        this.data.setTexture("sbSkyLut", this.lut);

        this.material = new ShaderMaterial(
            "sky",
            scene,
            { vertexSource: skyVertex, fragmentSource: skyFragment },
            {
                attributes: ["position"],
                uniforms: ["skRight", "skUp", "skForward", "skParams", "skFar", "skCameraPos", "skAlbedo", "skAlbedoSteep", ...TERRAIN_PARAM_UNIFORMS, ...SKY_UNIFORMS],
                samplers: [...SKY_SAMPLERS],
                shaderLanguage: ShaderLanguage.WGSL,
            },
        );
        this.material.backFaceCulling = false;
        // The vertex shader emits z = 1, so LEQUAL passes exactly where the depth
        // buffer is still at its cleared value and nothing else has been drawn.
        this.material.depthFunction = Constants.LEQUAL;
        this.material.disableDepthWrite = true;

        this.mesh = new Mesh("sky", scene);
        const geometry = new VertexData();
        // A single oversized triangle in NDC. The vertex shader passes it through
        // untransformed, so there is no world matrix and nothing to cull against.
        geometry.positions = [-1, -1, 0, 3, -1, 0, -1, 3, 0];
        geometry.indices = [0, 1, 2];
        geometry.applyToMesh(this.mesh, false);
        this.mesh.material = this.material;
        this.mesh.renderingGroupId = SKY_GROUP;
        this.mesh.alwaysSelectAsActiveMesh = true;
        this.mesh.doNotSyncBoundingInfo = true;
        this.mesh.isPickable = false;

        this._bakeTargets = [this.lut, this.data];

        // Babylon clears depth between rendering groups by default. The sky depends
        // on the world's depth, so clearing between them would defeat the whole
        // arrangement — and it is a full-screen clear per frame either way.
        scene.setRenderingAutoClearDepthStencil(WORLD_GROUP, false, false, false);
        scene.setRenderingAutoClearDepthStencil(SKY_GROUP, false, false, false);

        this.bindTo(this.material);

        this._disposers.push(
            biome.onChange((def) => {
                this._element = def;
                const a = def.surface.albedo;
                this._albedo.set(a[0], a[1], a[2]);
                const c = def.surface.albedoCompacted;
                this._albedoSteep.set(c[0] * 0.72, c[1] * 0.72, c[2] * 0.72);
                this._dirty = true;
            }),
        );
        for (const key of BAKE_KEYS) {
            this._disposers.push(settings.on(key, () => (this._dirty = true)));
        }
    }

    /**
     * Tell the sky where the clipmap ends, so the far-range march starts exactly
     * there — no gap to show sky through, no overlap to shade twice.
     */
    setFarStart(radius: number, fieldOriginX: number, fieldOriginZ: number, fieldExtent: number): void {
        this._farStart = radius;
        this._fieldOrigin.set(fieldOriginX, fieldOriginZ);
        this._fieldExtent = fieldExtent;
    }

    /** Point a material's sky samplers at these textures. Call once, at construction. */
    bindTo(material: ShaderMaterial): void {
        material.setTexture("sbSkyLut", this.lut);
        material.setTexture("sbSkyData", this.data);
    }

    /** Compiles the three pipelines and takes the first bake. Runs behind the loading screen. */
    async prepare(report?: (fraction: number) => void): Promise<void> {
        // Before anything else. The first bake happens here and clears the dirty flag,
        // so a sun direction still sitting at its constructed value would be baked in
        // and stay there until something else moved a slider.
        this._refreshSunDir();
        this._pushBakeUniforms();

        for (let guard = 0; guard < 600 && !(this.lut.isReady() && this.data.isReady()); guard++) {
            await nextFrame();
        }
        report?.(0.5);

        const domeOk = await compileOrWarn("sky", () => this.material.forceCompilationAsync(this.mesh));
        this.compiled = domeOk && this.lut.isReady() && this.data.isReady();
        if (!this.lut.isReady()) console.error("[substrate] sky LUT bake shader never became ready");
        if (!this.data.isReady()) console.error("[substrate] sky data bake shader never became ready");

        this._prepared = true;
        await this._resolveLutOrientation();
        report?.(1);
    }

    /**
     * Decide which way the LUT's v axis runs, by measuring rather than reasoning.
     *
     * Whether `vUV.y` grows with the texel row in a Babylon render target depends on
     * a y-flip the shader processor appends, and getting it backwards makes every
     * upward ray sample a downward one — the sky goes to nearly zero radiance and the
     * whole scene falls back on ground bounce. It is also completely invisible in a
     * heightfield, which is how it survived Phase 1: mirrored noise is still noise.
     *
     * So the data bake carries two probe directions, writing both what the LUT says
     * and what a direct evaluation of the same model says. Bake it each way, read
     * back twenty texels, keep whichever agrees. One extra bake and one 320-byte
     * readback, once, and this class of bug cannot ship silently again.
     */
    private async _resolveLutOrientation(): Promise<void> {
        const scores = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
        for (let flip = 0; flip < 2; flip++) {
            this._flipV = flip;
            this._bake();
            const data = (await this.data.readPixels(0, 0, null, true, false, 0, 0, DATA_TEXELS, 1)) as Float32Array | null;
            if (!data) {
                console.warn("[substrate] sky LUT orientation check skipped: no probe data");
                this._flipV = 0;
                this._bake();
                return;
            }
            scores[flip] = probeError(data);
        }

        this._flipV = scores[1] < scores[0] ? 1 : 0;
        this._bake();

        const best = Math.min(scores[0], scores[1]);
        const worst = Math.max(scores[0], scores[1]);
        console.info(`[substrate] sky LUT orientation: ${this._flipV === 0 ? "as written" : "FLIPPED to match the target"} (error ${best.toFixed(4)}, other orientation ${worst.toFixed(2)})`);
        if (best > 0.25) {
            console.warn(`[substrate] sky LUT still disagrees with a direct evaluation by ${(best * 100).toFixed(0)}% — the sky is not the one the model describes`);
        }
    }

    get ready(): boolean {
        return this._prepared && this.bakes > 0 && this.material.isReady(this.mesh);
    }

    /**
     * Recompute the sun, rebake if anything it depends on moved, and push the dome's
     * per-frame uniforms. Allocation-free.
     *
     * Must run before scene.render(): the bake binds its own render target, and the
     * data texture reads the LUT written immediately before it.
     */
    update(camera: TargetCamera): void {
        const s = this._settings.v;

        this._refreshSunDir();

        const enabled = s["sys.sky"];
        this.mesh.setEnabled(enabled);
        if (!enabled) return;

        if (this._dirty && this._prepared) this._bake();

        // Ray basis straight from the camera's own yaw, pitch and FOV. See
        // sky.vertex.wgsl for why this is not an inverted view-projection matrix.
        const yaw = camera.rotation.y;
        const pitch = camera.rotation.x;
        const sinYaw = Math.sin(yaw);
        const cosYaw = Math.cos(yaw);
        const cosPitch = Math.cos(pitch);

        this._forward.set(sinYaw * cosPitch, -Math.sin(pitch), cosYaw * cosPitch);
        this._right.set(cosYaw, 0, -sinYaw);
        Vector3.CrossToRef(this._forward, this._right, this._up);

        const engine = this._scene.getEngine();
        const tanHalfFov = Math.tan(camera.fov * 0.5);
        const aspect = engine.getRenderWidth() / Math.max(1, engine.getRenderHeight());
        this._right.scaleInPlace(tanHalfFov * aspect);
        this._up.scaleInPlace(tanHalfFov);

        const m = this.material;
        m.setVector3("skRight", this._right);
        m.setVector3("skUp", this._up);
        m.setVector3("skForward", this._forward);
        this._params.set(s["render.exposure"], s["sky.sunDisc"] ? 1 : 0, debugCode(s["debug.view"]), 0);
        m.setVector4("skParams", this._params);
        this.pushTo(m);

        // The far range starts where the clipmap stops, so the two meet with no gap
        // and no overlap. CLIPMAP_RADIUS is the one number that has to agree.
        this._far.set(s["sys.farRange"] ? 1 : 0, s["sky.farSteps"], this._farStart, s["sky.farDistance"]);
        m.setVector4("skFar", this._far);
        m.setVector3("skCameraPos", camera.globalPosition);
        m.setVector3("skAlbedo", this._albedo);
        m.setVector3("skAlbedoSteep", this._albedoSteep);
        pushTerrainParams(m, this._element, this._settings, this._fieldOrigin, this._fieldExtent);
    }

    /** Push the uniforms every lit material shares. Call once per frame, per material. */
    pushTo(material: ShaderMaterial): void {
        material.setVector3("sbSunDir", this.sunDir);
    }

    dispose(): void {
        for (const off of this._disposers) off();
        this._disposers.length = 0;
        this.mesh.dispose();
        this.material.dispose();
        this.data.dispose();
        this.lut.dispose();
    }

    // -- internals -----------------------------------------------------------

    private _refreshSunDir(): void {
        const elevation = this._settings.v["world.sunElevation"] * DEG2RAD;
        const azimuth = this._settings.v["world.sunAzimuth"] * DEG2RAD;
        const cosE = Math.cos(elevation);
        this.sunDir.set(cosE * Math.sin(azimuth), Math.sin(elevation), cosE * Math.cos(azimuth));
    }

    private _bake(): void {
        if (!this.lut.isReady() || !this.data.isReady()) return;
        this._pushBakeUniforms();
        // Order matters: the data pass integrates the LUT this line writes.
        this.lut.render();
        this.data.render();
        this._dirty = false;
        this.bakes++;
    }

    private _pushBakeUniforms(): void {
        const s = this._settings.v;
        const atm = this._element.atmosphere;
        const tint = this._element.sunTint;

        this._sunIrradiance.set(SUN_IRRADIANCE, SUN_IRRADIANCE, SUN_IRRADIANCE);
        this._groundAlbedo.set(atm.groundAlbedo[0], atm.groundAlbedo[1], atm.groundAlbedo[2]);
        this._emissive.set(atm.emissiveAmbient[0], atm.emissiveAmbient[1], atm.emissiveAmbient[2]);
        this._sunTint.set(tint[0], tint[1], tint[2]);

        const bounce = atm.groundBounce * s["sky.groundBounce"];

        for (const tex of this._bakeTargets) {
            tex.setVector3("saSunDir", this.sunDir);
            tex.setVector3("saSunIrradiance", this._sunIrradiance);
            tex.setFloat("saRayleighScale", atm.rayleighScale);
            tex.setFloat("saTurbidity", atm.turbidity);
            tex.setFloat("saMieG", atm.mieG);
            tex.setFloat("saMultiScatter", s["sky.multiScatter"]);
            tex.setVector3("saGroundAlbedo", this._groundAlbedo);
            tex.setFloat("saGroundBounce", bounce);
            tex.setVector3("saEmissive", this._emissive);
            tex.setFloat("saSkyVisibility", s["sky.skyVisibility"]);
            tex.setFloat("saSteps", s["sky.steps"]);
            // Element haze is quoted per metre; the model works in kilometres.
            tex.setFloat("saHaze", atm.hazeDensity * 1000);
            tex.setFloat("saAerialScale", s["sky.aerialScale"]);
            tex.setFloat("saViewHeight", 0);
        }

        this.lut.setFloat("slFlipV", this._flipV);

        this.data.setFloat("sdTexels", DATA_TEXELS);
        this.data.setVector2("sdLutSize", this._lutSize);
        this.data.setVector3("sdSunTint", this._sunTint);
    }
}

/**
 * Mean relative disagreement between what the LUT reports for the probe directions
 * and what the model says directly. A correct orientation lands within a few percent
 * — the LUT is filtered and quantised, the direct evaluation is not. A wrong one is
 * near 1, because the mirrored row of an upward ray is a downward ray that hits the
 * ground within metres and scatters almost nothing.
 */
function probeError(data: Float32Array): number {
    const stride = Math.max(1, Math.round(data.length / DATA_TEXELS));
    let sum = 0;
    let n = 0;
    for (const [lutTexel, directTexel] of PROBE_PAIRS) {
        for (let c = 0; c < 3; c++) {
            const lut = data[lutTexel * stride + c];
            const direct = data[directTexel * stride + c];
            sum += Math.abs(lut - direct) / Math.max(Math.abs(direct), 1e-4);
            n++;
        }
    }
    return n > 0 ? sum / n : Number.POSITIVE_INFINITY;
}
