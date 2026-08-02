import { ProceduralTexture } from "@babylonjs/core/Materials/Textures/Procedurals/proceduralTexture";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Constants } from "@babylonjs/core/Engines/constants";
import { Vector2 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";
import type { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Settings } from "../core/settings";
import type { ElementDef } from "../elements/types";
import { nextFrame } from "../core/loading";
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
            this._pushUniforms(element);

            for (let guard = 0; guard < 600 && !this.texture.isReady(); guard++) {
                await nextFrame();
            }
            this.texture.render();
            report?.(0.08);

            if (!this._flipDetected) {
                await this._detectReadbackOrientation();
                this._flipDetected = true;
            }
            report?.(0.15);

            await this._refreshMirror(report);
            this._mirrorValid = true;
        } finally {
            this._baking = false;
        }
    }

    private _flipDetected = false;

    /** Height in metres, matching sbSampleField in the shared include. */
    sampleHeight(x: number, z: number): number {
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
        return (top + (bottom - top) * fz) * this._settings.v["terrain.heightScale"];
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
        this.texture.dispose();
    }

    // -- internals -----------------------------------------------------------

    private _pushUniforms(element: ElementDef): void {
        const t = element.terrain;
        const bearing = this._settings.v["world.windBearing"] * (Math.PI / 180);
        const tex = this.texture;

        tex.setVector2("bkOrigin", this._origin);
        tex.setFloat("bkExtent", FIELD_EXTENT);
        tex.setVector2("bkWind", new Vector2(Math.sin(bearing), Math.cos(bearing)));
        tex.setFloat("bkSeed", this._settings.v["world.seed"]);

        tex.setFloat("bkSwellAmp", t.swellAmp);
        tex.setFloat("bkSwellFreq", t.swellFreq);
        tex.setFloat("bkDuneAmp", t.duneAmp);
        tex.setFloat("bkDuneFreq", t.duneFreq);
        tex.setFloat("bkDuneStretch", t.duneStretch);
        tex.setFloat("bkDuneOctaves", t.duneOctaves);
        tex.setFloat("bkShearAmp", t.shearAmp);
        tex.setFloat("bkShearFreq", t.shearFreq);
        tex.setFloat("bkDetailAmp", t.detailAmp);
        tex.setFloat("bkDetailFreq", t.detailFreq);
        tex.setFloat("bkDamping", t.damping);
        tex.setFloat("bkRidgeAmp", t.ridgeAmp);
        tex.setFloat("bkRidgeFreq", t.ridgeFreq);
        tex.setFloat("bkOutcropAmp", t.outcropAmp);
        tex.setFloat("bkOutcropFreq", t.outcropFreq);
        tex.setFloat("bkOutcropThreshold", t.outcropThreshold);
        tex.setFloat("bkChannelDepth", t.channelDepth);
        tex.setFloat("bkChannelFreq", t.channelFreq);
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
