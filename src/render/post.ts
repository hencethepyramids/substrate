import { PostProcess } from "@babylonjs/core/PostProcesses/postProcess";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Constants } from "@babylonjs/core/Engines/constants";
import type { Scene } from "@babylonjs/core/scene";
import type { Camera } from "@babylonjs/core/Cameras/camera";
import type { Settings } from "../core/settings";
import { TONEMAPS } from "../core/settings";
import composite from "../shaders/composite.fragment.wgsl?raw";

/**
 * The post chain, and — for pass A — the reason there is one at all.
 *
 * WHAT MOVED. Until now every material ended with `sbDisplay`: tonemap, gamma, done. That
 * is a fine arrangement right up until something wants to read the image back, and then
 * it is a trap, because a display-referred pixel has thrown away the one number an effect
 * needs. AgX maps a scene-referred 17 and a scene-referred 3 to roughly the same bright
 * grey. Bloom on that grey cannot tell the sun glitter from a pale rock, so it blooms both
 * or neither. Every effect Phase 9 owes — bloom, shafts, DoF, TAA — has the same appetite,
 * so the fix is one fix: keep radiance linear until the very end.
 *
 * So the frame now renders into a HALF-FLOAT target and this pass applies the curve once.
 * Babylon picks the scene target's format from the FIRST post process in the camera's
 * chain, which is why `textureType` below is load-bearing rather than decorative — set it
 * to the default 8-bit and the HDR range is gone before the composite ever sees it, with
 * no error anywhere to say so.
 *
 * WHAT THIS COSTS, honestly: a fullscreen half-float target and one extra fullscreen pass.
 * At 1440p that is about 16 MB and a blit. It buys back the ability for anything
 * downstream to work in the space light actually lives in.
 *
 * WHAT IS NOT HERE YET. Bloom, shafts, DoF, SSR, heat distortion, TAA, sharpen, grain and
 * vignette all still have toggles in the schema with nothing behind them. Pass A is the
 * plumbing only, and its success condition is deliberately boring: the picture must not
 * change. Anything that shifts on opaque geometry is a bug in the move, not a feature.
 */
export class Post {
    private readonly _settings: Settings;
    private readonly _composite: PostProcess;
    private readonly _camera: Camera;
    private readonly _disposers: (() => void)[] = [];
    private _attached = true;

    /** True once the composite's pipeline has actually compiled. */
    get compiled(): boolean {
        return this._composite.isReady();
    }

    constructor(scene: Scene, settings: Settings, camera: Camera) {
        this._settings = settings;

        // Babylon addresses shaders in its store by `<name>PixelShader`, and takes the
        // bare name in the constructor. Registering here rather than in lib/register.ts
        // because this is a whole shader, not a shared include.
        ShaderStore.ShadersStoreWGSL["substrateCompositePixelShader"] = composite;

        this._composite = new PostProcess("substrateComposite", "substrateComposite", {
            uniforms: ["sbTonemapMode"],
            size: 1.0,
            camera,
            samplingMode: Constants.TEXTURE_BILINEAR_SAMPLINGMODE,
            engine: scene.getEngine(),
            reusable: false,
            // The whole point. See above.
            textureType: Constants.TEXTURETYPE_HALF_FLOAT,
            shaderLanguage: ShaderLanguage.WGSL,
        });

        this._camera = camera;
        this._composite.onApply = (effect) => {
            effect.setFloat("sbTonemapMode", Math.max(0, TONEMAPS.indexOf(this._settings.v["post.tonemap"] as (typeof TONEMAPS)[number])));
        };

        // Rule 3. Off is not a cosmetic setting here — it detaches the only thing applying
        // the display transform, so the frame arrives raw and every scene-referred value
        // above 1 clips to white. That is the point: it is the picture the materials
        // actually produce, and being able to see it is how you tell a blown highlight
        // from a tonemap that is doing its job.
        this._disposers.push(settings.on("sys.post", () => this._sync()));
        this._sync();
    }

    private _sync(): void {
        const want = this._settings.v["sys.post"] as boolean;
        if (want === this._attached) return;
        this._attached = want;
        if (want) this._camera.attachPostProcess(this._composite);
        else this._camera.detachPostProcess(this._composite);
    }

    /**
     * Waits for the composite to compile.
     *
     * Rule 2: behind the loading screen, not on the first visible frame. A post process
     * that compiles late shows an untonemapped frame, which at this project's exposures
     * is a white rectangle.
     */
    async prepare(): Promise<void> {
        for (let i = 0; i < 240 && !this._composite.isReady(); i++) {
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
    }

    dispose(): void {
        for (const off of this._disposers) off();
        this._disposers.length = 0;
        this._composite.dispose();
    }
}
