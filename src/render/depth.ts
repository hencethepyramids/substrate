import { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Constants } from "@babylonjs/core/Engines/constants";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import type { Scene } from "@babylonjs/core/scene";
import type { Camera } from "@babylonjs/core/Cameras/camera";
import type { WebGPUPerfCounter } from "@babylonjs/core/Engines/WebGPU/webgpuPerfCounter";
import type { WebGPURenderTargetWrapper } from "@babylonjs/core/Engines/WebGPU/webgpuRenderTargetWrapper";
import type { Settings } from "../core/settings";
import depthFragment from "../shaders/depth.fragment.wgsl?raw";
import depthTerrainVertex from "../shaders/depthTerrain.vertex.wgsl?raw";
import depthSkinnedVertex from "../shaders/depthSkinned.vertex.wgsl?raw";
import depthMeshVertex from "../shaders/depthMesh.vertex.wgsl?raw";

/**
 * Linear view distance for the whole frame, in metres.
 *
 * WHY THIS COSTS A GEOMETRY PASS, when the scene already has a depth buffer attached. Two
 * reasons, and the second is the fatal one. The attachment holds clip-space z — hyperbolic
 * in distance, chosen to give near geometry precision — which every consumer here would
 * have to invert; that alone would be survivable. But the clipmap DISPLACES its vertices
 * in the vertex shader, by the CDLOD morph and by the substrate buffer, and any generic
 * depth renderer draws the undisplaced mesh. A depth buffer describing a surface that is
 * not the one on screen is worse than no depth buffer, because everything downstream would
 * still look plausible.
 *
 * So this renders the same three meshes the shadow cascades do, through the same
 * `sbClipmapVertex` and the same `skSkinPoint` the beauty pass uses. Rule 4: shared logic
 * in one include, never two copies that drift.
 *
 * WHAT IT UNLOCKS: temporal reprojection, circle of confusion, and knowing how much air a
 * ray crossed. All three want metres, none of them want clip z.
 */

/** Distance written where nothing was drawn. Far enough to read as "sky" everywhere. */
const CLEAR_DISTANCE = 1.0e6;
const CLEAR = new Color4(CLEAR_DISTANCE, 0, 0, 1);

export interface DepthCaster {
    mesh: Mesh;
    /** Override for a mesh that is not an ordinary world-transformed one, e.g. the figure. */
    material?: ShaderMaterial;
}

export class Depth {
    readonly target: RenderTargetTexture;
    /** The clipmap's depth material. The terrain pushes its clipmap uniforms to this. */
    readonly terrainDepth: ShaderMaterial;
    /** Ordinary world-transformed meshes. */
    readonly meshDepth: ShaderMaterial;
    /** Skinned. The figure pushes its palette to this. */
    readonly skinnedDepth: ShaderMaterial;

    private readonly _scene: Scene;
    private readonly _settings: Settings;
    private readonly _camera: Camera;
    private readonly _disposers: (() => void)[] = [];
    private readonly _materials: ShaderMaterial[] = [];
    private _meshes: AbstractMesh[] = [];
    private _enabled = false;
    private _probed = false;

    get compiled(): boolean {
        return this._meshes.length > 0 && this.terrainDepth.isReady(this._meshes[0] as Mesh);
    }

    /** Rule 7: a provider, not a cached counter — the wrapper is replaced on resize. */
    get gpuTime(): WebGPUPerfCounter | undefined {
        return (this.target.renderTarget as WebGPURenderTargetWrapper | null)?.gpuTimeInFrame;
    }

    /** True when the buffer is being written this frame. Consumers must check it. */
    get enabled(): boolean {
        return this._enabled;
    }

