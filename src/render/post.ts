import { PostProcess } from "@babylonjs/core/PostProcesses/postProcess";
import { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import { CopyTextureToTexture } from "@babylonjs/core/Misc/copyTextureToTexture";
import { Matrix } from "@babylonjs/core/Maths/math.vector";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Constants } from "@babylonjs/core/Engines/constants";
import type { Scene } from "@babylonjs/core/scene";
import type { Camera } from "@babylonjs/core/Cameras/camera";
import type { Settings } from "../core/settings";
import { TONEMAPS } from "../core/settings";
import type { Sky, SkyTarget } from "./sky";
import { SKY_SAMPLERS, SKY_UNIFORMS } from "./sky";
import type { Depth } from "./depth";
import type { FireTarget } from "../fire/fire";
import type { SubstrateTarget } from "../substrate/substrate";

/** What the composite needs from the fire, without Post having to know what a fire is. */
export interface HeatSource {
    bindTo(target: FireTarget): void;
}
/**
 * The one surface number the reflection pass cannot derive for itself.
 *
 * Only base roughness: how much compaction smooths it is a material fact shared by both
 * shaders, so it lives in lib/brdf.wgsl as SB_PACKED_SMOOTH rather than being carried
 * across the boundary twice.
 */
export interface SurfaceSource {
    readonly baseRoughness: number;
}
/** Likewise the substrate window, which is where the heat field lives. */
export interface HeatWindow {
    pushTo(target: SubstrateTarget): void;
    bindTo(target: SubstrateTarget): void;
}
import composite from "../shaders/composite.fragment.wgsl?raw";
import bloomDown from "../shaders/bloomDown.fragment.wgsl?raw";
import bloomUp from "../shaders/bloomUp.fragment.wgsl?raw";
import godrays from "../shaders/godrays.fragment.wgsl?raw";
import dof from "../shaders/dof.fragment.wgsl?raw";
import ssr from "../shaders/ssr.fragment.wgsl?raw";
import taa from "../shaders/taa.fragment.wgsl?raw";
import finish from "../shaders/finish.fragment.wgsl?raw";

/**
 * The post chain.
 *
 * PASS A — WHY THE FRAME STAYS LINEAR. Until Phase 9 every material ended with
 * `sbDisplay`: tonemap, gamma, done. That is a fine arrangement right up until something
 * wants to read the image back, and then it is a trap, because a display-referred pixel
 * has thrown away the one number an effect needs. AgX maps a scene-referred 17 and a
 * scene-referred 3 to roughly the same bright grey. Bloom on that grey cannot tell the sun
 * glitter from a pale rock, so it blooms both or neither. Every effect Phase 9 owes has
 * the same appetite, so the fix is one fix: keep radiance linear until the very end.
 *
 * The frame renders into a HALF-FLOAT target and the composite applies the curve once.
 * Babylon picks the scene target's format from the FIRST post process in the camera's
 * chain, which is why `textureType` below is load-bearing rather than decorative — set it
 * to the default 8-bit and the HDR range is gone before the composite ever sees it, with
 * no error anywhere to say so.
 *
 * PASS B — THE BLOOM PYRAMID. Five downsamples and four upsamples between the scene and
 * the composite. Every one of them is a PostProcess on the camera, in chain order, which
 * matters for a reason worth writing down: Babylon binds each pass's `textureSampler` to
 * the PREVIOUS pass's output automatically, and that is exactly the wiring a pyramid
 * wants — down[n] reads down[n-1], and up[n] reads the level below it. The only wires
 * that need to be run by hand are the two that jump backwards: each upsample also needs
 * its own octave, and the composite needs the untouched scene. `setTextureFromPostProcess`
 * gives the pass's INPUT and `...Output` gives its output, so the scene is reachable as
 * the input of the first downsample however long the chain in between grows.
 *
 * PASS C — LIGHT SHAFTS. One more pass at half resolution, marching from each pixel
 * toward the sun's screen position and accumulating only the taps that land on sky. The
 * scene buffer's alpha carries that answer: pass A made it a display-transform weight,
 * and it is now a material class — 0 raw quantity, 1 surface, 2 sky — which costs nothing
 * and saves a depth pre-pass over the whole clipmap for one bit of information.
 *
 * Shafts ADD and bloom MIXES, and that is not a stylistic choice. Bloom is light already
 * in the frame landing in the wrong place; a shaft is light that was never in the frame
 * at all, scattering off air along the view ray. One redistributes, the other arrives.
 *
 * PASS D — SORTED BY WHERE THEY PHYSICALLY HAPPEN. The vignette is a LENS: less light
 * reaches the corner of the sensor, so it scales radiance and belongs in the composite,
 * before the curve. Sharpening and grain are SENSOR AND OUTPUT effects and belong after
 * it, in a final 8-bit pass — display-referred colour in 0..1 needs no more than that.
 * Filing them by convenience instead would have put all three in one place and made two
 * of them wrong.
 *
 * PASS F — DEPTH OF FIELD, the first consumer of pass E's depth buffer. A real thin-lens
 * circle of confusion, gathered as scatter-as-gather. It also settled a question worth
 * recording: at this field of view the lens is 21 mm, and a 21 mm lens focused at six
 * metres puts the horizon 0.88 pixels out of focus. Third-person cameras have deep focus.
 * The exaggeration that makes the effect visible is therefore a named slider rather than a
 * constant hidden in the maths.
 *
 * PASS G — HEAT DISTORTION, and no pass at all: it is a UV offset computed at the top of
 * the composite, so every later sample follows the refracted ray rather than being blended
 * over it.
 *
 * PASS H — TAA, and the mechanism that was missing. A post process cannot choose its own
 * output — Babylon hands each pass the NEXT pass's texture — so a history buffer cannot be
 * ping-ponged the way Babylon's own frame-graph TAA does it. The answer is a texture this
 * class owns and one blit a frame, which is also why TAA forces the finish pass on: a
 * pass's output only exists as a texture if something comes after it.
 *
 * WHAT IS NOT HERE YET: SSR.
 */

/**
 * Depth of the pyramid. Five puts the smallest level at roughly 28 x 50 px in a 1600 x 900
 * window, which is a halo about a third of the screen wide — past that the levels are too
 * few texels to carry a smooth gradient and start to shimmer instead.
 */
const LEVELS = 5;

/**
 * Scattered fraction at `post.bloomIntensity` = 1. Small on purpose: this is veiling
 * glare, and a real lens scatters a few percent, not a third. The slider runs to 3 for
 * when the answer wanted is "obviously wrong, but which way".
 */
const SCATTER_AT_UNITY = 0.08;

