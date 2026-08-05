import { PostProcess } from "@babylonjs/core/PostProcesses/postProcess";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Constants } from "@babylonjs/core/Engines/constants";
import type { Scene } from "@babylonjs/core/scene";
import type { Camera } from "@babylonjs/core/Cameras/camera";
import type { Settings } from "../core/settings";
import { TONEMAPS } from "../core/settings";
import composite from "../shaders/composite.fragment.wgsl?raw";
import bloomDown from "../shaders/bloomDown.fragment.wgsl?raw";
import bloomUp from "../shaders/bloomUp.fragment.wgsl?raw";

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
 * WHAT IS NOT HERE YET: shafts, DoF, SSR, heat distortion, TAA, sharpen, grain, vignette.
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

export class Post {
    private readonly _settings: Settings;
    private readonly _scene: Scene;
    private readonly _composite: PostProcess;
    private readonly _camera: Camera;
    private readonly _down: PostProcess[] = [];
    private readonly _up: PostProcess[] = [];
    private readonly _disposers: (() => void)[] = [];
    // Both start true because construction attaches all of them; _sync() reconciles
    // against the settings on the last line of the constructor.
    private _attached = true;
    private _bloomAttached = true;
    private _probed = false;

    /** True once every pass in the chain has actually compiled. */
    get compiled(): boolean {
        return this._composite.isReady() && this._down.every((p) => p.isReady()) && this._up.every((p) => p.isReady());
    }

    /** Fullscreen passes currently in the chain. Cheap to read, and it is what costs. */
    get passes(): number {
        return (this._attached ? 1 : 0) + (this._bloomAttached ? this._down.length + this._up.length : 0);
    }

    constructor(scene: Scene, settings: Settings, camera: Camera) {
        this._settings = settings;
        this._scene = scene;
        this._camera = camera;

        // Babylon addresses shaders in its store by `<name>PixelShader`, and takes the
        // bare name in the constructor. Registered here rather than in lib/register.ts
        // because these are whole shaders, not shared includes.
        ShaderStore.ShadersStoreWGSL["substrateCompositePixelShader"] = composite;
        ShaderStore.ShadersStoreWGSL["substrateBloomDownPixelShader"] = bloomDown;
        ShaderStore.ShadersStoreWGSL["substrateBloomUpPixelShader"] = bloomUp;

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
                uniforms: ["bmTexel", "bmKaris"],
                size: ratio,
            });
            pass.onApply = (effect) => {
                // The SOURCE texel, which for a downsample is twice this pass's own.
                effect.setFloat2("bmTexel", 1 / Math.max(pass.width * 2, 1), 1 / Math.max(pass.height * 2, 1));
                effect.setFloat("bmKaris", i === 0 ? 1 : 0);
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

        this._composite = new PostProcess("substrateComposite", "substrateComposite", {
            ...common,
            uniforms: ["sbTonemapMode", "cpBloomWeight"],
            samplers: ["cpBloom"],
            size: 1.0,
        });
        this._composite.onApply = (effect) => {
            // Once, on the first frame the pyramid is actually sized. Rule 1 holds: after
            // this the branch is a boolean test.
            if (!this._probed && this._bloomAttached && this._down[0].width > 0) {
                this._probed = true;
                this._probe();
            }
            effect.setFloat("sbTonemapMode", Math.max(0, TONEMAPS.indexOf(this._settings.v["post.tonemap"] as (typeof TONEMAPS)[number])));
            if (this._bloomAttached) {
                // WITH BLOOM, THE CHAIN HANDS US THE WRONG TEXTURE. The pass before the
                // composite is the top of the pyramid, so Babylon's automatic binding
                // would make the bloom the scene. `externalTextureSamplerBinding` turns
                // that off and both textures get named explicitly: the scene is the INPUT
                // of the first downsample, which is the one texture in the chain that is
                // still the frame as rendered.
                effect.setTextureFromPostProcess("textureSampler", this._down[0]);
                effect.setTextureFromPostProcessOutput("cpBloom", this._up[this._up.length - 1]);
                effect.setFloat("cpBloomWeight", Math.min(SCATTER_AT_UNITY * (this._settings.v["post.bloomIntensity"] as number), 0.9));
            } else {
                // Off: the composite is first in the chain, so the automatic binding is
                // right. cpBloom still has to point somewhere legal, and a weight of zero
                // means it never reaches the output.
                effect.setTextureFromPostProcess("cpBloom", this._composite);
                effect.setFloat("cpBloomWeight", 0);
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
        this._sync();
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
        const changed = wantPost !== this._attached || wantBloom !== this._bloomAttached;

        if (changed) {
            for (const pass of this._down) this._camera.detachPostProcess(pass);
            for (const pass of this._up) this._camera.detachPostProcess(pass);
            this._camera.detachPostProcess(this._composite);
        }

        this._attached = wantPost;
        this._bloomAttached = wantBloom;

        // Unconditionally, even when the chain is unchanged: construction attaches
        // everything before this runs for the first time, so the very first call has
        // nothing to detach and would otherwise leave the clears wrong for the whole
        // session — the one case where getting it wrong costs the entire picture.
        // Everything downstream of the first pass receives a fullscreen triangle with no
        // depth test, so it has nothing to clear and skipping it is free.
        for (const pass of this._down) pass.autoClear = false;
        for (const pass of this._up) pass.autoClear = false;
        this._composite.autoClear = false;
        (wantBloom ? this._down[0] : this._composite).autoClear = true;
        this._composite.externalTextureSamplerBinding = wantBloom;

        if (!wantPost || !changed) return;

        if (wantBloom) {
            for (const pass of this._down) this._camera.attachPostProcess(pass);
            for (const pass of this._up) this._camera.attachPostProcess(pass);
        }
        this._camera.attachPostProcess(this._composite);
    }

    /**
     * Waits for every pass to compile.
     *
     * Rule 2: behind the loading screen, not on the first visible frame. A composite that
     * compiles late shows an untonemapped frame, which at this project's exposures is a
     * white rectangle.
     */
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
        for (const off of this._disposers) off();
        this._disposers.length = 0;
        for (const pass of this._down) pass.dispose();
        for (const pass of this._up) pass.dispose();
        this._composite.dispose();
    }
}