    constructor(scene: Scene, settings: Settings, camera: Camera) {
        this._scene = scene;
        this._settings = settings;
        this._camera = camera;

        const engine = scene.getEngine();
        this.target = new RenderTargetTexture(
            "substrateDepth",
            { width: engine.getRenderWidth(true), height: engine.getRenderHeight(true) },
            scene,
            {
                generateMipMaps: false,
                // R32F because the whole point of this buffer is to be trusted: at 1000 m
                // a half-float is already half a metre coarse, and a circle of confusion
                // computed from that would step visibly across a smooth surface.
                type: Constants.TEXTURETYPE_FLOAT,
                format: Constants.TEXTUREFORMAT_R,
                // Nearest, and not negotiable: interpolating between a foreground distance
                // and a background one invents a surface at neither, which is exactly the
                // halo artefact that makes screen-space depth effects look cheap.
                samplingMode: Constants.TEXTURE_NEAREST_SAMPLINGMODE,
                generateDepthBuffer: true,
                generateStencilBuffer: false,
            },
        );
        this.target.wrapU = Constants.TEXTURE_CLAMP_ADDRESSMODE;
        this.target.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
        this.target.clearColor = CLEAR;
        this.target.refreshRate = 1;

        const common = {
            uniforms: ["dpViewProj", "dpCameraPos"],
            shaderLanguage: ShaderLanguage.WGSL,
        };

        this.terrainDepth = new ShaderMaterial("substrateDepthTerrain", scene, { vertexSource: depthTerrainVertex, fragmentSource: depthFragment }, {
            attributes: ["position"],
            // The same list the shadow cast declares, for the same reason: substrateClipmap
            // displaces by the substrate buffer, and an include that declares a texture
            // obliges every pass including it to bind that texture.
            uniforms: [...common.uniforms, "tCenter", "tInnerSpacing", "tCells", "tMorph", "tLevels", "tDisplace", "sbFieldOrigin", "sbFieldExtent", "sbFieldSize", "sbHeightScale", "sbSubOrigin", "sbSubExtent", "sbSubSize", "sbSubFade"],
            samplers: ["sbFieldTex", "sbSubTex"],
            shaderLanguage: common.shaderLanguage,
        });
        this.terrainDepth.backFaceCulling = true;

        this.meshDepth = new ShaderMaterial("substrateDepthMesh", scene, { vertexSource: depthMeshVertex, fragmentSource: depthFragment }, {
            attributes: ["position"],
            uniforms: ["world", ...common.uniforms],
            shaderLanguage: common.shaderLanguage,
        });

        this.skinnedDepth = new ShaderMaterial("substrateDepthSkinned", scene, { vertexSource: depthSkinnedVertex, fragmentSource: depthFragment }, {
            attributes: ["position", "skin"],
            uniforms: [...common.uniforms, "skBones"],
            shaderLanguage: common.shaderLanguage,
        });

        this._materials.push(this.terrainDepth, this.meshDepth, this.skinnedDepth);

        // Rule 3. Off removes the target from the scene entirely rather than skipping a
        // clear, so the toggle answers "what does it cost" — which for a geometry pass over
        // the clipmap is the only interesting question about it.
        this._disposers.push(settings.on("sys.depthPrepass", () => this._sync()));
        this._sync();
    }

    /** The heightfield the clipmap reads. Bound once; it does not ping-pong. */
    bindField(field: BaseTexture | null): void {
        if (field !== null) this.terrainDepth.setTexture("sbFieldTex", field);
    }

    /** Terrain first, then the meshes, mirroring how the cascades take their casters. */
    setCasters(terrain: Mesh, meshes: DepthCaster[]): void {
        this._meshes = [terrain, ...meshes.map((m) => m.mesh)];
        this.target.renderList = this._meshes;
        this.target.setMaterialForRendering(terrain, this.terrainDepth);
        for (const c of meshes) this.target.setMaterialForRendering(c.mesh, c.material ?? this.meshDepth);
    }

    /** Push the camera. Rule 1: no allocation, the matrix is Babylon's own cached one. */
    update(): void {
        if (!this._enabled) return;
        const vp = this._camera.getTransformationMatrix();
        for (const m of this._materials) {
            m.setMatrix("dpViewProj", vp);
            m.setVector3("dpCameraPos", this._camera.globalPosition);
        }
    }