/**
 * Shaft gain at `post.godrayIntensity` = 1. The pass already averages over its taps, so
 * this is the fraction of the sky's own radiance that the air along a clear ray adds
 * back — a hazy day, not a smoke machine.
 */
const SHAFT_AT_UNITY = 0.55;

/** How far outside the frame the sun may go before its shafts have faded out, in screens. */
const SHAFT_MARGIN = 0.75;

/**
 * How far along the ray to the sun the taps span, and how fast they attenuate.
 *
 * Density below 1 means the taps stop short of the sun rather than reaching it, which is
 * what keeps a beam from collapsing into a hard star at the disc. The decay is per tap,
 * so 0.97 over 60 taps leaves about 16% at the far end — a beam that fades along its
 * length instead of ending.
 */
const SHAFT_DENSITY = 0.85;
const SHAFT_DECAY = 0.97;

/**
 * The widest circle of confusion the gather will chase, in pixels of the half-resolution
 * buffer. The cost is a disc of this radius per pixel, so it is a quality-versus-time dial
 * rather than a look: past it, everything simply shares the same maximum blur, which is
 * also what a real lens does once a subject is far enough past focus.
 */
const DOF_MAX_COC = 16;

/**
 * Ceiling on a single shaft tap, in scene-referred units at exposure 0.
 *
 * The sky near a low sun runs to a few tens; the sun disc itself runs to about 59,000,
 * because it is drawn as irradiance over a solid angle of 6.8e-5 sr. Both are correct.
 * Only one of them can be integrated by sixty taps, so the other gets clipped — see the
 * long note in godrays.fragment.wgsl. Sixty keeps every part of the sky intact and takes
 * three orders of magnitude off the disc.
 *
 * Scaled by exposure at bind time, because the scene buffer has already been multiplied
 * by it and a constant that ignores that would clip the whole sky at +4 EV.
 */
const SHAFT_CEILING = 60;

/**
 * Ceiling on a bloom tap, first level only, same units and same reason as SHAFT_CEILING —
 * an unrepresentable delta function has to be bounded before a five-level pyramid tries
 * to carry it. Higher than the shafts ceiling because the pyramid is a far better filter
 * than sixty taps along a line, and because the sun SHOULD glare hardest of anything in
 * the frame: 200 still leaves it an order of magnitude over the brightest sky.
 */
const BLOOM_CEILING = 200;

/**
 * Length of the jitter sequence, and so how many subpixel positions the average is over.
 * Eight is the usual answer and it is a resolve-time-versus-convergence trade: the blend
 * below reaches steady state in roughly 1/TAA_KEEP frames either way, but a longer sequence
 * takes longer to have VISITED every position, which is what actually antialiases.
 */
const TAA_SAMPLES = 8;

/**
 * How much of the current frame survives each blend, so the history is the other 90%.
 *
 * This is a time constant, not a strength: at 0.1 a pixel is 90% converged after about 22
 * frames, which at 60 Hz is a third of a second. Lower is smoother and ghosts longer;
 * higher is noisier and sharper. It is only safe this low because the neighbourhood clamp
 * is there — without one, a tenth per frame is a quarter-second smear behind everything
 * that moves.
 */
const TAA_KEEP = 0.1;

/**
 * The radical inverse of `index` in `base` — the digits of the index in that base,
 * reflected about the point. Two coprime bases give a 2D sequence whose every prefix is
 * spread evenly over the unit square, and "every prefix" is the property that matters here:
 * TAA is always averaging a prefix, so a sequence that only becomes uniform once it
 * finishes would put the edge in the wrong place until it did.
 */
function halton(index: number, base: number): number {
    let f = 1;
    let r = 0;
    let n = index;
    while (n > 0) {
        f /= base;
        r += f * (n % base);
        n = Math.floor(n / base);
    }
    return r;
}

export class Post {
    private readonly _settings: Settings;
    private readonly _scene: Scene;
    private readonly _composite: PostProcess;
    private readonly _camera: Camera;
    private readonly _down: PostProcess[] = [];
    private readonly _up: PostProcess[] = [];
    private readonly _shafts: PostProcess;
    private readonly _finish: PostProcess;
    private readonly _dof: PostProcess;
    private readonly _taa: PostProcess;
    private readonly _ssr: PostProcess;
    /** Last frame's resolved output. Owned here, filled by a blit — see _store(). */
    private _history: RenderTargetTexture;
    private readonly _copy: CopyTextureToTexture;
    /** Last frame's world-to-clip, jitter included. What reprojection is measured against. */
    private readonly _prevVP = Matrix.Identity();
    private readonly _sky: Sky;
    private _depth: Depth | null = null;
    private _fire: HeatSource | null = null;
    private _surface: SurfaceSource | null = null;
    private _window: HeatWindow | null = null;
    private readonly _disposers: (() => void)[] = [];
    /**
     * Whichever pass currently runs first. Its input IS the frame as rendered, and that
     * is the only handle anything downstream has on the untouched scene.
     */
    private _first!: PostProcess;
    private _shaftsAttached = true;
    private _finishAttached = true;
    private _dofAttached = true;
    /** Where in the jitter sequence this frame is. */
    private _frame = 0;
    private _jitterX = 0;
    private _jitterY = 0;
    /** The same, one frame back. The history is at pixel centres, so reprojection has to
     * undo the offset the previous frame was rendered with — see taa.fragment.wgsl. */
    private _prevJitterX = 0;
    private _prevJitterY = 0;
    /** Set whenever the history stops meaning anything: first frame, resize, toggle on. */
    private _taaReset = true;
    /** Whether this class currently owns the camera's projection matrix. */
    private _frozen = false;
    /** Where the lens is focused this frame, in metres. Set from outside. */
    private _focus = 10;
    /** Simulation seconds. Drives the grain, so a paused frame has a still grain. */
    private _time = 0;
    private _sunU = 0.5;
    private _sunV = 0.5;
    private _facing = 0;
    // Both start true because construction attaches all of them; _sync() reconciles
    // against the settings on the last line of the constructor.
    private _attached = true;
    private _bloomAttached = true;
    private _taaAttached = true;
    private _ssrAttached = true;
    private _probed = false;
    private _jitterProbed = false;

    /** True once every pass in the chain has actually compiled. */
    get compiled(): boolean {
        return this._composite.isReady() && this._shafts.isReady() && this._finish.isReady() && this._dof.isReady() && this._taa.isReady() && this._ssr.isReady() && this._down.every((p) => p.isReady()) && this._up.every((p) => p.isReady());
    }

