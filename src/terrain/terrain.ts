import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector2, Vector4 } from "@babylonjs/core/Maths/math.vector";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Scene } from "@babylonjs/core/scene";
import type { Camera } from "@babylonjs/core/Cameras/camera";
import type { Settings } from "../core/settings";
import type { BiomeState } from "../core/biome";
import type { ElementDef } from "../elements/types";
import { Sky, SKY_UNIFORMS, SKY_SAMPLERS, WORLD_GROUP } from "../render/sky";
import { Shadows, SHADOW_UNIFORMS, SHADOW_SAMPLERS } from "../render/shadows";
import { debugCode } from "../render/debugViews";
import { Heightfield } from "./heightfield";
import { buildClipmapMesh, CLIPMAP, type ClipmapStats } from "./clipmapMesh";
import { compileOrWarn } from "../core/loading";
import terrainVertex from "../shaders/terrain.vertex.wgsl?raw";
import terrainFragment from "../shaders/terrain.fragment.wgsl?raw";

/**
 * The terrain system: one baked field, one static clipmap mesh, one draw call.
 */

const VERTEX_UNIFORMS = ["viewProjection", "tCenter", "tInnerSpacing", "tCells", "tMorph", "tLevels", "sbFieldOrigin", "sbFieldExtent", "sbFieldSize", "sbHeightScale"];

const FRAGMENT_UNIFORMS = ["fCameraPos", "fAlbedo", "fAlbedoSteep", "fParams", ...SKY_UNIFORMS, ...SHADOW_UNIFORMS];

export class Terrain {
    readonly field: Heightfield;
    readonly mesh: Mesh;
    readonly stats: ClipmapStats;
    readonly material: ShaderMaterial;

    private readonly _settings: Settings;
    private readonly _biome: BiomeState;
    private readonly _sky: Sky;
    private readonly _shadows: Shadows;
    private readonly _disposers: (() => void)[] = [];

    private readonly _center = new Vector2(0, 0);
    private readonly _fieldOrigin = new Vector2(0, 0);
    private readonly _params = new Vector4(0, 0, 0, 0);
    private readonly _albedo = new Color3(1, 1, 1);
    private readonly _albedoSteep = new Color3(0.5, 0.5, 0.5);
    private _element: ElementDef;
    private _rebakeQueued = false;

    constructor(scene: Scene, settings: Settings, biome: BiomeState, sky: Sky, shadows: Shadows) {
        this._settings = settings;
        this._biome = biome;
        this._sky = sky;
        this._shadows = shadows;
        this._element = biome.current;

        this.field = new Heightfield(scene, settings);

        const built = buildClipmapMesh("terrainClipmap", scene, CLIPMAP);
        this.mesh = built.mesh;
        this.stats = built.stats;

        this.material = new ShaderMaterial(
            "terrain",
            scene,
            { vertexSource: terrainVertex, fragmentSource: terrainFragment },
            {
                attributes: ["position"],
                uniforms: [...VERTEX_UNIFORMS, ...FRAGMENT_UNIFORMS],
                samplers: ["sbFieldTex", ...SKY_SAMPLERS, ...SHADOW_SAMPLERS],
                shaderLanguage: ShaderLanguage.WGSL,
            },
        );
        // Culling stayed off through Phase 1 and pass A so that a winding mistake
        // could never make the terrain invisible. The cascades settled it: the cast
        // pass renders front faces only and produces correct shadows, so up-facing IS
        // front-facing, and the sun and the camera are both above the surface.
        this.material.backFaceCulling = true;
        this.material.setTexture("sbFieldTex", this.field.texture);
        sky.bindTo(this.material);
        shadows.bindTo(this.material);
        // The cascades displace through the same field, so they need it bound too.
        shadows.bindField(this.field.texture);
        this.mesh.material = this.material;
        // Over the sky, which draws first and writes no depth.
        this.mesh.renderingGroupId = WORLD_GROUP;

        this._fieldOrigin.set(this.field.originX, this.field.originZ);

        // onChange fires immediately with the current element, so this is the only
        // call needed. The guard in _applyElement keeps that first call from queueing
        // a rebake on top of the one prepare() is about to do — two 67 MB readbacks
        // at startup for one field.
        this._disposers.push(biome.onChange((def) => this._applyElement(def)));
        this._disposers.push(settings.on("debug.wireframe", (on) => (this.material.wireframe = on)));
        this.material.wireframe = settings.get("debug.wireframe");

        // These change what is baked, so they need the field rebuilt, not just a uniform.
        const queue = () => this._queueRebake();
        this._disposers.push(settings.on("world.seed", queue));
        this._disposers.push(settings.on("world.windBearing", queue));
    }

