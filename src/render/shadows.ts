import { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Constants } from "@babylonjs/core/Engines/constants";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Vector2, Vector3, Vector4 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import type { Scene } from "@babylonjs/core/scene";
import type { TargetCamera } from "@babylonjs/core/Cameras/targetCamera";
import type { Settings } from "../core/settings";
import type { Sky } from "./sky";
import type { WebGPUPerfCounter } from "@babylonjs/core/Engines/WebGPU/webgpuPerfCounter";
import type { WebGPURenderTargetWrapper } from "@babylonjs/core/Engines/WebGPU/webgpuRenderTargetWrapper";
import { compileOrWarn } from "../core/loading";
import { debugCode } from "./debugViews";
import terrainShadowVertex from "../shaders/terrainShadow.vertex.wgsl?raw";
import meshShadowVertex from "../shaders/meshShadow.vertex.wgsl?raw";
import shadowCastFragment from "../shaders/shadowCast.fragment.wgsl?raw";

/**
 * Three cascaded shadow maps in one atlas, filtered with PCSS.
 *
 * The atlas is a single R32F target of (3 x resolution) by resolution: cascade c
 * writes into the x range [c/3, (c+1)/3] by scaling its own clip-space x, which
 * needs no viewport API and lets every consumer sample one texture with no dynamic
 * texture indexing. Three draws of the clipmap plus three of everything else.
 *
 * Cascades are fitted to the bounding SPHERE of each view-frustum slice rather than
 * to the slice itself, and the light-space centre is snapped to the texel grid. Both
 * are there for the same reason: a sphere is invariant under rotation and a snapped
 * centre is invariant under translation, so turning or walking cannot make the
 * shadow edges crawl.
 *
 * Allocation-free after construction.
 */

/** Cascade count is baked into the atlas layout and into shadow.wgsl. */
const CASCADES = 3;

/** Practical split blend: 0 is uniform spacing, 1 is fully logarithmic. */
const SPLIT_LAMBDA = 0.82;

const CLEAR = new Color4(1, 1, 1, 1);

export const SHADOW_UNIFORMS = ["shMatrix0", "shMatrix1", "shMatrix2", "shSplits", "shTexelWorld", "shDepthScale", "shParams", "shControl"] as const;
export const SHADOW_SAMPLERS = ["shMap"] as const;

/** A mesh that casts, and the material it casts with. */
export interface MeshCaster {
    mesh: Mesh;
    /**
     * Omit for the shared world-transform cast. Supply one when the mesh is not placed
     * by a world matrix, so that the cast reproduces the same vertex positions the
     * beauty pass draws.
     */
    material?: ShaderMaterial;
}

export class Shadows {
    readonly atlas: RenderTargetTexture;
    readonly terrainCast: ShaderMaterial;
    readonly meshCast: ShaderMaterial;

    compiled = false;

    private readonly _scene: Scene;
    private readonly _settings: Settings;
    private readonly _sky: Sky;
    private readonly _disposers: (() => void)[] = [];

    private _resolution: number;
    private _pass = 0;
    private _casters: Mesh[] = [];
    private _meshCasters: MeshCaster[] = [];
    /** Cast materials that are not `meshCast` and so need driving alongside it. */
    private readonly _overrides: ShaderMaterial[] = [];
    private _field: BaseTexture | null = null;