    /** Fullscreen passes currently in the chain. Cheap to read, and it is what costs. */
    get passes(): number {
        return (this._attached ? 1 : 0) + (this._bloomAttached ? this._down.length + this._up.length : 0) + (this._shaftsAttached ? 1 : 0) + (this._finishAttached ? 1 : 0) + (this._dofAttached ? 1 : 0) + (this._taaAttached ? 1 : 0) + (this._ssrAttached ? 1 : 0);
    }

    constructor(scene: Scene, settings: Settings, camera: Camera, sky: Sky) {
        this._settings = settings;
        this._scene = scene;
        this._camera = camera;
        this._sky = sky;

        // Babylon addresses shaders in its store by `<name>PixelShader`, and takes the
        // bare name in the constructor. Registered here rather than in lib/register.ts
        // because these are whole shaders, not shared includes.
        ShaderStore.ShadersStoreWGSL["substrateCompositePixelShader"] = composite;
        ShaderStore.ShadersStoreWGSL["substrateBloomDownPixelShader"] = bloomDown;
        ShaderStore.ShadersStoreWGSL["substrateBloomUpPixelShader"] = bloomUp;
        ShaderStore.ShadersStoreWGSL["substrateGodraysPixelShader"] = godrays;
        ShaderStore.ShadersStoreWGSL["substrateFinishPixelShader"] = finish;
        ShaderStore.ShadersStoreWGSL["substrateDofPixelShader"] = dof;
        ShaderStore.ShadersStoreWGSL["substrateSsrPixelShader"] = ssr;
        ShaderStore.ShadersStoreWGSL["substrateTaaPixelShader"] = taa;

        const engine = scene.getEngine();
        // EVERY PASS TAKES THE CAMERA AT CONSTRUCTION, and they are constructed in chain
        // order for that reason: `attachPostProcess` appends, so the order these are built
        // in IS the order they run in. Building them detached and attaching later looks
        // tidier and renders black — a PostProcess given neither a camera nor a scene
        // never gets wired to one, the frame goes into a render target, and nothing ever
        // puts it on screen.
        const common = {
            camera,
            samplingMode: Constants.TEXTURE_BILINEAR_SAMPLINGMODE,
            engine,
            reusable: false,
            // Every rung of the pyramid stays in the space the scene was rendered in.
            // One 8-bit link anywhere in this chain and the highlights that bloom exists
            // to spread are gone before the spreading starts.
            textureType: Constants.TEXTURETYPE_HALF_FLOAT,
            shaderLanguage: ShaderLanguage.WGSL,
        };

        // Downsamples: 1/2, 1/4, 1/8, 1/16, 1/32.
        for (let i = 0; i < LEVELS; i++) {
            const ratio = 1 / 2 ** (i + 1);
            const pass = new PostProcess(`substrateBloomDown${i}`, "substrateBloomDown", {
                ...common,
                uniforms: ["bmTexel", "bmKaris", "bmCeiling"],
                size: ratio,
            });
            pass.onApply = (effect) => {
                // The SOURCE texel, which for a downsample is twice this pass's own.
                effect.setFloat2("bmTexel", 1 / Math.max(pass.width * 2, 1), 1 / Math.max(pass.height * 2, 1));
                effect.setFloat("bmKaris", i === 0 ? 1 : 0);
                // Only the top level clamps. Below it the fireflies are already gone and
                // a second ceiling would just be losing light for no reason.
                effect.setFloat("bmCeiling", i === 0 ? BLOOM_CEILING * 2 ** (this._settings.v["render.exposure"] as number) : 3.4e38);
            };
            this._down.push(pass);
        }

        // Upsamples, coming back: 1/16, 1/8, 1/4, 1/2. One fewer than the downsamples,
        // because the bottom level has nothing below it to be blended with.
        for (let i = LEVELS - 2; i >= 0; i--) {
            const ratio = 1 / 2 ** (i + 1);
            const lower = this._down[i];
            const pass = new PostProcess(`substrateBloomUp${i}`, "substrateBloomUp", {
                ...common,
                uniforms: ["bmTexel"],
                samplers: ["bmLower"],
                size: ratio,
            });
            pass.onApply = (effect) => {
                // The tent's radius is a texel of what is being magnified — the level
                // below — which is twice this pass's own texel.
                effect.setFloat2("bmTexel", 1 / Math.max(pass.width * 2, 1), 1 / Math.max(pass.height * 2, 1));
                effect.setTextureFromPostProcessOutput("bmLower", lower);
            };
            this._up.push(pass);
        }

        // Half resolution. A shaft is a low-frequency thing and 60 taps at full resolution
        // would be the most expensive pass here by a wide margin — but quarter was too far:
        // the gradient immediately beside the sun is the steepest in the frame, and
        // magnifying it 4x showed bilinear blocks. The taps read the FULL-resolution scene
        // at continuous coordinates either way, so the disc is found regardless.
        this._shafts = new PostProcess("substrateGodrays", "substrateGodrays", {
            ...common,
            uniforms: ["gsSunUV", "gsParams", "gsTexel"],
            size: 0.5,
        });
        // Always: this pass wants the scene, never the pass in front of it.
        this._shafts.externalTextureSamplerBinding = true;
        this._shafts.onApply = (effect) => {
            this._updateSun();
            effect.setTextureFromPostProcess("textureSampler", this._first);
            effect.setFloat2("gsSunUV", this._sunU, this._sunV);
            effect.setFloat2("gsTexel", 1 / Math.max(this._shafts.width, 1), 1 / Math.max(this._shafts.height, 1));
            effect.setFloat4("gsParams", SHAFT_DENSITY, SHAFT_DECAY, SHAFT_CEILING * 2 ** (this._settings.v["render.exposure"] as number), this._facing);
        };

        // Half resolution. A circle of confusion smaller than two pixels is not a blur
        // anyone can see, and one larger than that survives the halving intact — so the
        // only detail this loses is detail the effect was about to destroy anyway.
        this._dof = new PostProcess("substrateDof", "substrateDof", {
            ...common,
            uniforms: ["dfLens", "dfTexel", "dfCeiling"],
            samplers: ["dfDepth"],
            size: 0.5,
        });
        this._dof.externalTextureSamplerBinding = true;
        this._dof.onApply = (effect) => {
            effect.setTextureFromPostProcess("textureSampler", this._first);
            if (this._depth !== null) effect.setTexture("dfDepth", this._depth.target);
            effect.setFloat2("dfTexel", 1 / Math.max(this._dof.width, 1), 1 / Math.max(this._dof.height, 1));

            // THE LENS, DERIVED RATHER THAN DIALLED. The focal length follows from the
            // field of view and a full-frame sensor height, so a wider view really is a
            // wider lens with more depth of field — which is the behaviour that makes this
            // read as a camera rather than as a depth-keyed blur.
            const sensorH = 0.024;
            const f = sensorH * 0.5 / Math.tan(this._camera.fov * 0.5);
            const aperture = f / (this._settings.v["post.dofAperture"] as number);
            const focus = Math.max(this._focus, f * 1.01);
            // Circle of confusion in metres on the sensor is this constant times |d-F|/d;
            // converting to pixels of this buffer is one more scale.
            // AN EXAGGERATION, NAMED AS ONE. The field of view implies a 21 mm lens, and
            // a 21 mm lens focused at six metres puts the horizon 0.88 pixels out of focus
            // — measured, not guessed. That is the truth about third-person cameras: they
            // have deep focus, which is why games that want this look do not get it for
            // free either. Everything above this line is the real thin-lens model and
            // stays honest; this one multiplier is the departure, it has its own slider,
            // and at 1 the effect is physically correct and invisible.
            const strength = this._settings.v["post.dofStrength"] as number;
            const perMetre = (strength * aperture * f) / Math.max(focus - f, 1e-4);
            const toPixels = this._dof.height / sensorH;
            effect.setFloat4("dfLens", focus, perMetre * toPixels, DOF_MAX_COC, f);
            effect.setFloat("dfCeiling", BLOOM_CEILING * 2 ** (this._settings.v["render.exposure"] as number));
        };

        // Half resolution. A reflection off a rough surface has no detail finer than this
        // to lose, and the march is the most expensive loop in the chain — 32 steps with a
        // projection each, over every pixel that passes the Fresnel gate.
        this._ssr = new PostProcess("substrateSsr", "substrateSsr", {
            ...common,
            uniforms: ["srCamPos", "srCamRight", "srCamUp", "srCamFwd", "srViewProj", "srLens", "srTexel", "srParams", "sbSubOrigin", "sbSubExtent", "sbSubSize", "sbSubFade", ...SKY_UNIFORMS],
            samplers: ["srDepth", "sbSubTex", ...SKY_SAMPLERS],
            size: 0.5,
        });
        this._ssr.externalTextureSamplerBinding = true;
        this._ssr.onApply = (effect) => {
            effect.setTextureFromPostProcess("textureSampler", this._first);
            if (this._depth !== null) effect.setTexture("srDepth", this._depth.target);
            const wm = this._camera.getWorldMatrix().m;
            effect.setFloat3("srCamRight", wm[0], wm[1], wm[2]);
            effect.setFloat3("srCamUp", wm[4], wm[5], wm[6]);
            effect.setFloat3("srCamFwd", wm[8], wm[9], wm[10]);
            const cp = this._camera.globalPosition;
            effect.setFloat3("srCamPos", cp.x, cp.y, cp.z);
            effect.setMatrix("srViewProj", this._camera.getTransformationMatrix());
            effect.setFloat2("srLens", Math.tan(this._camera.fov * 0.5), this._ssr.aspectRatio);
            effect.setFloat2("srTexel", 1 / Math.max(this._ssr.width, 1), 1 / Math.max(this._ssr.height, 1));
            // The element's own roughness and the terrain's own compaction constant, so
            // this pass reaches the same number terrain.fragment.wgsl reaches. Read through
            // a getter rather than duplicated as a constant here, because two copies of a
            // material property is how the trail ends up reflecting somewhere other than
            // where it shines.
            effect.setFloat4("srParams", this._surface !== null ? this._surface.baseRoughness : 0.5, this._settings.v["post.ssrIntensity"] as number, this._frame, 0);
            this._sky.bindTo(effect as unknown as SkyTarget);
            this._sky.pushTo(effect as unknown as SkyTarget);
            if (this._window !== null) {
                this._window.pushTo(effect);
                this._window.bindTo(effect);
            }
        };

        this._composite = new PostProcess("substrateComposite", "substrateComposite", {
            ...common,
            uniforms: ["sbTonemapMode", "cpBloomWeight", "cpShaftWeight", "cpVignette", "cpShowDepth", "cpDofMax", "cpSsr0", "cpCamPos", "cpCamRight", "cpCamUp", "cpCamFwd", "cpHeat", "sbSubOrigin", "sbSubExtent", "sbSubSize", "sbSubFade"],
            samplers: ["cpBloom", "cpShafts", "cpDepth", "cpDof", "cpSsr", "sbFireTex", "sbSubTex"],
            size: 1.0,
        });
        // AFTER the composite, so the colour arriving is display-referred and inside 0..1.
        // That placement is about the sun: a min/max box over linear radiance containing a
        // 59,000 sample spans five orders of magnitude and clamps nothing, and this phase
        // has already lost three filters to exactly that number. After the curve the box
        // means something.
        //
        // The one pass in the chain that WANTS the previous pass's output, so it is the one
        // pass that leaves `externalTextureSamplerBinding` alone.
        this._taa = new PostProcess("substrateTaa", "substrateTaa", {
            ...common,
            uniforms: ["taaPrevViewProj", "taaCamPos", "taaCamRight", "taaCamUp", "taaCamFwd", "taaLens", "taaParams", "taaTexel"],
            samplers: ["taaHistory", "taaDepth"],
            size: 1.0,
        });
        this._history = this._makeHistory(engine.getRenderWidth(true), engine.getRenderHeight(true));
        this._copy = new CopyTextureToTexture(engine, false, true);
        this._taa.onApply = (effect) => {
            effect.setMatrix("taaPrevViewProj", this._prevVP);
            const wm = this._camera.getWorldMatrix().m;
            effect.setFloat3("taaCamRight", wm[0], wm[1], wm[2]);
            effect.setFloat3("taaCamUp", wm[4], wm[5], wm[6]);
            effect.setFloat3("taaCamFwd", wm[8], wm[9], wm[10]);
            const cp = this._camera.globalPosition;
            effect.setFloat3("taaCamPos", cp.x, cp.y, cp.z);
            effect.setFloat2("taaLens", Math.tan(this._camera.fov * 0.5), this._taa.aspectRatio);
            effect.setFloat2("taaTexel", 1 / Math.max(this._taa.width, 1), 1 / Math.max(this._taa.height, 1));
            if (this._depth !== null) effect.setTexture("taaDepth", this._depth.target);
            effect.setTexture("taaHistory", this._history);
            // A DEBUG VIEW IS PRESENTED WHOLE. Blending an instrument with its own past
            // is the temporal version of running a tonemap over it: the number displayed
            // stops being this frame's answer and becomes a decaying average of the last
            // twenty, which is the one thing an instrument must never do. Costs a compare.
            const view = this._settings.v["debug.view"] as string;
            effect.setFloat4("taaParams", this._taaReset || view !== "off" ? 1 : TAA_KEEP, view === "reprojection" ? 1 : 0, this._prevJitterX, this._prevJitterY);
            if (!this._jitterProbed && this._frame > 2) {
                this._jitterProbed = true;
                this._probeJitter();
            }
            this._taaReset = false;
        };

        // AFTER the composite — and after TAA when that is on, which is always when it is
        // on, because the resolve has to be the last thing that touches structure. Grain
        // before it would be averaged into a smooth haze; sharpening before it would be
        // undone by the very next blend.
        //
        // Half-float rather than the eight bits this held before pass H, and the reason is
        // the history rather than this pass's own output. When TAA runs, this texture is
        // what TAA renders into, and it is what gets copied to the history — so it is the
        // precision the accumulation carries. A tenth of one level of 255 is zero, so an
        // 8-bit history stalls a level short of the answer and leaves faint banding on
        // every smooth gradient it was supposed to be smoothing.
        this._finish = new PostProcess("substrateFinish", "substrateFinish", {
            ...common,
            uniforms: ["fnParams", "fnTexel"],
            size: 1.0,
        });
        this._finish.onApply = (effect) => {
            // OFF FOR EVERY DEBUG VIEW, and pass H is the second time this phase has had to
            // learn it. Pass E found the vignette quietly multiplying the depth buffer;
            // this is the same mistake one pass later. Grain over a motion-vector field
            // adds plus or minus a pixel of fictional motion to every reading, and
            // sharpening puts a halo on the edges of whatever is being measured. A debug
            // view is a measurement, and a sensor is not part of what is being measured.
            const raw = this._settings.v["debug.view"] !== "off";
            const sharpen = !raw && (this._settings.v["post.sharpen"] as boolean) ? (this._settings.v["post.sharpenAmount"] as number) : 0;
            const grain = !raw && (this._settings.v["post.grain"] as boolean) ? (this._settings.v["post.grainAmount"] as number) : 0;
            // 24 Hz, not per frame. Film grain is re-exposed once per frame of film, and
            // resampling it at 144 Hz makes it a shimmer rather than a texture.
            effect.setFloat4("fnParams", sharpen, grain, Math.floor(this._time * 24), 0);
            effect.setFloat2("fnTexel", 1 / Math.max(this._finish.width, 1), 1 / Math.max(this._finish.height, 1));
        };

        this._composite.onApply = (effect) => {
            // Once, on the first frame the pyramid is actually sized. Rule 1 holds: after
            // this the branch is a boolean test.
            if (!this._probed && this._bloomAttached && this._down[0].width > 0) {
                this._probed = true;
                this._probe();
            }
            effect.setFloat("sbTonemapMode", Math.max(0, TONEMAPS.indexOf(this._settings.v["post.tonemap"] as (typeof TONEMAPS)[number])));
            // The real lens, so the falloff tracks the field of view rather than being a
            // radial gradient that looks the same at every focal length.
            const vignette = (this._settings.v["post.vignette"] as boolean) ? (this._settings.v["post.vignetteAmount"] as number) : 0;
            effect.setFloat3("cpVignette", vignette, Math.tan(this._camera.fov * 0.5), this._composite.aspectRatio);

            // The camera basis, so the composite can turn a pixel and a distance back into
            // a world point. Babylon's world matrix rows ARE the basis vectors.
            const wm = this._camera.getWorldMatrix().m;
            effect.setFloat3("cpCamRight", wm[0], wm[1], wm[2]);
            effect.setFloat3("cpCamUp", wm[4], wm[5], wm[6]);
            effect.setFloat3("cpCamFwd", wm[8], wm[9], wm[10]);
            const cp = this._camera.globalPosition;
            effect.setFloat3("cpCamPos", cp.x, cp.y, cp.z);
            // The depth buffer, shown raw when asked for. Bound to the scene otherwise, so
            // the sampler always points at something legal.
            const hasDepth = this._depth !== null && this._depth.enabled;
            effect.setFloat("cpShowDepth", hasDepth && this._settings.v["debug.view"] === "depthBuffer" ? 1 : 0);
            if (hasDepth) effect.setTexture("cpDepth", this._depth!.target);
            else effect.setTextureFromPostProcess("cpDepth", this._first);
// Needs a depth buffer to find the world point and a fire to read; without
            // either there is nothing to refract through.
            const heat = hasDepth && this._fire !== null && (this._settings.v["post.heatDistortion"] as boolean) ? 1 : 0;
            effect.setFloat2("cpHeat", heat, this._time);
            if (this._fire !== null) this._fire.bindTo(effect);
            if (this._window !== null) {
                this._window.pushTo(effect);
                // Every frame: the buffer ping-pongs, so a binding taken once would alias
                // whichever half is currently being written.
                this._window.bindTo(effect);
            }
            if (this._ssrAttached) {
                effect.setTextureFromPostProcessOutput("cpSsr", this._ssr);
                effect.setFloat("cpSsr0", 1);
            } else {
                effect.setTextureFromPostProcess("cpSsr", this._first);
                effect.setFloat("cpSsr0", 0);
            }
            if (this._dofAttached) {
                effect.setTextureFromPostProcessOutput("cpDof", this._dof);
                effect.setFloat("cpDofMax", DOF_MAX_COC);
            } else {
                effect.setTextureFromPostProcess("cpDof", this._first);
                effect.setFloat("cpDofMax", 0);
            }
            // THE SCENE IS ALWAYS THE FIRST PASS'S INPUT, whatever the first pass turns
            // out to be. Babylon's automatic binding hands each pass the previous one's
            // OUTPUT, which for the composite is the top of the bloom pyramid — the one
            // texture it must not mistake for the frame. Naming it explicitly is the fix,
            // and doing it through `_first` means the toggles can reorder the chain
            // underneath without this line ever having to know.
            effect.setTextureFromPostProcess("textureSampler", this._first);
            if (this._bloomAttached) {
                effect.setTextureFromPostProcessOutput("cpBloom", this._up[this._up.length - 1]);
                effect.setFloat("cpBloomWeight", Math.min(SCATTER_AT_UNITY * (this._settings.v["post.bloomIntensity"] as number), 0.9));
            } else {
                // Off, and the sampler still has to point somewhere legal. A gain of zero
                // is what keeps it out of the picture.
                effect.setTextureFromPostProcess("cpBloom", this._first);
                effect.setFloat("cpBloomWeight", 0);
            }
            if (this._shaftsAttached) {
                effect.setTextureFromPostProcessOutput("cpShafts", this._shafts);
                effect.setFloat("cpShaftWeight", SHAFT_AT_UNITY * (this._settings.v["post.godrayIntensity"] as number));
            } else {
                effect.setTextureFromPostProcess("cpShafts", this._first);
                effect.setFloat("cpShaftWeight", 0);
            }
        };

        // Rule 3, twice over. `sys.post` off detaches the only thing applying the display
        // transform, so the frame arrives raw and everything above 1 clips — which is the
        // point, because that is the picture the materials actually produce and seeing it
        // is how you tell a blown highlight from a tonemap doing its job. `post.bloom` off
        // takes the pyramid out of the chain entirely rather than weighting it to zero,
        // so the toggle answers "what does it cost" as well as "what does it look like".
        this._disposers.push(settings.on("sys.post", () => this._sync()));
        this._disposers.push(settings.on("post.bloom", () => this._sync()));
        this._disposers.push(settings.on("post.godrays", () => this._sync()));
        this._disposers.push(settings.on("post.sharpen", () => this._sync()));
        this._disposers.push(settings.on("post.grain", () => this._sync()));
        this._disposers.push(settings.on("post.dof", () => this._sync()));
        this._disposers.push(settings.on("post.taa", () => this._sync()));
        this._disposers.push(settings.on("post.ssr", () => this._sync()));
        // The frame's last word: this frame's resolve becomes next frame's history.
        const stored = scene.onAfterRenderObservable.add(() => this._store());
        this._disposers.push(() => scene.onAfterRenderObservable.remove(stored));
        this._sync();
    }

