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
import type { Heightfield } from "../terrain/heightfield";
import type { Substrate } from "../substrate/substrate";
import type { AirField } from "./airField";
import { nextFrame } from "../core/loading";
import { pushSubstrateParams } from "../substrate/substrateParams";
import stepSource from "../shaders/airborneStep.fragment.wgsl?raw";

/**
 * Material in the air: lifted off the ground, carried by the wind, dropped in the lee.
 *
 * Ping-ponged on THE SUBSTRATE'S OWN WINDOW — same origin, extent, texel grid and
 * snapping, taken from it every frame rather than computed a second time. Material
 * crosses between the ground and the air constantly, and on a shared grid that exchange
 * is texel-to-texel: no resampling, and no way for the two buffers to disagree about
 * where a cell is.
 *
 * It does not edit the ground. It records what it owes in the exchange channel; Phase 5
 * pass B2 has the relaxation pass apply it, so the substrate stays the only thing that
 * writes the substrate.
 *
 * Allocation-free after construction.
 */

export const AIRBORNE_SAMPLERS = ["sbAirborneTex"] as const;

/** Same clamp the substrate uses: a hitch should slow the simulation, not lurch it. */
const MAX_STEP = 1 / 30;

export class Airborne {
    /** Steps since boot. Sits next to the substrate's own count in the overlay. */
    steps = 0;
    compiled = false;

    private readonly _scene: Scene;
    private readonly _settings: Settings;
    private readonly _field: Heightfield;
    private readonly _substrate: Substrate;
    private readonly _air: AirField;
    private readonly _disposers: (() => void)[] = [];

    private readonly _targets: ProceduralTexture[];
    private _front = 0;
    private _size: number;
    private _element: ElementDef;
    private _prepared = false;
    private _cleared = false;

    private readonly _step = new Vector4(0, 0, 0, 0);

    constructor(scene: Scene, settings: Settings, biome: BiomeState, field: Heightfield, substrate: Substrate, air: AirField) {
        this._scene = scene;
        this._settings = settings;
        this._field = field;
        this._substrate = substrate;
        this._air = air;
        this._element = biome.current;
        this._size = settings.get("substrate.resolution");

        this._targets = [this._createTarget("airborneA"), this._createTarget("airborneB")];
        this._targets[0].setTexture("abPrev", this._targets[1]);
        this._targets[1].setTexture("abPrev", this._targets[0]);

        this._disposers.push(biome.onChange((def) => (this._element = def)));
        this._disposers.push(
            settings.on("substrate.resolution", (res) => {
                this._size = res;
                for (const t of this._targets) t.resize(res, false);
                if (this._prepared) this._clear();
            }),
        );
        // The window is the substrate's, so anything that invalidates it invalidates this.
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
        if (!this.compiled) console.error("[substrate] airborne step shader never became ready");
        report?.(0.5);
        this._clear();
        this._prepared = true;
        report?.(1);
    }

    /**
     * Advance one step. Must run AFTER substrate.update() — it reads the ground the
     * substrate has just finished writing, and shares that pass's window.
     */
    update(dt: number): void {
        const s = this._settings.v;
        if (!s["sys.airborne"] || !s["sys.substrate"]) {
            if (!this._cleared) this._clear();
            return;
        }
        this._cleared = false;

        const step = Math.min(Math.max(dt, 0), MAX_STEP);
        if (step <= 0) return;

        this._step.set(step, 0, s["airborne.liftRate"], s["airborne.settleRate"]);
        this._render();
    }

    /** Point a material's airborne sampler at the current front buffer. Every frame. */
    bindTo(material: ShaderMaterial): void {
        material.setTexture("sbAirborneTex", this._targets[this._front]);
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
        // The window, the ground and the scroll all come from the substrate rather than
        // being recomputed — one source of truth for where a cell is.
        this._substrate.bindTo(target);
        this._substrate.pushTo(target);
        target.setVector2("abShift", this._substrate.shift);

        target.setTexture("sbFieldTex", this._field.texture);
        target.setVector2("sbFieldOrigin", this._substrate.fieldOrigin);
        target.setFloat("sbFieldExtent", this._field.extent);
        target.setFloat("sbFieldSize", this._field.size);
        target.setFloat("sbHeightScale", this._settings.v["terrain.heightScale"]);

        this._air.pushTo(target);
        pushSubstrateParams(target, this._element);
        target.setVector4("abStep", this._step);
        target.setFloat("abThreshold", this._settings.v["airborne.threshold"]);
    }

    private _clear(): void {
        if (!this._targets[0].isReady() || !this._targets[1].isReady()) return;
        this._step.set(0, 1, 0, 0);
        for (const t of this._targets) {
            this._pushAll(t);
            t.render();
        }
        this._step.set(0, 0, 0, 0);
        this._cleared = true;
    }
}
