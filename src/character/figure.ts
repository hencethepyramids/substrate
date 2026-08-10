import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3, Vector4 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";
import type { Camera } from "@babylonjs/core/Cameras/camera";
import type { Settings } from "../core/settings";
import { Sky, SKY_UNIFORMS, SKY_SAMPLERS, WORLD_GROUP } from "../render/sky";
import { Shadows, SHADOW_UNIFORMS, SHADOW_SAMPLERS } from "../render/shadows";
import { compileOrWarn } from "../core/loading";
import type { Gait } from "./gait";
import type { Skeleton } from "./skeleton";
import { buildLoft, validateLoft } from "./loft";
import figureVertex from "../shaders/figure.vertex.wgsl?raw";
import figureFragment from "../shaders/figure.fragment.wgsl?raw";
import figureShadowVertex from "../shaders/figureShadow.vertex.wgsl?raw";
import shadowCastFragment from "../shaders/shadowCast.fragment.wgsl?raw";

/**
 * The character.
 *
 * The geometry is a loft over the rig — see loft.ts, which is the only thing pass B
 * changed. The skinning path, the bone palette, the gait and the solve are exactly what
 * pass A shipped and verified with boxes, which was the point of drawing boxes first: a
 * sliding foot or a bone weighted to the wrong joint is unmissable on a box and easy to
 * miss under a smooth skin.
 *
 * There is no world matrix. The pose lives entirely in the bone palette, so the figure
 * is positioned in exactly one place, and the shadow cast skins from the same include
 * rather than from a second copy that could disagree with it.
 *
 * Allocation-free after construction.
 */
export class Figure {
    readonly mesh: Mesh;
    readonly material: ShaderMaterial;
    /** The skinned cast. Handed to `Shadows.setCasters`, which drives it per cascade. */
    readonly castMaterial: ShaderMaterial;
    readonly stats: { vertices: number; triangles: number };
    compiled = false;

    private readonly _settings: Settings;
    private readonly _sky: Sky;
    private readonly _shadows: Shadows;
    private readonly _skeleton: Skeleton;

    private readonly _params = new Vector4(0, 0, 0, 0);
    private readonly _cloth = new Color3(0.21, 0.24, 0.29);
    private readonly _skin = new Color3(0.62, 0.44, 0.34);
    /** Warm, because what comes back out of flesh has been through blood. */
    private readonly _tint = new Color3(0.9, 0.32, 0.22);
    private readonly _camera = new Vector3(0, 0, 0);

    constructor(scene: Scene, settings: Settings, sky: Sky, shadows: Shadows, gait: Gait) {
        this._settings = settings;
        this._sky = sky;
        this._shadows = shadows;
        this._skeleton = gait.skeleton;

        this.mesh = new Mesh("figure", scene);
        const loft = buildLoft(this._skeleton);
        const bad = validateLoft(loft);
        if (bad !== null) console.error(`[substrate] loft: ${bad}`);
        const data = new VertexData();
        data.positions = loft.positions as unknown as number[];
        data.normals = loft.normals as unknown as number[];
        data.indices = loft.indices as unknown as number[];
        data.applyToMesh(this.mesh, false);
        // Set directly rather than through VertexData, which only understands the kinds
        // it has a case for and would drop this one silently.
        this.mesh.setVerticesData("skin", loft.skins as unknown as number[], false, 4);
        this.stats = { vertices: loft.vertexCount, triangles: loft.triangleCount };

        this.material = new ShaderMaterial(
            "figure",
            scene,
            { vertexSource: figureVertex, fragmentSource: figureFragment },
            {
                attributes: ["position", "normal", "skin"],
                uniforms: ["viewProjection", "skBones", "fgCloth", "fgSkin", "fgTint", "fgParams", "fgCameraPos", ...SKY_UNIFORMS, ...SHADOW_UNIFORMS],
                samplers: [...SKY_SAMPLERS, ...SHADOW_SAMPLERS],
                shaderLanguage: ShaderLanguage.WGSL,
            },
        );
        sky.bindTo(this.material);
        shadows.bindTo(this.material);
        // The loft is a closed surface, so the inside of it is never meant to be seen and
        // the winding is worth getting right rather than working around. If this figure
        // ever renders inside out, the fix is the triangle order in loft.ts, not this line.
        this.material.backFaceCulling = true;

        this.castMaterial = new ShaderMaterial(
            "figureShadowCast",
            scene,
            { vertexSource: figureShadowVertex, fragmentSource: shadowCastFragment },
            {
                attributes: ["position", "skin"],
                uniforms: ["shViewProj", "shTile", "skBones"],
                shaderLanguage: ShaderLanguage.WGSL,
            },
        );
        this.castMaterial.backFaceCulling = false;

        this.mesh.material = this.material;
        this.mesh.renderingGroupId = WORLD_GROUP;
        this.mesh.isPickable = false;
        // The rest pose sits at the world origin and the palette carries the figure
        // wherever it walks, so the bounding box is meaningless. Opt out of both tests
        // rather than update a box that describes nothing.
        this.mesh.alwaysSelectAsActiveMesh = true;
        this.mesh.doNotSyncBoundingInfo = true;
    }

    /** The depth pass's skinned material, if there is one. */
    setDepthMaterial(m: ShaderMaterial | null): void {
        this._depthMaterial = m;
    }

    private _depthMaterial: ShaderMaterial | null = null;

    async prepare(): Promise<void> {
        this._push();
        this.castMaterial.setArray4("skBones", this._skeleton.palette);
        this.compiled = await compileOrWarn("character", () => this.material.forceCompilationAsync(this.mesh));
    }

    get ready(): boolean {
        return this.material.isReady(this.mesh);
    }

    update(camera: Camera): void {
        const on = this._settings.v["sys.character"];
        this.mesh.setEnabled(on);
        if (!on) return;
        this._camera.copyFrom(camera.globalPosition);
        this._push();
    }

    dispose(): void {
        this.mesh.dispose();
        this.material.dispose();
        this.castMaterial.dispose();
    }

    private _push(): void {
        const s = this._settings.v;
        const m = this.material;
        m.setColor3("fgCloth", this._cloth);
        m.setColor3("fgSkin", this._skin);
        m.setColor3("fgTint", this._tint);
        this._params.set(s["render.exposure"], s["char.clothRoughness"], s["char.skinRoughness"], s["char.subsurface"]);
        m.setVector4("fgParams", this._params);
        m.setVector3("fgCameraPos", this._camera);
        this._sky.pushTo(m);
        this._shadows.pushTo(m);

        // The palette is stored by reference on both materials, so writing into the
        // skeleton's array in place is the whole of the per-frame upload. Set on the
        // cast material too: its pose has to be this frame's, not the one it was
        // compiled with.
        m.setArray4("skBones", this._skeleton.palette);
        this.castMaterial.setArray4("skBones", this._skeleton.palette);
        // And the depth pass. setArray4 stores by reference, so this is three pointers to
        // one array rather than three copies — which is also why all three cannot
        // disagree about the pose.
        this._depthMaterial?.setArray4("skBones", this._skeleton.palette);
    }
}