    /**
     * Where the sun is on screen, and whether there is any point looking.
     *
     * The sun is at infinity, so it projects as a DIRECTION: the same transform as a
     * point but without the translation row, and the perspective divide still applies.
     * `w` carries the sign — negative means the sun is behind the camera, and marching
     * toward a point behind you produces a beam pattern that is not merely wrong but
     * inverted, converging on the antisolar point.
     *
     * Writes into `_sunUV` and `_facing`; allocates nothing (Rule 1).
     */
    private _updateSun(): void {
        const m = this._camera.getTransformationMatrix().m;
        const d = this._sky.sunDir;
        const x = d.x * m[0] + d.y * m[4] + d.z * m[8];
        const y = d.x * m[1] + d.y * m[5] + d.z * m[9];
        const w = d.x * m[3] + d.y * m[7] + d.z * m[11];
        if (w <= 1e-6) {
            this._facing = 0;
            return;
        }
        this._sunU = (x / w) * 0.5 + 0.5;
        this._sunV = (y / w) * 0.5 + 0.5;
        // A sun just outside the frame still throws shafts INTO it — the taps march
        // toward an off-screen point perfectly well — so this fades over a margin rather
        // than cutting at the edge. Past a screen's width away the taps are stepping
        // through nothing but occluder and the whole pass is wasted work.
        const outside = Math.max(Math.abs(this._sunU - 0.5) - 0.5, Math.abs(this._sunV - 0.5) - 0.5, 0);
        this._facing = Math.max(0, 1 - outside / SHAFT_MARGIN);
    }

