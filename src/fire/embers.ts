import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Constants } from "@babylonjs/core/Engines/constants";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { Vector2, Vector3, Vector4 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";
import type { TargetCamera } from "@babylonjs/core/Cameras/targetCamera";
import type { Settings } from "../core/settings";
import type { BiomeState } from "../core/biome";
import type { ElementDef } from "../elements/types";
import type { Heightfield } from "../terrain/heightfield";
import type { Substrate } from "../substrate/substrate";
import type { AirField } from "../air/airField";
import type { Fire } from "./fire";
import { WORLD_GROUP } from "../render/sky";
import { TONEMAPS } from "../core/settings";
import { compileOrWarn } from "../core/loading";
import embersVertex from "../shaders/embers.vertex.wgsl?raw";
import embersFragment from "../shaders/embers.fragment.wgsl?raw";

/**
 * Sparks over hot ground.
 *
 * THE MESH IS STATIC AND CARRIES ONLY INDICES, exactly as the clipmap does. A particle is
 * a pure function of its index and the clock, so there is no CPU particle system, no
 * per-frame upload and no state to keep — the buffer that would normally hold positions
 * and lifetimes is replaced by a hash.
 *
 * Which of them are real is decided by the FIRE, not by this class: each ember samples the
 * heat where it was born and collapses to a degenerate quad if that spot is cold. That is
 * what lets one static mesh serve a fire of any shape, and why this costs one draw call
 * whether the world is burning or frozen.
 *
 * Allocation-free after construction.
 */

/**
 * Quads. Small enough to upload once and forget; large enough that the fraction of them
 * standing over a modest fire still reads as a shower — births are uniform across the
 * window, so only the burning part of it produces anything.
 */
const COUNT = 16384;

export class Embers {
    readonly mesh: Mesh;
    readonly material: ShaderMaterial;
    compiled = false;

    private readonly _settings: Settings;
    private readonly _substrate: Substrate;
    private readonly _field: Heightfield;
    private readonly _air: AirField;
    private readonly _fire: Fire;
    private readonly _disposers: (() => void)[] = [];
    private _element: ElementDef;
    private _time = 0;

    private readonly _params = new Vector4(0, 0, 0, 0);
    private readonly _spawn = new Vector2(0, 0);
    private readonly _right = new Vector3(1, 0, 0);
    private readonly _up = new Vector3(0, 1, 0);
    private readonly _forward = new Vector3(0, 0, 1);

    constructor(scene: Scene, settings: Settings, biome: BiomeState, field: Heightfield, substrate: Substrate, air: AirField, fire: Fire) {
        this._settings = settings;
        this._substrate = substrate;
        this._field = field;
        this._air = air;
        this._fire = fire;
        this._element = biome.current;

        this.mesh = new Mesh("embers", scene);
        const geometry = new VertexData();
        const positions = new Float32Array(COUNT * 4 * 3);
        const indices = new Uint32Array(COUNT * 6);
        for (let i = 0; i < COUNT; i++) {
            for (let c = 0; c < 4; c++) {
                const v = (i * 4 + c) * 3;
                positions[v] = i;
                positions[v + 1] = c;
                positions[v + 2] = 0;
            }
            const base = i * 4;
            const t = i * 6;
            indices[t] = base;
            indices[t + 1] = base + 1;
            indices[t + 2] = base + 2;
            indices[t + 3] = base + 1;
            indices[t + 4] = base + 3;
            indices[t + 5] = base + 2;
        }
        geometry.positions = positions as unknown as number[];
        geometry.indices = indices as unknown as number[];
        geometry.applyToMesh(this.mesh, false);

        this.material = new ShaderMaterial(
            "embers",
            scene,
            { vertexSource: embersVertex, fragmentSource: embersFragment },
            {
                attributes: ["position"],
                uniforms: [
                    "viewProjection",
                    "emCamRight",
                    "emCamUp",
                    "emParams",
                    "emSpawn",
                    "emExposure",
                    "sbTonemapMode",
                    "sbSubOrigin",
                    "sbSubExtent",
                    "sbSubSize",
                    "sbSubFade",
                    "sbFieldOrigin",
                    "sbFieldExtent",
                    "sbFieldSize",
                    "sbHeightScale",
                    "swBase",
                    "swParams",
                    "swTime",
                ],
                samplers: ["sbFieldTex", "sbSubTex", "sbFireTex"],
                shaderLanguage: ShaderLanguage.WGSL,
            },
        );
        // Additive, and no depth write: a spark brightens what is behind it and never
        // hides another spark. Depth TEST stays on, so the terrain still occludes them.
        this.material.alphaMode = Constants.ALPHA_ADD;
        this.material.needAlphaBlending = () => true;
        this.material.disableDepthWrite = true;
        this.material.backFaceCulling = false;

        this.mesh.material = this.material;
        this.mesh.renderingGroupId = WORLD_GROUP;
        this.mesh.alwaysSelectAsActiveMesh = true;
        this.mesh.doNotSyncBoundingInfo = true;
        this.mesh.isPickable = false;
        this.mesh.setEnabled(false);

        this.material.setTexture("sbFieldTex", this._field.texture);

        this._disposers.push(biome.onChange((def) => (this._element = def)));
    }

    async prepare(): Promise<void> {
        this._push();
        this.compiled = await compileOrWarn("embers", () => this.material.forceCompilationAsync(this.mesh));
    }

    get ready(): boolean {
        return this.material.isReady(this.mesh);
    }

    /** @param dt simulation seconds, already scaled and zeroed by the pause. */
    update(camera: TargetCamera, dt: number): void {
        const s = this._settings.v;
        // No embers without something to be an ember OF. The gain is the element's, so
        // snow and desert never draw this at all.
        const on = s["sys.embers"] && s["sys.fire"] && this._element.surface.emissiveGain > 0;
        this.mesh.setEnabled(on);
        if (!on) return;

        this._time += dt;

        // Camera basis from the rig's own angles, the same way the sky dome and the
        // shadow cascades build theirs — one definition of which way is right.
        const yaw = camera.rotation.y;
        const pitch = camera.rotation.x;
        const sinYaw = Math.sin(yaw);
        const cosYaw = Math.cos(yaw);
        const cosPitch = Math.cos(pitch);
        this._forward.set(sinYaw * cosPitch, -Math.sin(pitch), cosYaw * cosPitch);
        this._right.set(cosYaw, 0, -sinYaw);
        Vector3.CrossToRef(this._forward, this._right, this._up);

        this._push();
    }

    dispose(): void {
        for (const off of this._disposers) off();
        this._disposers.length = 0;
        this.mesh.dispose();
        this.material.dispose();
    }

    private _push(): void {
        const s = this._settings.v;
        const m = this.material;
        m.setVector3("emCamRight", this._right);
        m.setVector3("emCamUp", this._up);
        this._params.set(this._time, s["embers.life"], s["embers.rise"], s["embers.size"]);
        m.setVector4("emParams", this._params);
        this._spawn.set(s["embers.threshold"], 0);
        m.setVector2("emSpawn", this._spawn);
        m.setFloat("emExposure", s["render.exposure"]);
        m.setFloat("sbTonemapMode", Math.max(0, TONEMAPS.indexOf(s["post.tonemap"] as (typeof TONEMAPS)[number])));

        this._substrate.bindTo(m);
        this._substrate.pushTo(m);
        m.setVector2("sbFieldOrigin", this._substrate.fieldOrigin);
        m.setFloat("sbFieldExtent", this._field.extent);
        m.setFloat("sbFieldSize", this._field.size);
        m.setFloat("sbHeightScale", s["terrain.heightScale"]);
        this._air.pushTo(m);
        this._fire.bindTo(m);
    }
}
