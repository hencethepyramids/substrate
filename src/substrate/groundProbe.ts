import { ProceduralTexture } from "@babylonjs/core/Materials/Textures/Procedurals/proceduralTexture";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Constants } from "@babylonjs/core/Engines/constants";
import { Vector2 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";
import type { Settings } from "../core/settings";
import type { Substrate } from "./substrate";

/**
 * A small window of the substrate, on the CPU, so the character can stand on the ground
 * it has actually carved rather than on the one underneath it.
 *
 * The depression lives in a GPU buffer and the gait runs on the CPU, and until this
 * existed the two disagreed: feet planted on the undisturbed heightfield while the print
 * they had just made was drawn several centimetres below the boot standing in it.
 *
 * THE OBVIOUS FIX IS THE WRONG ONE. Keeping a CPU-side copy of the stamps and decaying
 * them to approximate the relaxation would put a second, simpler physics next to the real
 * one, and the two would agree at first and drift for ever after — the exact
 * self-consistent-but-wrong shape this project keeps finding. So there is no second
 * model. This renders a tile THROUGH THE SAME `substrateBuffer` INCLUDE the terrain
 * shades with, and reads that back. One source of truth, sampled twice.
 *
 * The readback is asynchronous and self-throttling: a new one starts only when the last
 * has landed, so a slow frame costs latency rather than a stall. Latency is what the
 * character can afford — the tile is anchored in WORLD space and carries its own origin,
 * so a frame-old tile is read at the correct place and is merely a frame less deep.
 *
 * Allocation-free after the first readback.
 */

/**
 * Texels per side. At the substrate's own 6.25 cm this is four metres, which covers both
 * feet plus the furthest a swinging foot is ever predicted to land — one sprint stride,
 * 1.5 m — with room to spare. 64 KB a readback.
 */
const TILE = 64;

const SOURCE = `
#include<substrateBuffer>
varying vUV: vec2f;
uniform gpOrigin: vec2f;
uniform gpSpan: f32;
@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let p = uniforms.gpOrigin + input.vUV * uniforms.gpSpan;
    let s = sbSubstrateAt(p);
    // The world position rides out in gb, exactly as the boot probe's does, so the CPU
    // can CHECK the row order it assumed rather than assume it. A flip here would put
    // every footfall in a hole mirrored about the tile's centre, which is precisely the
    // class of bug that has cost this project the most.
    fragmentOutputs.color = vec4f(s.depression, p.x, p.y, s.mass);
}`;

export class GroundProbe {
    /** True once a tile has landed and its layout has been checked. */
    valid = false;
    /**
     * Round trip from render to landed, milliseconds, smoothed.
     *
     * Worth exposing rather than assuming: it is the age of what the character is standing
     * on, and at a sprint the whole contact is only 78 ms, so whether this is two frames
     * or ten decides whether a foot can keep up with its own print.
     */
    latencyMs = 0;

    private readonly _settings: Settings;
    private readonly _substrate: Substrate;
    private readonly _scene: Scene;

    private _target: ProceduralTexture | null = null;
    private _data: Float32Array | null = null;
    private _pending = false;
    private _checked = false;

    /** Where the tile in `_data` starts, and its texel size. World metres. */
    private _dataOriginX = 0;
    private _dataOriginZ = 0;
    private _dataTexel = 0;

    /** Where the tile currently being rendered starts. */
    private readonly _origin = new Vector2(0, 0);
    private _texel = 0;

    constructor(scene: Scene, settings: Settings, substrate: Substrate) {
        this._scene = scene;
        this._settings = settings;
        this._substrate = substrate;
    }

    /**
     * Render this frame's tile and, if the last readback has landed, start another.
     *
     * @param x world position to centre on — the character.
     */
    update(x: number, z: number): void {
        const s = this._settings.v;
        if (!s["sys.substrate"] || !s["sys.character"]) {
            this.valid = false;
            this._data = null;
            return;
        }

        // Snapped to the substrate's own texel grid, so the tile samples texel centres
        // rather than resampling a grid that slides under it every frame.
        this._texel = s["substrate.extent"] / s["substrate.resolution"];
        const span = TILE * this._texel;
        this._origin.set(Math.floor((x - span * 0.5) / this._texel) * this._texel, Math.floor((z - span * 0.5) / this._texel) * this._texel);

        const target = this._ensure();
        this._substrate.bindTo(target);
        this._substrate.pushTo(target);
        target.setVector2("gpOrigin", this._origin);
        target.setFloat("gpSpan", span);
        // NOT BEFORE THE EFFECT EXISTS. This is created on the first frame and its shader
        // compiles asynchronously; rendering it in between throws out of the frame loop
        // and takes the whole simulation with it. Uniforms are set either way, so the
        // first real render has them.
        if (!target.isReady()) return;
        target.render();

        if (this._pending) return;
        this._pending = true;
        const originX = this._origin.x;
        const originZ = this._origin.y;
        const texel = this._texel;
        // readPixels itself can decline, not just resolve to nothing — a target with no
        // internal texture yet returns null rather than a promise.
        const read = target.readPixels();
        if (read === null) {
            this._pending = false;
            return;
        }
        const sent = performance.now();
        read
            .then((pixels) => {
                this._pending = false;
                const took = performance.now() - sent;
                this.latencyMs = this.latencyMs === 0 ? took : this.latencyMs * 0.9 + took * 0.1;
                if (pixels === null) return;
                const data = pixels as Float32Array;
                if (data.length < TILE * TILE * 4) return;
                this._data = data;
                this._dataOriginX = originX;
                this._dataOriginZ = originZ;
                this._dataTexel = texel;
                if (!this._checked) this._check();
                this.valid = true;
            })
            .catch(() => {
                this._pending = false;
            });
    }

    /**
     * How far the ground has been carved down at a world position, in metres.
     *
     * Zero outside the tile, which cannot happen for a foot: the tile is recentred on the
     * character every frame and reaches two metres in every direction.
     */
    depressionAt(x: number, z: number): number {
        const data = this._data;
        if (data === null) return 0;
        const fx = (x - this._dataOriginX) / this._dataTexel - 0.5;
        const fz = (z - this._dataOriginZ) / this._dataTexel - 0.5;
        if (fx < 0 || fz < 0 || fx > TILE - 1 || fz > TILE - 1) return 0;
        const x0 = Math.floor(fx);
        const z0 = Math.floor(fz);
        const tx = fx - x0;
        const tz = fz - z0;
        const x1 = Math.min(x0 + 1, TILE - 1);
        const z1 = Math.min(z0 + 1, TILE - 1);
        const a = data[(z0 * TILE + x0) * 4];
        const b = data[(z0 * TILE + x1) * 4];
        const c = data[(z1 * TILE + x0) * 4];
        const d = data[(z1 * TILE + x1) * 4];
        return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
    }

    dispose(): void {
        this._target?.dispose();
        this._target = null;
        this._data = null;
    }

    private _ensure(): ProceduralTexture {
        if (this._target !== null) return this._target;
        const target = new ProceduralTexture(
            "substrateGroundProbe",
            { width: TILE, height: TILE },
            { fragmentSource: SOURCE },
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
        // Driven by hand, like every other target in this project.
        target.refreshRate = 0;
        this._target = target;
        return target;
    }

    /**
     * Confirm the row order this class assumes against the world position the shader put
     * in each texel. Once, on the first tile that lands.
     *
     * The heightfield's Z mirror and the sky LUT's v flip were both this bug and both
     * survived a whole phase, because a flipped buffer is perfectly self-consistent. Here
     * it would put every footfall in a hole mirrored about the tile's centre — the
     * character stepping into a print two metres behind the one it just made.
     */
    private _check(): void {
        this._checked = true;
        const data: Float32Array | null = this._data;
        if (data === null) return;
        let worst = 0;
        for (const [col, row] of [
            [0, 0],
            [TILE - 1, 0],
            [0, TILE - 1],
            [TILE - 1, TILE - 1],
        ]) {
            const i = (row * TILE + col) * 4;
            const wantX = this._dataOriginX + (col + 0.5) * this._dataTexel;
            const wantZ = this._dataOriginZ + (row + 0.5) * this._dataTexel;
            worst = Math.max(worst, Math.abs(data[i + 1] - wantX), Math.abs(data[i + 2] - wantZ));
        }
        if (worst > this._dataTexel) {
            console.error(`[substrate] ground probe layout is wrong by ${worst.toFixed(2)} m — the character will step into holes it did not make`);
        } else {
            console.info(`[substrate] ground probe: tile reads where it says it does (error ${(worst * 100).toFixed(2)} cm, texel ${(this._dataTexel * 100).toFixed(2)} cm)`);
        }
    }
}