    /**
     * Rebuilds the camera's chain to match the toggles.
     *
     * Detach everything and reattach in order rather than patching: `attachPostProcess`
     * appends, so the chain's order is its attach order, and a pyramid whose upsamples
     * run before its downsamples is not a thing that fails loudly.
     *
     * THE FIRST PASS MUST autoClear, AND IT IS NOT ABOUT COLOUR. A post process's
     * `activate()` binds its own texture as the target the previous stage draws into and
     * then clears it — colour, DEPTH and stencil. For the first pass in the chain, the
     * "previous stage" is the scene itself, so that clear is the only depth clear the
     * frame gets. Switch it off as a micro-optimisation, on the sound-sounding reasoning
     * that a fullscreen pass overwrites every pixel anyway, and the depth buffer keeps
     * last frame's values, every fragment fails its depth test, and the frame is black.
     * It took bisecting the shader to find, because nothing in the console mentions depth.
     *
     * Which pass is first changes with the toggles — `down[0]` with bloom, the composite
     * without — so the rule is applied here, where the order is decided, rather than at
     * construction where it would be a guess.
     */
    private _sync(): void {
        const wantPost = this._settings.v["sys.post"] as boolean;
        const wantBloom = wantPost && (this._settings.v["post.bloom"] as boolean);
        const wantShafts = wantPost && (this._settings.v["post.godrays"] as boolean);
        const wantDof = wantPost && (this._settings.v["post.dof"] as boolean) && this._depth !== null && this._depth.enabled;
        // Depth is not optional here. Without it the history cannot be reprojected, and TAA
        // without reprojection is what Babylon's own implementation is: fine for a still
        // photograph, a smear the moment anything moves. Off is better than that.
        const wantTaa = wantPost && (this._settings.v["post.taa"] as boolean) && this._depth !== null && this._depth.enabled;
        // Depth again, for the same reason: the march IS a walk through the depth buffer.
        const wantSsr = wantPost && (this._settings.v["post.ssr"] as boolean) && this._depth !== null && this._depth.enabled;
        // One pass for two toggles: either of them needs it, neither of them means it is
        // pure cost. The amounts still gate the work inside the shader.
        // TAA is the third reason to run it, and not because it wants sharpening: the
        // history blit reads TAA's output, and a pass's output is only a texture if
        // something comes after it. With both toggles off this is a passthrough, which is
        // the same fullscreen blit the copy needed anyway.
        const wantFinish = wantPost && (wantTaa || (this._settings.v["post.sharpen"] as boolean) || (this._settings.v["post.grain"] as boolean));
        const changed = wantPost !== this._attached || wantBloom !== this._bloomAttached || wantShafts !== this._shaftsAttached || wantFinish !== this._finishAttached || wantDof !== this._dofAttached || wantTaa !== this._taaAttached || wantSsr !== this._ssrAttached;

        if (changed) {
            for (const pass of this._down) this._camera.detachPostProcess(pass);
            for (const pass of this._up) this._camera.detachPostProcess(pass);
            this._camera.detachPostProcess(this._shafts);
            this._camera.detachPostProcess(this._finish);
            this._camera.detachPostProcess(this._dof);
            this._camera.detachPostProcess(this._taa);
            this._camera.detachPostProcess(this._ssr);
            this._camera.detachPostProcess(this._composite);
        }

        this._attached = wantPost;
        this._bloomAttached = wantBloom;
        this._shaftsAttached = wantShafts;
        this._finishAttached = wantFinish;
        this._dofAttached = wantDof;
        // Coming on means the history is a texture full of an old frame, or of nothing.
        if (wantTaa && !this._taaAttached) this._taaReset = true;
        this._taaAttached = wantTaa;
        this._ssrAttached = wantSsr;
        // The one texture everything downstream needs a handle on. Order of preference is
        // chain order, so this stays true as passes come and go.
        this._first = wantBloom ? this._down[0] : wantShafts ? this._shafts : wantDof ? this._dof : wantSsr ? this._ssr : this._composite;

        // Unconditionally, even when the chain is unchanged: construction attaches
        // everything before this runs for the first time, so the very first call has
        // nothing to detach and would otherwise leave the clears wrong for the whole
        // session — the one case where getting it wrong costs the entire picture.
        // Everything downstream of the first pass receives a fullscreen triangle with no
        // depth test, so it has nothing to clear and skipping it is free.
        for (const pass of this._down) pass.autoClear = false;
        for (const pass of this._up) pass.autoClear = false;
        this._shafts.autoClear = false;
        this._finish.autoClear = false;
        this._dof.autoClear = false;
        this._taa.autoClear = false;
        this._ssr.autoClear = false;
        this._composite.autoClear = false;
        this._first.autoClear = true;
        // Always explicit now: the composite names the scene through `_first` in every
        // configuration, so there is no arrangement of toggles where the chain's automatic
        // binding is the one that happens to be right.
        this._composite.externalTextureSamplerBinding = true;

        if (!wantPost || !changed) return;

        if (wantBloom) {
            for (const pass of this._down) this._camera.attachPostProcess(pass);
            for (const pass of this._up) this._camera.attachPostProcess(pass);
        }
        // After the pyramid and before the composite. Position in the chain is almost
        // irrelevant to this pass — it reads the scene explicitly — but it must be
        // somewhere, and here it is next to the thing that consumes it.
        if (wantShafts) this._camera.attachPostProcess(this._shafts);
        if (wantDof) this._camera.attachPostProcess(this._dof);
        if (wantSsr) this._camera.attachPostProcess(this._ssr);
        this._camera.attachPostProcess(this._composite);
        if (wantTaa) this._camera.attachPostProcess(this._taa);
        if (wantFinish) this._camera.attachPostProcess(this._finish);
    }