    // Preallocated. update() runs every frame.
    private readonly _matrices = [Matrix.Identity(), Matrix.Identity(), Matrix.Identity()];
    private readonly _lightView = Matrix.Identity();
    private readonly _lightProj = Matrix.Identity();
    private readonly _tile = new Vector2(1 / CASCADES, 0);
    private readonly _splits = new Vector4(0, 0, 0, 0);
    private readonly _texelWorld = new Vector4(0, 0, 0, 0);
    private readonly _depthScale = new Vector4(0, 0, 0, 0);
    private readonly _params = new Vector4(0, 0, 0, 0);
    private readonly _control = new Vector4(0, 0, 0, 0);
    private readonly _eye = new Vector3(0, 0, 0);
    private readonly _centre = new Vector3(0, 0, 0);
    private readonly _up = new Vector3(0, 1, 0);
    private readonly _forward = new Vector3(0, 0, 1);
    private readonly _right = new Vector3(1, 0, 0);
    private readonly _camUp = new Vector3(0, 1, 0);
    private readonly _corner = new Vector3(0, 0, 0);
    /** 8 frustum corners of the slice being fitted. */
    private readonly _corners: Vector3[] = Array.from({ length: 8 }, () => new Vector3(0, 0, 0));
    private readonly _lightSpace = new Vector3(0, 0, 0);

    constructor(scene: Scene, settings: Settings, sky: Sky) {
        this._scene = scene;
        this._settings = settings;
        this._sky = sky;
        this._resolution = settings.get("shadow.resolution");

        this.atlas = this._createAtlas(this._resolution);

        this.terrainCast = new ShaderMaterial(
            "terrainShadowCast",
            scene,
            { vertexSource: terrainShadowVertex, fragmentSource: shadowCastFragment },
            {
                attributes: ["position"],
                // The clipmap uniforms come from substrateClipmap, the field ones from
                // substrateTerrainField. Same names the beauty pass uses, because it is
                // the same include.
                uniforms: ["shViewProj", "shTile", "tCenter", "tInnerSpacing", "tCells", "tMorph", "tLevels", "sbFieldOrigin", "sbFieldExtent", "sbFieldSize", "sbHeightScale"],
                samplers: ["sbFieldTex"],
                shaderLanguage: ShaderLanguage.WGSL,
            },
        );
        // Front faces only. From the sun's side the terrain is a heightfield, so
        // there is nothing behind a front face worth writing, and skipping back
        // faces halves the work and pushes the depth away from the shaded surface.
        this.terrainCast.backFaceCulling = true;

        this.meshCast = new ShaderMaterial(
            "meshShadowCast",
            scene,
            { vertexSource: meshShadowVertex, fragmentSource: shadowCastFragment },
            {
                attributes: ["position"],
                uniforms: ["world", "shViewProj", "shTile"],
                shaderLanguage: ShaderLanguage.WGSL,
            },
        );
        this.meshCast.backFaceCulling = false;

        this._disposers.push(
            settings.on("shadow.resolution", (res) => {
                this._resolution = res;
                this._rebuildAtlas();
            }),
        );
    }

    /** The cast pass displaces through the same field the beauty pass does. */
    bindField(field: BaseTexture | null): void {
        this._field = field;
        if (field !== null) this.terrainCast.setTexture("sbFieldTex", field);
    }

    /**
     * Register the meshes that cast. The terrain gets the clipmap cast material and
     * everything else the world-transform one, unless it brings its own.
     *
     * A caster may override because it is not positioned by a world matrix at all. The
     * character is the first: its pose lives in a bone palette, so a cast that went
     * through the shared material would draw the shadow of a rest pose standing at the
     * origin while the figure walked away from it.
     */
    setCasters(terrain: Mesh, meshes: MeshCaster[]): void {
        this._meshCasters = meshes;
        this._casters = [terrain, ...meshes.map((c) => c.mesh)];
        this.atlas.renderList = this._casters as AbstractMesh[];
        this.atlas.setMaterialForRendering(terrain, this.terrainCast);
        this._overrides.length = 0;
        for (const c of meshes) {
            const material = c.material ?? this.meshCast;
            this.atlas.setMaterialForRendering(c.mesh, material);
            if (material !== this.meshCast && !this._overrides.includes(material)) this._overrides.push(material);
        }
        // A caster behind the camera still casts into the view. The render list is
        // culled against the active camera, so opt every caster out of that test.
        for (const m of this._casters) m.alwaysSelectAsActiveMesh = true;
    }