    async prepare(): Promise<void> {
        if (this._meshes.length === 0) return;
        for (let i = 0; i < 240 && !this.compiled; i++) {
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
    }

    /**
     * Reports what the buffer says about a point whose distance is already known.
     *
     * THE HOUSE PATTERN, and this buffer needs it more than most. A depth pass that is
     * self-consistent but in the wrong units, or off by the near plane, or built from
     * undisplaced geometry, produces a picture that looks entirely reasonable in every
     * effect downstream — a slightly wrong blur, a slightly wrong reprojection — and
     * nothing anywhere says so. Comparing one texel against a distance the CPU computed
     * independently is the whole of the check.
     */
    async probeWorld(target: Vector3): Promise<void> {
        if (this._probed || !this._enabled) return;
        this._probed = true;
        try {
            const w = this.target.getSize().width;
            const h = this.target.getSize().height;
            // Project the point the same way the vertex shader does, on the CPU, so the
            // two answers come from genuinely different arithmetic rather than from the
            // same expression evaluated twice.
            const m = this._camera.getTransformationMatrix().m;
            const cx = target.x * m[0] + target.y * m[4] + target.z * m[8] + m[12];
            const cy = target.x * m[1] + target.y * m[5] + target.z * m[9] + m[13];
            const cw = target.x * m[3] + target.y * m[7] + target.z * m[11] + m[15];
            if (cw <= 1e-6) {
                console.info("[substrate] depth probe: the reference point is behind the camera");
                return;
            }
            const expected = Vector3.Distance(target, this._camera.globalPosition);
            const px = Math.min(Math.max(Math.round(((cx / cw) * 0.5 + 0.5) * w), 0), w - 1);
            // Screen y runs the other way from clip y.
            const py = Math.min(Math.max(Math.round((0.5 - (cy / cw) * 0.5) * h), 0), h - 1);
            // WHOLE BUFFER, ONCE. A single-texel read cannot tell "the depth is wrong"
            // from "the readback row order is not what I assumed", and this project has
            // already shipped one row-order bug that looked exactly like a physics bug.
            // Reading everything lets the probe report both candidate conventions and say
            // which one agrees with a distance the CPU derived on its own.
            const data = await this.target.readPixels(0, 0, undefined, true, false);
            if (data === null) {
                console.info("[substrate] depth probe: readback unavailable");
                return;
            }
            const px32 = data as Float32Array;
            // R32F comes back as one float per texel.
            const topDown = px32[py * w + px];
            const bottomUp = px32[(h - 1 - py) * w + px];
            const errTop = Math.abs(topDown - expected);
            const errBottom = Math.abs(bottomUp - expected);
            const which = errTop <= errBottom ? "top-down" : "BOTTOM-UP";
            const best = Math.min(errTop, errBottom);
            console.info(
                `[substrate] depth probe: CPU says ${expected.toFixed(2)} m at pixel ${px},${py}; ` +
                    `buffer reads ${topDown.toFixed(2)} top-down and ${bottomUp.toFixed(2)} bottom-up ` +
                    `(${which} agrees, error ${(best * 100).toFixed(1)} cm)${best > 0.5 ? " *** BOTH WRONG ***" : ""}`,
            );
        } catch (e) {
            console.info(`[substrate] depth probe: failed (${String(e)})`);
        }
    }

    private _sync(): void {
        const want = this._settings.v["sys.depthPrepass"] as boolean;
        if (want === this._enabled) return;
        this._enabled = want;
        const list = this._scene.customRenderTargets;
        const at = list.indexOf(this.target);
        if (want && at < 0) list.push(this.target);
        else if (!want && at >= 0) list.splice(at, 1);
    }

    dispose(): void {
        for (const off of this._disposers) off();
        this._disposers.length = 0;
        const at = this._scene.customRenderTargets.indexOf(this.target);
        if (at >= 0) this._scene.customRenderTargets.splice(at, 1);
        for (const m of this._materials) m.dispose();
        this.target.dispose();
    }
}