    /** The depth pass, once it exists. Built after this one, because it needs the meshes. */
    /**
     * The heat field the shimmer refracts through, and the window it is stored in.
     *
     * Taken as two narrow interfaces rather than as Fire and Substrate: the composite needs
     * one texture and four numbers, and nothing about this pass should have an opinion on
     * combustion.
     */
    /**
     * The element's surface constants, for the reflection pass.
     *
     * Narrow on purpose, like HeatSource: the reflection needs two numbers to reconstruct
     * the roughness the terrain computed, and nothing here should have to know what an
     * element registry is.
     */
    setSurface(surface: SurfaceSource): void {
        this._surface = surface;
    }

    setHeat(fire: HeatSource, window: HeatWindow): void {
        this._fire = fire;
        this._window = window;
    }

    setDepth(depth: Depth): void {
        this._depth = depth;
        // AND RESYNC. Depth of field cannot be in the chain until there is a depth buffer
        // to read, so the constructor necessarily decided against it; without this line it
        // never reconsiders, and the pass silently does nothing for the whole session.
        this._sync();
    }

    /**
     * Waits for every pass to compile.
     *
     * Rule 2: behind the loading screen, not on the first visible frame. A composite that
     * compiles late shows an untonemapped frame, which at this project's exposures is a
     * white rectangle.
     */
    /**
     * Advances the grain's clock.
     *
     * SIMULATION seconds, handed in from the frame loop, so a paused world has a still
     * grain. Wall time would be the obvious choice and would quietly break every A/B
     * measurement in this phase: two captures of an identical build would differ, and the
     * pixel diff is the instrument that has caught every real Phase 9 bug.
     */
    update(dt: number, focusDistance: number): void {
        this._time += dt;
        // Zero means "focus on the subject", which is what a camera operator does. The
        // setting overrides it for anyone who wants to rack focus by hand.
        const manual = this._settings.v["post.dofFocus"] as number;
        this._focus = manual > 0 ? manual : focusDistance;
    }