    /** Compiles every cast pipeline behind the loading screen. */
    async prepare(): Promise<void> {
        let ok = this._casters.length > 0 ? await compileOrWarn("shadow cast (terrain)", () => this.terrainCast.forceCompilationAsync(this._casters[0])) : false;
        // Against the mesh that actually uses it — a cast material compiled against
        // geometry with different attributes proves nothing about the draw that follows.
        for (const c of this._meshCasters) {
            const material = c.material ?? this.meshCast;
            ok = (await compileOrWarn(`shadow cast (${material.name})`, () => material.forceCompilationAsync(c.mesh))) && ok;
        }
        this.compiled = ok;
    }

    get ready(): boolean {
        return this._casters.length > 0 && this.terrainCast.isReady(this._casters[0]);
    }

    /**
     * GPU time for all three cascade passes, when the adapter granted timestamp-query.
     *
     * Read off the render target WRAPPER rather than the texture: the wrapper is what
     * carries the counter, and it is replaced whenever the atlas is resized, so this
     * has to be resolved per frame rather than cached.
     */
    get gpuTime(): WebGPUPerfCounter | undefined {
        const wrapper = this.atlas.renderTarget as WebGPURenderTargetWrapper | null;
        return wrapper?.gpuTimeInFrame;
    }

    /** Point a lit material's shadow sampler at the atlas. Call once, at construction. */
    bindTo(material: ShaderMaterial): void {
        material.setTexture("shMap", this.atlas);
    }

    /**
     * Fit the cascades, render them, and push the sampling uniforms. Must run before
     * scene.render(): the beauty pass reads the atlas this writes.
     */
    update(camera: TargetCamera): void {
        const s = this._settings.v;
        const on = s["sys.shadows"];

        this._params.set(on ? 1 : 0, s["shadow.bias"], s["shadow.normalBias"], s["shadow.lightSize"]);
        this._control.set(s["shadow.pcfTaps"], s["shadow.blockerTaps"], s["shadow.softness"], debugCode(s["debug.view"]));
        if (!on) {
            this._splits.set(0, 0, 0, 1);
            return;
        }

        const far = s["shadow.distance"];
        const near = 0.5;
        // Practical split scheme. Logarithmic spacing puts resolution where
        // perspective needs it; uniform spacing keeps the far cascade from covering
        // the whole world. The blend is the usual compromise.
        for (let c = 0; c < CASCADES; c++) {
            const f = (c + 1) / CASCADES;
            const log = near * Math.pow(far / near, f);
            const uniform = near + (far - near) * f;
            const split = SPLIT_LAMBDA * log + (1 - SPLIT_LAMBDA) * uniform;
            if (c === 0) this._splits.x = split;
            else if (c === 1) this._splits.y = split;
            else this._splits.z = split;
        }
        this._splits.w = Math.max(0.5, s["shadow.blend"]);

        this._buildCameraBasis(camera);

        let sliceNear = near;
        for (let c = 0; c < CASCADES; c++) {
            const sliceFar = c === 0 ? this._splits.x : c === 1 ? this._splits.y : this._splits.z;
            this._fitCascade(c, camera, sliceNear, sliceFar);
            // Overlap slices slightly so the cross-fade band has valid data in both.
            sliceNear = sliceFar - this._splits.w;
        }

        // Render. One pass per cascade, each into its own third of the atlas.
        for (let c = 0; c < CASCADES; c++) {
            this._pass = c;
            this._tile.set(1 / CASCADES, (2 * c - 2) / CASCADES);
            this.terrainCast.setMatrix("shViewProj", this._matrices[c]);
            this.terrainCast.setVector2("shTile", this._tile);
            this.meshCast.setMatrix("shViewProj", this._matrices[c]);
            this.meshCast.setVector2("shTile", this._tile);
            // Every override gets the same cascade. Miss one and its caster renders all
            // three cascades with whichever matrix happened to be left on it.
            for (const m of this._overrides) {
                m.setMatrix("shViewProj", this._matrices[c]);
                m.setVector2("shTile", this._tile);
            }
            this.atlas.render();
        }
    }