    /** Compiles the pipeline and bakes the field. Runs behind the loading screen. */
    async prepare(report?: (fraction: number) => void): Promise<void> {
        try {
            await this.field.bake(this._element, (f) => report?.(f * 0.9));
        } catch (err) {
            // A failed bake leaves a flat field. Still worth booting: the sky, the
            // capsule and the overlay all come up, and the console says why.
            console.error("[substrate] heightfield bake failed:", err);
        }
        this.compiled = await compileOrWarn("terrain", () => this.material.forceCompilationAsync(this.mesh));
        this._prepared = true;
        report?.(1);
    }

    /** False if the terrain material failed to compile. The rest of the scene still draws. */
    compiled = false;

    get ready(): boolean {
        return this.field.mirrorValid && this.material.isReady(this.mesh);
    }

    /** Push per-frame uniforms. Allocation-free. */
    update(camera: Camera): void {
        const s = this._settings.v;
        const mesh = this.mesh;
        mesh.setEnabled(s["sys.terrain"]);
        if (!s["sys.terrain"]) return;

        const camPos = camera.globalPosition;
        if (s["terrain.followCamera"]) this._center.set(camPos.x, camPos.z);

        const m = this.material;
        // RULE 4, THE OTHER HALF OF IT. substrateClipmap guarantees the beauty pass
        // and the cascades run the same lines; this guarantees they run them on the
        // same NUMBERS. A shadow map built from a clipmap centred one frame behind
        // the shaded one produces creeping stripes that look exactly like bad bias.
        this._pushClipmap(m);
        this._pushClipmap(this._shadows.terrainCast);

        m.setVector3("fCameraPos", camPos);
        m.setColor3("fAlbedo", this._albedo);
        m.setColor3("fAlbedoSteep", this._albedoSteep);
        this._sky.pushTo(m);
        this._shadows.pushTo(m);

        this._params.set(s["render.exposure"], debugCode(s["debug.view"]), CLIPMAP.levels, 0);
        m.setVector4("fParams", this._params);
    }

    dispose(): void {
        for (const off of this._disposers) off();
        this._disposers.length = 0;
        this.mesh.dispose();
        this.material.dispose();
        this.field.dispose();
    }

    /** The clipmap and field uniforms, shared by the beauty pass and the cascades. */
    private _pushClipmap(m: ShaderMaterial): void {
        const s = this._settings.v;
        m.setVector2("tCenter", this._center);
        m.setFloat("tInnerSpacing", CLIPMAP.innerSpacing);
        m.setFloat("tCells", CLIPMAP.cells);
        m.setFloat("tMorph", s["terrain.morph"] ? 1 : 0);
        m.setFloat("tLevels", CLIPMAP.levels);

        m.setVector2("sbFieldOrigin", this._fieldOrigin);
        m.setFloat("sbFieldExtent", this.field.extent);
        m.setFloat("sbFieldSize", this.field.size);
        m.setFloat("sbHeightScale", s["terrain.heightScale"]);
    }

    private _applyElement(def: ElementDef): void {
        this._element = def;
        const a = def.surface.albedo;
        this._albedo.set(a[0], a[1], a[2]);
        // Steep faces expose the compacted material underneath, darkened further.
        const c = def.surface.albedoCompacted;
        this._albedoSteep.set(c[0] * 0.72, c[1] * 0.72, c[2] * 0.72);
        if (this._prepared) this._queueRebake();
    }

    private _prepared = false;

    /**
     * Rebakes are debounced and run off the frame loop. The GPU pass is a few
     * milliseconds; the 67 MB CPU readback is not, so grounding keeps using the
     * previous mirror until the new one lands rather than stalling the frame.
     */
    private _queueRebake(): void {
        if (this._rebakeQueued) return;
        this._rebakeQueued = true;
        setTimeout(() => {
            this._rebakeQueued = false;
            void this.field.bake(this._biome.current);
        }, 250);
    }
}