    /**
     * Nudges the projection by less than a pixel, so consecutive frames sample the scene at
     * different points inside the same pixel. That offset IS the supersample; everything
     * the resolve does afterwards is just averaging it.
     *
     * ITS PLACE IN THE FRAME IS LOAD-BEARING, AND IT IS NARROWER THAN IT LOOKS. This has to
     * happen AFTER shadows.update() and BEFORE depth.update(), and both halves were paid
     * for. It started inside update(), which is early in the frame and seemed obviously
     * safe; the frame then rendered with no jitter at all, because shadows.update() draws
     * the cascade targets and Babylon's ObjectRenderer.initRender calls
     * `getProjectionMatrix(TRUE)` to restore the camera afterwards — a forced recompute
     * that rebuilds the matrix from the field of view and throws the jitter away. Nothing
     * reports this. TAA went on subtracting a jitter that was never applied, and the only
     * symptom was a uniform subpixel error in the reprojection, which is why _probeJitter()
     * below is permanent.
     *
     * The other side is depth.update(), which pushes this matrix to the depth pass — the
     * buffer TAA reprojects with. Jitter after that and colour and depth sample the world
     * half a pixel apart, which reads as a permanently soft image with nothing to blame.
     *
     * SET, NOT ADD. Row 2's first two entries are exactly zero in an unjittered perspective
     * matrix, which is what makes writing them idempotent — and idempotence is required,
     * because Babylon hands back a CACHED matrix. Adding an offset per frame would
     * accumulate into a permanent skew inside a second.
     */
    jitter(): void {
        if (!this._taaAttached) {
            // Hand the matrix back. Leaving it frozen would pin the projection at whatever
            // field of view was current when TAA was switched off, and the fov slider would
            // silently stop working — a far worse bug than the one freezing solves.
            if (this._frozen) {
                this._frozen = false;
                this._jitterX = 0;
                this._jitterY = 0;
                this._camera.unfreezeProjectionMatrix();
                this._camera.getProjectionMatrix(true);
            }
            return;
        }

        // FREEZING IS THE MECHANISM, and ordering alone was not enough. Writing the jitter
        // into Babylon's cached matrix is a bet that nothing rebuilds it before the draw,
        // and that bet loses twice a frame: the shadow cascades restore the camera with
        // `getProjectionMatrix(true)`, and so does at least one render target inside
        // scene.render(). A forced rebuild reconstructs the matrix from the field of view
        // and the jitter is simply gone, with nothing anywhere to say so.
        //
        // `freezeProjectionMatrix` is the supported way to say "this matrix is mine now":
        // the flag it sets is tested BEFORE the force flag, so a forced rebuild becomes a
        // no-op rather than a fight. So each frame the matrix is handed back, rebuilt clean
        // from the current field of view, stamped, and taken over again — which also means
        // the fov slider keeps working, because the rebuild is where it gets read.
        this._camera.unfreezeProjectionMatrix();
        const proj = this._camera.getProjectionMatrix(true);

        this._frame = (this._frame + 1) % TAA_SAMPLES;
        const engine = this._scene.getEngine();
        // Halton is 0..1 across the pixel; NDC spans 2 across the frame, so a pixel is 2/w.
        this._jitterX = ((halton(this._frame + 1, 2) - 0.5) * 2) / engine.getRenderWidth(true);
        this._jitterY = ((halton(this._frame + 1, 3) - 0.5) * 2) / engine.getRenderHeight(true);
        proj.setRowFromFloats(2, this._jitterX, this._jitterY, proj.m[10], proj.m[11]);

        this._camera.freezeProjectionMatrix();
        this._frozen = true;
    }

