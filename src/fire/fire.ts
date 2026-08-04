import { ProceduralTexture } from "@babylonjs/core/Materials/Textures/Procedurals/proceduralTexture";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Constants } from "@babylonjs/core/Engines/constants";
import { Vector4 } from "@babylonjs/core/Maths/math.vector";
import type { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import type { Scene } from "@babylonjs/core/scene";
import type { WebGPUPerfCounter } from "@babylonjs/core/Engines/WebGPU/webgpuPerfCounter";
import type { Settings } from "../core/settings";
import type { BiomeState } from "../core/biome";
import type { ElementDef } from "../elements/types";
import type { Substrate, SubstrateTarget } from "../substrate/substrate";
import { nextFrame } from "../core/loading";
import { pushFireParams } from "./fireParams";
import stepSource from "../shaders/fireStep.fragment.wgsl?raw";

/**
 * Heat, and the phase change it drives.
 *
 * Ping-ponged on the substrate's own window, like the airborne buffer and for the same
 * reason: heat lives in the ground, the ground carries mass, and the two must agree about
 * where a cell is without either resampling the other.
 *
 * Heat does NOT advect — it is in the material and the material is not going anywhere.
 * That is the whole difference between this pass and the airborne one, and it is why this
 * one needs no Jacobian correction and carries no open-boundary caveat.
 *
 * It writes phase but never the substrate. The relaxation pass mirrors phase across into
 * the A channel, so the ground stays the only thing that writes the ground.
 *
 * Allocation-free after construction.
 */

export const FIRE_SAMPLERS = ["sbFireTex"] as const;

/** Same clamp the other simulations use: a hitch slows the world, it does not lurch it. */
const MAX_STEP = 1 / 30;

export class Fire {
    steps = 0;
    compiled = false;

    private readonly _scene: Scene;
    private readonly _settings: Settings;
    private readonly _substrate: Substrate;
    private readonly _disposers: (() => void)[] = [];

    private readonly _targets: ProceduralTexture[];
    private _front = 0;
    private _size: number;
    private _element: ElementDef;
    private _prepared = false;
    private _cleared = false;

    private readonly _step = new Vector4(0, 0, 0, 0);
    private readonly _source = new Vector4(0, 0, 1, 0);
    /** Frames of source left to apply. An ignition is a press, not a permanent flame. */
    private _sourceFrames = 0;

    constructor(scene: Scene, settings: Settings, biome: BiomeState, substrate: Substrate) {
        this._scene = scene;
        this._settings = settings;
        this._substrate = substrate;
        this._element = biome.current;
        this._size = settings.get("substrate.resolution");

        this._targets = [this._createTarget("fireA"), this._createTarget("fireB")];
        this._targets[0].setTexture("frPrev", this._targets[1]);
        this._targets[1].setTexture("frPrev", this._targets[0]);

        this._disposers.push(biome.onChange((def) => (this._element = def)));
        this._disposers.push(
            settings.on("substrate.resolution", (res) => {
                this._size = res;
                for (const t of this._targets) t.resize(res, false);
                if (this._prepared) this._clear();
            }),
        );
        this._disposers.push(settings.on("substrate.extent", () => this._prepared && this._clear()));
    }

    get ready(): boolean {
        return this._prepared && this._targets[0].isReady() && this._targets[1].isReady();
    }

    /** Rule 7: resolved per call, never cached — the wrapper is replaced on resize. */
    get gpuTime(): WebGPUPerfCounter | undefined {
        return (this._targets[this._front] as unknown as { _rtWrapper?: { gpuTimeInFrame?: WebGPUPerfCounter } | null })._rtWrapper?.gpuTimeInFrame;
    }

    async prepare(report?: (fraction: number) => void): Promise<void> {
        this._pushAll(this._targets[0]);
        this._pushAll(this._targets[1]);
        for (let guard = 0; guard < 600 && !(this._targets[0].isReady() && this._targets[1].isReady()); guard++) {
            await nextFrame();
        }
        this.compiled = this._targets[0].isReady() && this._targets[1].isReady();
        if (!this.compiled) console.error("[substrate] fire step shader never became ready");
        report?.(0.5);
        this._clear();
        this._prepared = true;
        report?.(1);
    }

    /** Advance one step. Runs after the substrate, on that pass's window. */
    update(dt: number): void {
        const s = this._settings.v;
        if (!s["sys.fire"] || !s["sys.substrate"]) {
            if (!this._cleared) this._clear();
            return;
        }
        this._cleared = false;

        const step = Math.min(Math.max(dt, 0), MAX_STEP);
        if (step <= 0 && this._sourceFrames <= 0) return;

        if (this._sourceFrames > 0) this._sourceFrames--;
        else this._source.w = 0;

        this._step.set(step, 0, 0, 0);
        this._render();
    }

    /**
     * Put heat into the ground at a world position, for a moment.
     *
     * An ignition is a press rather than a permanent flame: it dumps heat and stops, and
     * what happens next is the element's business. Snow melts and refreezes, sand barely
     * notices, and rock stays molten for a very long time.
     */
    ignite(x: number, z: number, radius: number, rate: number): void {
        this._source.set(x, z, Math.max(radius, 1e-3), rate);
        this._sourceFrames = Math.max(1, Math.round(this._settings.v["fire.igniteFrames"]));
    }

    /** Wipe the heat. The overlay hangs a button off this. */
    reset(): void {
        this._clear();
    }

    /** Point a material's fire sampler at the current front buffer. Every frame. */
    bindTo(material: ShaderMaterial): void {
        material.setTexture("sbFireTex", this._targets[this._front]);
    }

    /**
     * The same buffer, under the name the relaxation pass reads it by — that pass takes
     * only the phase channel, through its own texel-shifted load, because including
     * substrateFireBuffer would oblige it to bind the substrate texture it is writing.
     */
    bindPhaseTo(target: SubstrateTarget): void {
        target.setTexture("srFire", this._targets[this._front]);
    }

    dispose(): void {
        for (const off of this._disposers) off();
        this._disposers.length = 0;
        for (const t of this._targets) t.dispose();
    }

    // -- internals -----------------------------------------------------------

    private _createTarget(name: string): ProceduralTexture {
        const tex = new ProceduralTexture(
            name,
            this._size,
            { fragmentSource: stepSource },
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
        tex.refreshRate = 0;
        tex.wrapU = Constants.TEXTURE_CLAMP_ADDRESSMODE;
        tex.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
        return tex;
    }

    private _render(): void {
        const back = this._targets[1 - this._front];
        if (!back.isReady()) return;
        this._pushAll(back);
        back.render();
        this._front = 1 - this._front;
        this.steps++;
    }

    private _pushAll(target: ProceduralTexture): void {
        // The window comes from the substrate rather than being recomputed — one source
        // of truth for where a cell is, across all three simulations.
        target.setVector2("frOrigin", this._substrate.origin);
        target.setFloat("frExtent", this._settings.v["substrate.extent"]);
        target.setFloat("frSize", this._size);
        target.setVector2("frShift", this._substrate.shift);
        target.setVector4("frStep", this._step);
        target.setVector4("frSource", this._source);
        pushFireParams(target, this._element);
    }

    private _clear(): void {
        if (!this._targets[0].isReady() || !this._targets[1].isReady()) return;
        this._step.set(0, 1, 0, 0);
        this._source.set(0, 0, 1, 0);
        this._sourceFrames = 0;
        for (const t of this._targets) {
            this._pushAll(t);
            t.render();
        }
        this._step.set(0, 0, 0, 0);
        this._cleared = true;
    }
}