    /** Push the sampling uniforms every lit material shares. Once per frame, per material. */
    pushTo(material: ShaderMaterial): void {
        material.setMatrix("shMatrix0", this._matrices[0]);
        material.setMatrix("shMatrix1", this._matrices[1]);
        material.setMatrix("shMatrix2", this._matrices[2]);
        material.setVector4("shSplits", this._splits);
        material.setVector4("shTexelWorld", this._texelWorld);
        material.setVector4("shDepthScale", this._depthScale);
        material.setVector4("shParams", this._params);
        material.setVector4("shControl", this._control);
    }

    dispose(): void {
        for (const off of this._disposers) off();
        this._disposers.length = 0;
        this.atlas.dispose();
        this.terrainCast.dispose();
        this.meshCast.dispose();
    }

    // -- internals -----------------------------------------------------------

    private _createAtlas(resolution: number): RenderTargetTexture {
        const rtt = new RenderTargetTexture(
            "shadowAtlas",
            { width: resolution * CASCADES, height: resolution },
            this._scene,
            {
                generateMipMaps: false,
                type: Constants.TEXTURETYPE_FLOAT,
                format: Constants.TEXTUREFORMAT_R,
                // Nearest: R32F is not filterable without float32-filterable, and PCSS
                // averages real blocker depths itself rather than wanting them blended.
                samplingMode: Constants.TEXTURE_NEAREST_SAMPLINGMODE,
                generateDepthBuffer: true,
                generateStencilBuffer: false,
            },
        );
        // Driven by hand, once per frame, three times.
        rtt.refreshRate = 0;
        rtt.wrapU = Constants.TEXTURE_CLAMP_ADDRESSMODE;
        rtt.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
        rtt.skipInitialClear = true;
        rtt.clearColor = CLEAR;

        // Clear only before the first cascade. The three thirds are disjoint in x, so
        // one clear covers all of them and the shared depth buffer is partitioned the
        // same way — no pixel belongs to two cascades.
        rtt.onClearObservable.add((engine) => {
            if (this._pass === 0) engine.clear(CLEAR, true, true, false);
        });
        return rtt;
    }

    private _rebuildAtlas(): void {
        const terrain = this._casters[0];
        const meshes = this._meshCasters;
        this.atlas.resize({ width: this._resolution * CASCADES, height: this._resolution });
        if (terrain !== undefined) this.setCasters(terrain, meshes);
        this.bindField(this._field);
    }

    /** Camera basis, from the rig's own angles. Same reasoning as the sky dome. */
    private _buildCameraBasis(camera: TargetCamera): void {
        const yaw = camera.rotation.y;
        const pitch = camera.rotation.x;
        const sinYaw = Math.sin(yaw);
        const cosYaw = Math.cos(yaw);
        const cosPitch = Math.cos(pitch);
        this._forward.set(sinYaw * cosPitch, -Math.sin(pitch), cosYaw * cosPitch);
        this._right.set(cosYaw, 0, -sinYaw);
        Vector3.CrossToRef(this._forward, this._right, this._camUp);
    }