    /**
     * Ends the frame: this frame's resolve becomes next frame's history, and this frame's
     * camera becomes next frame's reprojection.
     *
     * AFTER scene.render(), where nothing is bound. The blit binds its own framebuffer, and
     * issuing it between two passes of the chain would do that in the middle of someone
     * else's render pass.
     */
    private _store(): void {
        if (!this._taaAttached) return;
        const src = this._finish.inputTexture;
        if (!src || !src.texture) return;
        // The copy has its own shader and it is not ready on the first frames. Presenting
        // one more frame without history is correct; blending against a texture that was
        // never written is a dark ghost that takes a second to fade.
        if (!this._copy.isReady()) {
            this._taaReset = true;
            return;
        }
        if (this._history.getSize().width !== src.width || this._history.getSize().height !== src.height) {
            // The window changed. A same-size blit is the fast path precisely because it
            // refuses to scale, so the buffer is rebuilt and one frame goes out without
            // history rather than stretched.
            this._history.dispose();
            this._history = this._makeHistory(src.width, src.height);
            this._taaReset = true;
            return;
        }
        this._copy.copy(src.texture, this._history);
        this._prevVP.copyFrom(this._camera.getTransformationMatrix());
        this._prevJitterX = this._jitterX;
        this._prevJitterY = this._jitterY;
    }

    /**
     * Reports whether the jitter this class applied is the jitter the frame was rendered
     * with.
     *
     * A BOOT PROBE, and it is the house pattern for exactly this shape of problem. The
     * jitter is written into Babylon's CACHED projection matrix, which is a bet: that
     * nothing between here and the draw recomputes it. If that bet loses, the frame renders
     * unjittered, TAA still subtracts a jitter that was never applied, and the result is a
     * uniform subpixel offset in the reprojection — which is exactly what the motion probe
     * measured. Read the matrix back mid-render and the question is answered rather than
     * argued about.
     */
    private _probeJitter(): void {
        const m = this._camera.getProjectionMatrix().m;
        const px = this._scene.getEngine().getRenderWidth(true) * 0.5;
        // A thousandth of a pixel. The matrix is a Float32Array and the jitter is a double,
        // so an exact comparison fails on rounding alone — which it duly did, and reported
        // a wipe that had not happened.
        const applied = Math.abs(m[8] - this._jitterX) * px < 1e-3 && Math.abs(m[9] - this._jitterY) * px < 1e-3;
        console.info(
            `[substrate] taa jitter: wrote (${(this._jitterX * px).toFixed(3)}, ${(this._jitterY * px).toFixed(3)}) px, matrix holds (${(m[8] * px).toFixed(3)}, ${(m[9] * px).toFixed(3)}) px ` +
                `${applied ? "(survived to the draw)" : "*** WIPED — something recomputed the projection after the jitter ***"}`,
        );
    }

    private _makeHistory(width: number, height: number): RenderTargetTexture {
        const rt = new RenderTargetTexture("substrateHistory", { width, height }, this._scene, {
            generateMipMaps: false,
            type: Constants.TEXTURETYPE_HALF_FLOAT,
            samplingMode: Constants.TEXTURE_BILINEAR_SAMPLINGMODE,
            // Nothing ever depth-tests into this. It is a blit target.
            generateDepthBuffer: false,
            generateStencilBuffer: false,
        });
        // CLAMP, and load-bearing rather than tidy: reprojection routinely lands outside
        // the frame, and a wrapping history answers with the opposite edge — a thin band of
        // the wrong side of the screen smeared along every border.
        rt.wrapU = Constants.TEXTURE_CLAMP_ADDRESSMODE;
        rt.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
        return rt;
    }

    async prepare(): Promise<void> {
        for (let i = 0; i < 240 && !this.compiled; i++) {
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
    }

    /**
     * Reports the pyramid the driver actually built.
     *
     * A BOOT PROBE, and it earns its place. `size` on a PostProcess is a ratio, but the
     * code that turns it into pixels reads `sourceTexture.width * ratio` when there is a
     * source and the render width otherwise — so whether 1/4 means a quarter of the frame
     * or a quarter of the level above it is a question about Babylon's chain plumbing,
     * not about this file. Guess wrong and every level collapses toward one texel: the
     * bloom still renders, still looks like a soft glow, and is wrong in a way no
     * screenshot shows. So it prints the sizes and lets them be read.
     */
    private _probe(): void {
        const w = this._scene.getEngine().getRenderWidth(true);
        const shape = this._down.map((p) => `${p.width}x${p.height}`).join(" -> ");
        const halved = this._down.every((p, i) => Math.abs(p.width - w / 2 ** (i + 1)) <= 1);
        console.info(`[substrate] bloom pyramid: ${w} -> ${shape} ${halved ? "(halving as intended)" : "*** NOT HALVING — size is relative to the source, not the frame ***"}`);
    }

    dispose(): void {
        if (this._frozen) {
            this._frozen = false;
            this._camera.unfreezeProjectionMatrix();
            this._camera.getProjectionMatrix(true);
        }
        for (const off of this._disposers) off();
        this._disposers.length = 0;
        for (const pass of this._down) pass.dispose();
        for (const pass of this._up) pass.dispose();
        this._shafts.dispose();
        this._finish.dispose();
        this._dof.dispose();
        this._taa.dispose();
        this._ssr.dispose();
        this._history.dispose();
        this._copy.dispose();
        this._composite.dispose();
    }
}
