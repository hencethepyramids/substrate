import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Constants } from "@babylonjs/core/Engines/constants";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3, Vector4 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";
import type { TargetCamera } from "@babylonjs/core/Cameras/targetCamera";
import type { Settings } from "../core/settings";
import type { BiomeState } from "../core/biome";
import type { ElementDef } from "../elements/types";
import type { Heightfield } from "../terrain/heightfield";
import type { Mover } from "../core/mover";
import type { AirField } from "../air/airField";
import type { Substrate } from "./substrate";
import { Sky, SKY_UNIFORMS, SKY_SAMPLERS, WORLD_GROUP } from "../render/sky";
import { TONEMAPS } from "../core/settings";
import { compileOrWarn } from "../core/loading";
import sprayVertex from "../shaders/spray.vertex.wgsl?raw";
import sprayFragment from "../shaders/spray.fragment.wgsl?raw";

/**
 * Spray: material a body throws into the air by moving through it fast.
 *
 * The same shape as the embers — a static mesh carrying only indices, a particle that is a
 * pure function of its index and the clock, one draw call whether the ground is exploding
 * or still. What differs is what decides a particle is real: the embers read heat, and
 * this reads the substrate's LOOSE MASS, which is precisely what a wake manufactures.
 * Carve a track through deep snow and it throws a great deal; take the same track over
 * ground that has already been packed and it throws almost nothing. Neither case has a
 * rule written for it — the mass channel had that information since Phase 3.
 *
 * Allocation-free after construction.
 */

/** Quads. Only the fraction standing over freshly broken ground ever draws. */
const COUNT = 12288;

export class Spray {
    readonly mesh: Mesh;
    readonly material: ShaderMaterial;
    compiled = false;

    private readonly _settings: Settings;
    private readonly _substrate: Substrate;
    private readonly _field: Heightfield;
    private readonly _air: AirField;
    private readonly _sky: Sky;
    private readonly _disposers: (() => void)[] = [];
    private _element: ElementDef;
    private _time = 0;

    private readonly _params = new Vector4(0, 0, 0, 0);
    private readonly _source = new Vector4(0, 0, 0, 0);
    private readonly _throw = new Vector4(0, 1, 0, 0);
    private readonly _albedo = new Color3(1, 1, 1);
    private readonly _right = new Vector3(1, 0, 0);
    private readonly _up = new Vector3(0, 1, 0);
    private readonly _forward = new Vector3(0, 0, 1);
    private readonly _camera = new Vector3(0, 0, 0);

    constructor(scene: Scene, settings: Settings, biome: BiomeState, field: Heightfield, substrate: Substrate, air: AirField, sky: Sky) {
        this._settings = settings;
        this._substrate = substrate;
        this._field = field;
        this._air = air;
        this._sky = sky;
        this._element = biome.current;

        this.mesh = new Mesh("spray", scene);
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
            "spray",
            scene,
            { vertexSource: sprayVertex, fragmentSource: sprayFragment },
            {
                attributes: ["position"],
                uniforms: [
                    "viewProjection",
                    "spCamRight",
                    "spCamUp",
                    "spParams",
                    "spSource",
                    "spThrow",
                    "spCameraPos",
                    "spAlbedo",
                    "spExposure",
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
                    ...SKY_UNIFORMS,
                ],
                samplers: ["sbFieldTex", "sbSubTex", ...SKY_SAMPLERS],
                shaderLanguage: ShaderLanguage.WGSL,
            },
        );
        // ALPHA BLENDED, NOT ADDITIVE. A grain of snow hides what is behind it; an ember
        // adds to it. Getting this wrong is what makes thrown material read as smoke.
        this.material.alphaMode = Constants.ALPHA_COMBINE;
        this.material.needAlphaBlending = () => true;
        this.material.disableDepthWrite = true;
        this.material.backFaceCulling = false;
        sky.bindTo(this.material);

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
        this.compiled = await compileOrWarn("spray", () => this.material.forceCompilationAsync(this.mesh));
    }

    get ready(): boolean {
        return this.material.isReady(this.mesh);
    }

    /** @param dt simulation seconds, already scaled and zeroed by the pause. */
    update(camera: TargetCamera, mover: Mover, dt: number): void {
        const s = this._settings.v;
        const on = s["sys.spray"] && s["sys.substrate"];
        this.mesh.setEnabled(on);
        if (!on) return;

        this._time += dt;

        // Camera basis from the rig's own angles, as the sky dome and the embers build
        // theirs — one definition of which way is right.
        const yaw = camera.rotation.y;
        const pitch = camera.rotation.x;
        const sinYaw = Math.sin(yaw);
        const cosYaw = Math.cos(yaw);
        const cosPitch = Math.cos(pitch);
        this._forward.set(sinYaw * cosPitch, -Math.sin(pitch), cosYaw * cosPitch);
        this._right.set(cosYaw, 0, -sinYaw);
        Vector3.CrossToRef(this._forward, this._right, this._up);

        this._camera.copyFrom(camera.globalPosition);
        this._source.set(mover.position.x, mover.position.z, mover.speed, s["spray.radius"]);
        const sp = Math.max(mover.speed, 1e-4);
        this._throw.set(mover.velocity.x / sp, mover.velocity.z / sp, s["spray.massMin"], s["spray.speedMin"]);
        const a = this._element.surface.albedo;
        this._albedo.set(a[0], a[1], a[2]);

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
        m.setVector3("spCamRight", this._right);
        m.setVector3("spCamUp", this._up);
        this._params.set(this._time, s["spray.life"], s["spray.launch"], s["spray.size"]);
        m.setVector4("spParams", this._params);
        m.setVector4("spSource", this._source);
        m.setVector4("spThrow", this._throw);
        m.setVector3("spCameraPos", this._camera);
        m.setColor3("spAlbedo", this._albedo);
        m.setFloat("spExposure", s["render.exposure"]);
        m.setFloat("sbTonemapMode", Math.max(0, TONEMAPS.indexOf(s["post.tonemap"] as (typeof TONEMAPS)[number])));

        this._substrate.bindTo(m);
        this._substrate.pushTo(m);
        m.setVector2("sbFieldOrigin", this._substrate.fieldOrigin);
        m.setFloat("sbFieldExtent", this._field.extent);
        m.setFloat("sbFieldSize", this._field.size);
        m.setFloat("sbHeightScale", s["terrain.heightScale"]);
        this._air.pushTo(m);
        this._sky.pushTo(m);
    }
}