    /**
     * Fit one cascade to a slice of the view frustum.
     *
     * The bounding sphere of the slice, not the slice itself: a box fitted to the
     * corners changes size as the camera rotates, which makes every shadow edge in
     * the scene crawl. A sphere does not. The centre is then snapped to whole texels
     * in light space, which kills the remaining crawl from translation.
     */
    private _fitCascade(c: number, camera: TargetCamera, sliceNear: number, sliceFar: number): void {
        const engine = this._scene.getEngine();
        const tanHalfV = Math.tan(camera.fov * 0.5);
        const tanHalfH = tanHalfV * (engine.getRenderWidth() / Math.max(1, engine.getRenderHeight()));
        const eye = camera.globalPosition;

        // Indexed loops and no array literals: this runs three times a frame and
        // rule 1 says frame() allocates nothing.
        let i = 0;
        for (let plane = 0; plane < 2; plane++) {
            const d = plane === 0 ? sliceNear : sliceFar;
            const h = d * tanHalfV;
            const w = d * tanHalfH;
            for (let corner = 0; corner < 4; corner++) {
                const sx = corner & 1 ? 1 : -1;
                const sy = corner & 2 ? 1 : -1;
                this._corners[i].set(
                    eye.x + this._forward.x * d + this._right.x * w * sx + this._camUp.x * h * sy,
                    eye.y + this._forward.y * d + this._right.y * w * sx + this._camUp.y * h * sy,
                    eye.z + this._forward.z * d + this._right.z * w * sx + this._camUp.z * h * sy,
                );
                i++;
            }
        }

        this._centre.set(0, 0, 0);
        for (let c2 = 0; c2 < 8; c2++) this._centre.addInPlace(this._corners[c2]);
        this._centre.scaleInPlace(1 / 8);

        let radius = 0;
        for (let c2 = 0; c2 < 8; c2++) {
            const d = Vector3.Distance(this._centre, this._corners[c2]);
            if (d > radius) radius = d;
        }
        radius = Math.max(radius, 1);

        const texelWorld = (2 * radius) / this._resolution;
        if (c === 0) this._texelWorld.x = texelWorld;
        else if (c === 1) this._texelWorld.y = texelWorld;
        else this._texelWorld.z = texelWorld;

        const sun = this._sky.sunDir;
        // Degenerate up when the sun is overhead; pick another axis rather than
        // producing a NaN basis.
        if (Math.abs(sun.y) > 0.995) this._up.set(0, 0, 1);
        else this._up.set(0, 1, 0);

        // Snap the centre to the texel grid in light space. Round-tripping through
        // the light view matrix is the only way to snap along the axes the shadow map
        // actually samples.
        const depth = radius * 2 + this._settings.v["shadow.depthRange"];
        // Depth is normalised over `depth` metres and uv over `2 * radius` metres.
        // This is the conversion between them, and without it a penumbra computed
        // from a depth difference is in the wrong units entirely.
        const depthScale = depth / (2 * radius);
        if (c === 0) this._depthScale.x = depthScale;
        else if (c === 1) this._depthScale.y = depthScale;
        else this._depthScale.z = depthScale;
        this._eye.set(this._centre.x + sun.x * depth * 0.5, this._centre.y + sun.y * depth * 0.5, this._centre.z + sun.z * depth * 0.5);
        Matrix.LookAtLHToRef(this._eye, this._centre, this._up, this._lightView);

        Vector3.TransformCoordinatesToRef(this._centre, this._lightView, this._lightSpace);
        this._lightSpace.x = Math.round(this._lightSpace.x / texelWorld) * texelWorld;
        this._lightSpace.y = Math.round(this._lightSpace.y / texelWorld) * texelWorld;
        this._lightView.invertToRef(this._lightProj); // reuse as scratch: light -> world
        Vector3.TransformCoordinatesToRef(this._lightSpace, this._lightProj, this._corner);

        this._eye.set(this._corner.x + sun.x * depth * 0.5, this._corner.y + sun.y * depth * 0.5, this._corner.z + sun.z * depth * 0.5);
        Matrix.LookAtLHToRef(this._eye, this._corner, this._up, this._lightView);
        // WebGPU's clip space runs z in [0,1]. Passing false here would map the
        // cascade to [-1,1] and clip away everything in front of the light's midpoint.
        Matrix.OrthoLHToRef(radius * 2, radius * 2, 0.05, depth, this._lightProj, this._scene.getEngine().isNDCHalfZRange);
        this._lightView.multiplyToRef(this._lightProj, this._matrices[c]);
    }
}
