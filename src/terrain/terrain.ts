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
import type { Environment } from "../render/environment";
import { Heightfield } from "./heightfield";
import { buildClipmapMesh, CLIPMAP, type ClipmapStats } from "./clipmapMesh";
import { compileOrWarn } from "../core/loading";
import terrainVertex from "../shaders/terrain.vertex.wgsl?raw";
import terrainFragment from "../shaders/terrain.fragment.wgsl?raw";

/**
 * The terrain system: one baked field, one static clipmap mesh, one draw call.
 */

const VERTEX_UNIFORMS = ["viewProjection", "tCenter", "tInnerSpacing", "tCells", "tMorph", "tLevels", "sbFieldOrigin", "sbFieldExtent", "sbFieldSize", "sbHeightScale"];

const FRAGMENT_UNIFORMS = ["fCameraPos", "fSunDir", "fSunColor", "fAmbient", "fFogColor", "fAlbedo", "fAlbedoSteep", "fParams"];

/** Debug views this material can render, keyed by the settings enum value. */
const DEBUG_CODES: Record<string, number> = {
    off: 0,
    normals: 1,
    "terrain.rings": 2,
    "terrain.morph": 3,
    linearDepth: 4,
    "terrain.slope": 5,
};

export class Terrain {
    readonly field: Heightfield;
    readonly mesh: Mesh;
    readonly stats: ClipmapStats;
    readonly material: ShaderMaterial;

    private readonly _settings: Settings;
    private readonly _biome: BiomeState;
    private readonly _disposers: (() => void)[] = [];

    private readonly _center = new Vector2(0, 0);
    private readonly _fieldOrigin = new Vector2(0, 0);
    private readonly _params = new Vector4(0, 0, 0, 0);
    private readonly _albedo = new Color3(1, 1, 1);
    private readonly _albedoSteep = new Color3(0.5, 0.5, 0.5);
    private _element: ElementDef;
    private _rebakeQueued = false;

    constructor(scene: Scene, settings: Settings, biome: BiomeState) {
        this._settings = settings;
        this._biome = biome;
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
                samplers: ["sbFieldTex"],
                shaderLanguage: ShaderLanguage.WGSL,
            },
        );
        // Winding is derived to match Babylon's ground builder, but culling stays off
        // through Phase 1 so a winding mistake cannot make the terrain invisible.
        // Phase 2 turns it on, when shadow casting starts to care about facing.
        this.material.backFaceCulling = false;
        this.material.setTexture("sbFieldTex", this.field.texture);
        this.mesh.material = this.material;

        this._fieldOrigin.set(this.field.originX, this.field.originZ);

        this._applyElement(this._element);
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
        report?.(1);
    }

    /** False if the terrain material failed to compile. The rest of the scene still draws. */
    compiled = false;

    get ready(): boolean {
        return this.field.mirrorValid && this.material.isReady(this.mesh);
    }

    /** Push per-frame uniforms. Allocation-free. */
    update(camera: Camera, env: Environment): void {
        const s = this._settings.v;
        const mesh = this.mesh;
        mesh.setEnabled(s["sys.terrain"]);
        if (!s["sys.terrain"]) return;

        const camPos = camera.globalPosition;
        if (s["terrain.followCamera"]) this._center.set(camPos.x, camPos.z);

        const m = this.material;
        m.setVector2("tCenter", this._center);
        m.setFloat("tInnerSpacing", CLIPMAP.innerSpacing);
        m.setFloat("tCells", CLIPMAP.cells);
        m.setFloat("tMorph", s["terrain.morph"] ? 1 : 0);
        m.setFloat("tLevels", CLIPMAP.levels);

        m.setVector2("sbFieldOrigin", this._fieldOrigin);
        m.setFloat("sbFieldExtent", this.field.extent);
        m.setFloat("sbFieldSize", this.field.size);
        m.setFloat("sbHeightScale", s["terrain.heightScale"]);

        m.setVector3("fCameraPos", camPos);
        m.setVector3("fSunDir", env.sunDir);
        m.setColor3("fSunColor", env.sunColor);
        m.setColor3("fAmbient", env.ambient);
        m.setColor3("fFogColor", env.skyLinear);
        m.setColor3("fAlbedo", this._albedo);
        m.setColor3("fAlbedoSteep", this._albedoSteep);

        this._params.set(env.fogDensity, s["render.exposure"], DEBUG_CODES[s["debug.view"]] ?? 0, CLIPMAP.levels);
        m.setVector4("fParams", this._params);
    }

    dispose(): void {
        for (const off of this._disposers) off();
        this._disposers.length = 0;
        this.mesh.dispose();
        this.material.dispose();
        this.field.dispose();
    }

    private _applyElement(def: ElementDef): void {
        this._element = def;
        const a = def.surface.albedo;
        this._albedo.set(a[0], a[1], a[2]);
        // Steep faces expose the compacted material underneath, darkened further.
        const c = def.surface.albedoCompacted;
        this._albedoSteep.set(c[0] * 0.72, c[1] * 0.72, c[2] * 0.72);
        this._queueRebake();
    }

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
