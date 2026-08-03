import { ProceduralTexture } from "@babylonjs/core/Materials/Textures/Procedurals/proceduralTexture";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Constants } from "@babylonjs/core/Engines/constants";
import { Vector2 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";
import type { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Settings } from "../core/settings";
import type { ElementDef } from "../elements/types";
import { nextFrame } from "../core/loading";
import { pushTerrainParams } from "./terrainParams";
import bakeSource from "../shaders/terrainBake.fragment.wgsl?raw";

/**
 * The baked heightfield: 4096x4096 RG32F, R = height in metres, G = packed analytic
 * derivative, covering a 2048 m square at 0.5 m per texel.
 *
 * The GPU draws this field through the shared include in shaders/lib/terrainField.wgsl.
 * This class keeps a CPU mirror of the height channel and reproduces that include's
 * bilinear filter exactly, so character grounding stands on the surface that is
 * actually drawn rather than on a second, slightly different, analytic evaluation.
 */

const FIELD_SIZE = 4096;
const FIELD_EXTENT = 2048;
/** 4096 rows in 8 passes. One 134 MB transfer would exceed the default buffer limits. */
const READBACK_ROWS = 512;

/** Detects whether readPixels hands back rows top-down or bottom-up. */
const PROBE_SOURCE = `
varying vUV: vec2f;
@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    fragmentOutputs.color = vec4f(input.vUV.y, 0.0, 0.0, 1.0);
}`;

/**
 * The verification probe. Reports three numbers per texel, which between them pin
 * down every orientation question this file has:
 *
 *   r  what the GPU reads out of the BAKED FIELD, through the exact include the
 *      terrain vertex shader uses
 *   g  what sbTerrainD says at the same place, evaluated directly
 *   b  the world coordinate it was taken at
 *
 * r vs g scores the bake's own orientation — the invariant that the field IS the
 * function, which nothing checked before and which Phase 2's far-range raymarch
 * depends on absolutely. r vs the CPU mirror scores grounding. And carrying the
 * coordinate in b means matching texels to world positions needs no assumption
 * about which way readPixels orders its rows.
 *
 * Samples an oblique line (z = 0.37x) so that a whole-field Z flip changes the
 * answer — along an axis-aligned line it would not.
 */
const VERIFY_SOURCE = `
#include<substrateNoise>
#include<substrateHeightfield>
#include<substrateTerrainParams>
#include<substratePack>
#include<substrateTerrainField>
varying vUV: vec2f;
uniform vfOrigin: f32;
uniform vfExtent: f32;
@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let t = uniforms.vfOrigin + input.vUV.x * uniforms.vfExtent;
    let p = vec2f(t, t * 0.37);
    let baked = sbSampleField(p);
    let truth = sbTerrainD(p, sbTerrainParams());
    fragmentOutputs.color = vec4f(baked.x, truth.x, t, 1.0);
}`;

/** Texels across the probe. */
const PROBE_WIDTH = 64;

export class Heightfield {
    readonly size = FIELD_SIZE;
    readonly extent = FIELD_EXTENT;
    readonly originX = -FIELD_EXTENT / 2;
    readonly originZ = -FIELD_EXTENT / 2;

    readonly texture: ProceduralTexture;

    /** Height channel, row-major, row index increasing with world Z. */
    private readonly _heights = new Float32Array(FIELD_SIZE * FIELD_SIZE);
    private readonly _origin = new Vector2(-FIELD_EXTENT / 2, -FIELD_EXTENT / 2);
    private readonly _scene: Scene;
    private readonly _settings: Settings;
    private _flipReadback = false;
    private _mirrorValid = false;
    private _baking = false;

    /** Texels per metre, used by both the sampler and the CPU gradient. */
    private readonly _texelsPerMetre = FIELD_SIZE / FIELD_EXTENT;

    constructor(scene: Scene, settings: Settings) {
        this._scene = scene;
        this._settings = settings;

        this.texture = new ProceduralTexture(
            "terrainField",
            FIELD_SIZE,
            { fragmentSource: bakeSource },
            scene,
            {
                shaderLanguage: ShaderLanguage.WGSL,
                format: Constants.TEXTUREFORMAT_RG,
                type: Constants.TEXTURETYPE_FLOAT,
                samplingMode: Constants.TEXTURE_NEAREST_SAMPLINGMODE,
                generateMipMaps: false,
                // Nothing else should ever render this. It is driven by hand.
                skipSceneRegistration: true,
            },
        );
        this.texture.refreshRate = 0;
        this.texture.wrapU = Constants.TEXTURE_CLAMP_ADDRESSMODE;
        this.texture.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
    }

    get mirrorValid(): boolean {
        return this._mirrorValid;
    }

    get baking(): boolean {
        return this._baking;
    }

    /**
     * Render the field and refresh the CPU mirror.
     *
     * @param report optional 0..1 progress, so the loading screen can show the
     *               readback rather than appearing to hang on it.
     */
    async bake(element: ElementDef, report?: (fraction: number) => void): Promise<void> {
        this._baking = true;
        try {
            this._pushUniforms(this.texture, element);

            for (let guard = 0; guard < 600 && !this.texture.isReady(); guard++) {
                await nextFrame();
            }

            if (!this._bakeFlipResolved) {
                await this._resolveBakeOrientation(element);
                this._bakeFlipResolved = true;
            }
            this.texture.setFloat("bkFlipV", this._bakeFlipV);
            this.texture.render();
            report?.(0.08);

            if (!this._flipDetected) {
                await this._detectReadbackOrientation();
                this._flipDetected = true;
            }
            report?.(0.15);

            await this._refreshMirror(report);
            this._mirrorValid = true;
            await this._verifyMirror(element);
        } finally {
            this._baking = false;
        }
    }

    private _flipDetected = false;
    private _bakeFlipResolved = false;
    private _bakeFlipV = 0;

    /** Height in metres, matching sbSampleField in the shared include. */
    sampleHeight(x: number, z: number): number {
        return this._sampleRaw(x, z) * this._settings.v["terrain.heightScale"];
    }

    /** Unscaled bilinear lookup. The verification pass compares against this. */
    private _sampleRaw(x: number, z: number): number {
        if (!this._mirrorValid) return 0;

        const tx = (x - this.originX) * this._texelsPerMetre - 0.5;
        const tz = (z - this.originZ) * this._texelsPerMetre - 0.5;
        const ix = Math.floor(tx);
        const iz = Math.floor(tz);
        const fx = tx - ix;
        const fz = tz - iz;

        const h = this._heights;
        const m = FIELD_SIZE - 1;
        const x0 = clampInt(ix, 0, m);
        const x1 = clampInt(ix + 1, 0, m);
        const z0 = clampInt(iz, 0, m) * FIELD_SIZE;
        const z1 = clampInt(iz + 1, 0, m) * FIELD_SIZE;

        const h00 = h[z0 + x0];
        const h10 = h[z0 + x1];
        const h01 = h[z1 + x0];
        const h11 = h[z1 + x1];

        const top = h00 + (h10 - h00) * fx;
        const bottom = h01 + (h11 - h01) * fx;
        return top + (bottom - top) * fz;
    }

    /**
     * Normal of the drawn surface. Taken as the gradient of the bilinear field rather
     * than from the baked analytic derivative on purpose: the geometry the character
     * stands on IS the bilinear interpolation, so this is the normal that keeps a
     * planted foot flush with it.
     */
    sampleNormalInto(x: number, z: number, out: Vector3): void {
        if (!this._mirrorValid) {
            out.set(0, 1, 0);
            return;
        }

        const tx = (x - this.originX) * this._texelsPerMetre - 0.5;
        const tz = (z - this.originZ) * this._texelsPerMetre - 0.5;
        const ix = Math.floor(tx);
        const iz = Math.floor(tz);
        const fx = tx - ix;
        const fz = tz - iz;

        const h = this._heights;
        const m = FIELD_SIZE - 1;
        const x0 = clampInt(ix, 0, m);
        const x1 = clampInt(ix + 1, 0, m);
        const z0 = clampInt(iz, 0, m) * FIELD_SIZE;
        const z1 = clampInt(iz + 1, 0, m) * FIELD_SIZE;

        const h00 = h[z0 + x0];
        const h10 = h[z0 + x1];
        const h01 = h[z1 + x0];
        const h11 = h[z1 + x1];

        const scale = this._settings.v["terrain.heightScale"] * this._texelsPerMetre;
        const dhdx = (h10 - h00 + (h11 - h01 - (h10 - h00)) * fz) * scale;
        const dhdz = (h01 - h00 + (h11 - h10 - (h01 - h00)) * fx) * scale;

        out.set(-dhdx, 1, -dhdz);
        out.normalize();
    }

    dispose(): void {
        this._probe?.dispose();
        this._probe = null;
        this.texture.dispose();
    }

    // -- internals -----------------------------------------------------------

    private _pushUniforms(tex: ProceduralTexture, element: ElementDef): void {
        pushTerrainParams(tex, element, this._settings, this._origin, FIELD_EXTENT);
    }

    /**
     * Renders a 64x64 ramp of vUV.y and reads row 0 back.
     *
     * Texel row 0 is the top of a render target, which is NDC +y, which is vUV.y = 1.
     * If row 0 reads back near 0 instead, readPixels is handing back rows bottom-up
     * and the mirror has to be flipped. Cheaper to measure this once than to reason
     * about it and be wrong: a flipped mirror puts the character underground in one
     * half of the map and in mid-air in the other, which is a miserable bug to chase.
     */
    private async _detectReadbackOrientation(): Promise<void> {
        const probe = new ProceduralTexture(
            "terrainFieldProbe",
            64,
            { fragmentSource: PROBE_SOURCE },
            this._scene,
            {
                shaderLanguage: ShaderLanguage.WGSL,
                format: Constants.TEXTUREFORMAT_RG,
                type: Constants.TEXTURETYPE_FLOAT,
                samplingMode: Constants.TEXTURE_NEAREST_SAMPLINGMODE,
                generateMipMaps: false,
                skipSceneRegistration: true,
            },
        );
        probe.refreshRate = 0;
        try {
            for (let guard = 0; guard < 600 && !probe.isReady(); guard++) {
                await nextFrame();
            }
            probe.render();
            const data = (await probe.readPixels(0, 0, null, true, false, 0, 0, 64, 1)) as Float32Array | null;
            if (data && data.length > 0) {
                const components = data.length / 64;
                const firstRow = data[0];
                // Top row should be ~0.992. Anything below the midpoint means bottom-up.
                this._flipReadback = firstRow < 0.5;
                if (components !== 2) {
                    console.info(`[substrate] readback returns ${components} components per texel`);
                }
            }
        } finally {
            probe.dispose();
        }
    }

    /**
     * Render the probe and read it back. Created once and kept — the orientation
     * resolve alone runs it twice.
     */
    private async _readProbe(element: ElementDef): Promise<Float32Array | null> {
        if (this._probe === null) {
            this._probe = new ProceduralTexture(
                "terrainFieldVerify",
                { width: PROBE_WIDTH, height: 1 },
                { fragmentSource: VERIFY_SOURCE },
                this._scene,
                {
                    shaderLanguage: ShaderLanguage.WGSL,
                    format: Constants.TEXTUREFORMAT_RGBA,
                    type: Constants.TEXTURETYPE_FLOAT,
                    samplingMode: Constants.TEXTURE_NEAREST_SAMPLINGMODE,
                    generateMipMaps: false,
                    skipSceneRegistration: true,
                },
            );
            this._probe.refreshRate = 0;
            this._probe.setTexture("sbFieldTex", this.texture);
            this._probe.setVector2("sbFieldOrigin", this._origin);
            this._probe.setFloat("sbFieldExtent", FIELD_EXTENT);
            this._probe.setFloat("sbFieldSize", FIELD_SIZE);
            // Compare unscaled, so the height slider cannot skew the verdict.
            this._probe.setFloat("sbHeightScale", 1);
            this._probe.setFloat("vfOrigin", this.originX);
            this._probe.setFloat("vfExtent", FIELD_EXTENT);
        }

        const probe = this._probe;
        this._pushUniforms(probe, element);

        for (let guard = 0; guard < 600 && !probe.isReady(); guard++) {
            await nextFrame();
        }
        probe.render();
        return (await probe.readPixels(0, 0, null, true, false, 0, 0, PROBE_WIDTH, 1)) as Float32Array | null;
    }

    /**
     * Decide which way the bake's v axis runs, by measuring the baked field against
     * sbTerrainD itself.
     *
     * This is the invariant nothing checked before: the field IS the function. Get
     * the flip wrong and the whole field is mirrored in Z, which is undetectable by
     * looking — mirrored noise is still noise, the terrain renders perfectly, and
     * the CPU mirror happily re-verifies itself against the wrong surface. It only
     * surfaces in Phase 2's far-range raymarch, which evaluates sbTerrainD directly
     * and would disagree with the clipmap about where the hills are.
     */
    private async _resolveBakeOrientation(element: ElementDef): Promise<void> {
        const scores = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
        for (let flip = 0; flip < 2; flip++) {
            this.texture.setFloat("bkFlipV", flip);
            this.texture.render();
            const data = await this._readProbe(element);
            if (!data) {
                console.warn("[substrate] bake orientation check skipped: no probe data");
                this._bakeFlipV = 0;
                return;
            }
            scores[flip] = fieldVsFunctionError(data);
        }

        this._bakeFlipV = scores[1] < scores[0] ? 1 : 0;

        const best = Math.min(scores[0], scores[1]);
        const worst = Math.max(scores[0], scores[1]);
        console.info(`[substrate] heightfield bake orientation: ${this._bakeFlipV === 0 ? "as written" : "FLIPPED to match the target"} (error ${best.toFixed(4)} m, other orientation ${worst.toFixed(2)} m)`);
        if (best > 0.05) {
            console.warn(`[substrate] baked field still disagrees with sbTerrainD by ${best.toFixed(3)} m — anything that evaluates the function directly will not match the clipmap`);
        }
    }

    /**
     * Check the CPU mirror against the surface the GPU actually draws, and flip it if
     * they disagree.
     *
     * A whole-field Z flip is invisible — noise looks the same mirrored — so the
     * terrain would render perfectly while the character walked through hills,
     * following the right heights from the wrong place. Rather than reason about
     * which way NDC maps to texel rows and be wrong, ask the renderer.
     */
    private async _verifyMirror(element: ElementDef): Promise<void> {
        try {
            const data = await this._readProbe(element);
            if (!data || data.length < PROBE_WIDTH) {
                console.warn("[substrate] mirror verification skipped: no probe data");
                return;
            }
            const components = Math.max(1, Math.round(data.length / PROBE_WIDTH));

            const asRead = this._mirrorError(data, components);
            this._flipMirrorZ();
            const flipped = this._mirrorError(data, components);
            if (asRead <= flipped) this._flipMirrorZ();

            const best = Math.min(asRead, flipped);
            const worst = Math.max(asRead, flipped);
            console.info(`[substrate] height mirror orientation: ${asRead <= flipped ? "as read" : "FLIPPED to match the GPU"} (error ${best.toFixed(4)} m, other orientation ${worst.toFixed(2)} m)`);
            if (best > 0.05) {
                console.warn(`[substrate] mirror still disagrees with the drawn surface by ${best.toFixed(3)} m — grounding will be wrong`);
            }
        } catch (err) {
            console.warn("[substrate] mirror verification failed:", err);
        }
    }

    private _probe: ProceduralTexture | null = null;

    /** Mean absolute disagreement, in metres, between the mirror and the GPU probe. */
    private _mirrorError(data: Float32Array, components: number): number {
        let sum = 0;
        for (let i = 0; i < PROBE_WIDTH; i++) {
            const gpuHeight = data[i * components];
            const t = data[i * components + 2];
            sum += Math.abs(gpuHeight - this._sampleRaw(t, t * 0.37));
        }
        return sum / PROBE_WIDTH;
    }

    /** Reverse the mirror's row order in place. One pass over 67 MB. */
    private _flipMirrorZ(): void {
        const row = new Float32Array(FIELD_SIZE);
        const h = this._heights;
        for (let top = 0, bottom = FIELD_SIZE - 1; top < bottom; top++, bottom--) {
            const a = top * FIELD_SIZE;
            const b = bottom * FIELD_SIZE;
            row.set(h.subarray(a, a + FIELD_SIZE));
            h.copyWithin(a, b, b + FIELD_SIZE);
            h.set(row, b);
        }
    }

    private async _refreshMirror(report?: (fraction: number) => void): Promise<void> {
        const tiles = FIELD_SIZE / READBACK_ROWS;
        for (let tile = 0; tile < tiles; tile++) {
            const y = tile * READBACK_ROWS;
            const data = (await this.texture.readPixels(0, 0, null, true, false, 0, y, FIELD_SIZE, READBACK_ROWS)) as Float32Array | null;
            if (!data) throw new Error("Heightfield readback returned nothing");

            const texels = FIELD_SIZE * READBACK_ROWS;
            const components = Math.max(1, Math.round(data.length / texels));
            const heights = this._heights;

            for (let row = 0; row < READBACK_ROWS; row++) {
                const sourceRow = row * FIELD_SIZE * components;
                // readPixels rows are relative to the requested tile, so flipping has
                // to account for the tile's position in the full image.
                const targetRow = this._flipReadback ? FIELD_SIZE - 1 - (y + row) : y + row;
                const target = targetRow * FIELD_SIZE;
                for (let col = 0; col < FIELD_SIZE; col++) {
                    heights[target + col] = data[sourceRow + col * components];
                }
            }

            report?.(0.15 + 0.85 * ((tile + 1) / tiles));
            // Yield so the loading bar paints between tiles.
            await nextFrame();
        }
    }
}

function clampInt(v: number, lo: number, hi: number): number {
    return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Mean absolute disagreement, in metres, between the baked field and sbTerrainD at
 * the same world positions. Near zero when the bake's orientation is right; several
 * metres when the field is mirrored, because the oblique sample line then lands
 * somewhere else entirely.
 */
function fieldVsFunctionError(data: Float32Array): number {
    const stride = Math.max(1, Math.round(data.length / PROBE_WIDTH));
    let sum = 0;
    for (let i = 0; i < PROBE_WIDTH; i++) {
        sum += Math.abs(data[i * stride] - data[i * stride + 1]);
    }
    return sum / PROBE_WIDTH;
}
