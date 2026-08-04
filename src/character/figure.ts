import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3, Vector4 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";
import type { Camera } from "@babylonjs/core/Cameras/camera";
import type { Settings } from "../core/settings";
import { TONEMAPS } from "../core/settings";
import { Sky, SKY_UNIFORMS, SKY_SAMPLERS, WORLD_GROUP } from "../render/sky";
import { Shadows, SHADOW_UNIFORMS, SHADOW_SAMPLERS } from "../render/shadows";
import { compileOrWarn } from "../core/loading";
import type { Gait } from "./gait";
import { BONE_COUNT, B, type Skeleton } from "./skeleton";
import figureVertex from "../shaders/figure.vertex.wgsl?raw";
import figureFragment from "../shaders/figure.fragment.wgsl?raw";
import figureShadowVertex from "../shaders/figureShadow.vertex.wgsl?raw";
import shadowCastFragment from "../shaders/shadowCast.fragment.wgsl?raw";

/**
 * The character.
 *
 * PASS A DRAWS THE RIG AS BOXES, one per bone, and that is deliberate rather than a
 * placeholder left in by accident. The gait is the hard part of this phase and a box
 * figure shows it more honestly than a lofted one will: a foot that slides, a knee that
 * pops through its own limit or a bone weighted to the wrong joint is unmissable on a
 * box and easy to miss under a smooth skin. Pass B replaces the geometry and touches
 * nothing else — the skinning path, the palette and the solve are already what they
 * will be.
 *
 * There is no world matrix. The pose lives entirely in the bone palette, so the figure
 * is positioned in exactly one place, and the shadow cast skins from the same include
 * rather than from a second copy that could disagree with it.
 *
 * Allocation-free after construction.
 */

/** Vertices and indices per box. Four per face so each face keeps its own normal. */
const VERTS_PER_BOX = 24;
const INDICES_PER_BOX = 36;

/** Bones drawn as bare rather than clothed. */
const BARE = new Set<number>([B.head, B.foreArmR, B.handR, B.foreArmL, B.handL]);

export class Figure {
    readonly mesh: Mesh;
    readonly material: ShaderMaterial;
    /** The skinned cast. Handed to `Shadows.setCasters`, which drives it per cascade. */
    readonly castMaterial: ShaderMaterial;
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
        const built = buildBoxes(this._skeleton);
        built.data.applyToMesh(this.mesh, false);
        // Set directly rather than through VertexData, which only understands the kinds
        // it has a case for and would drop this one silently.
        this.mesh.setVerticesData("skin", built.skins as unknown as number[], false, 4);

        this.material = new ShaderMaterial(
            "figure",
            scene,
            { vertexSource: figureVertex, fragmentSource: figureFragment },
            {
                attributes: ["position", "normal", "skin"],
                uniforms: ["viewProjection", "skBones", "fgCloth", "fgSkin", "fgTint", "fgParams", "fgCameraPos", "sbTonemapMode", ...SKY_UNIFORMS, ...SHADOW_UNIFORMS],
                samplers: [...SKY_SAMPLERS, ...SHADOW_SAMPLERS],
                shaderLanguage: ShaderLanguage.WGSL,
            },
        );
        sky.bindTo(this.material);
        shadows.bindTo(this.material);
        // Boxes only. Every face carries its own outward normal so the shading is right
        // either way, and eighteen boxes is not where culling earns anything — but pass
        // B's loft is a closed surface and turns this back on.
        this.material.backFaceCulling = false;

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
        m.setFloat("sbTonemapMode", Math.max(0, TONEMAPS.indexOf(s["post.tonemap"] as (typeof TONEMAPS)[number])));
        this._sky.pushTo(m);
        this._shadows.pushTo(m);

        // The palette is stored by reference on both materials, so writing into the
        // skeleton's array in place is the whole of the per-frame upload. Set on the
        // cast material too: its pose has to be this frame's, not the one it was
        // compiled with.
        m.setArray4("skBones", this._skeleton.palette);
        this.castMaterial.setArray4("skBones", this._skeleton.palette);
    }
}

/**
 * One box per bone, authored in the REST pose because that is the space the palette
 * expects. Each box is rigid to its own bone — a joint blend needs two influences and a
 * loft to blend across, and both arrive in pass B.
 *
 * Built from the eight corners outwards rather than face by face: the corners are three
 * lines of arithmetic that are obviously right, and every face is then four of them
 * named explicitly. A box is not where cleverness pays.
 */
function buildBoxes(sk: Skeleton): { data: VertexData; skins: Float32Array } {
    const positions = new Float32Array(BONE_COUNT * VERTS_PER_BOX * 3);
    const normals = new Float32Array(BONE_COUNT * VERTS_PER_BOX * 3);
    const skins = new Float32Array(BONE_COUNT * VERTS_PER_BOX * 4);
    const indices = new Uint32Array(BONE_COUNT * INDICES_PER_BOX);

    // The eight corners of the box currently being written, as xyz triples.
    const corner = new Float32Array(8 * 3);
    let v = 0;
    let t = 0;

    for (let b = 0; b < BONE_COUNT; b++) {
        const i = b * 3;
        const hx = sk.restHead[i];
        const hy = sk.restHead[i + 1];
        const hz = sk.restHead[i + 2];
        const dx = sk.restDir[i];
        const dy = sk.restDir[i + 1];
        const dz = sk.restDir[i + 2];
        const len = sk.length[b];
        const g = sk.girth[b];
        const material = BARE.has(b) ? 1 : 0;

        // A basis across the bone. The reference axis is whichever of X and Y the bone is
        // least parallel to, so the cross product never collapses to zero.
        const refX = Math.abs(dx) < 0.9 ? 1 : 0;
        const refY = Math.abs(dx) < 0.9 ? 0 : 1;
        let ax = refY * dz;
        let ay = -refX * dz;
        let az = refX * dy - refY * dx;
        const al = Math.sqrt(ax * ax + ay * ay + az * az) || 1;
        ax /= al;
        ay /= al;
        az /= al;
        const bx = dy * az - dz * ay;
        const by = dz * ax - dx * az;
        const bz = dx * ay - dy * ax;

        // Corner index is (along << 2) | (acrossA << 1) | acrossB, each bit 0 for the
        // negative side and 1 for the positive.
        for (let c = 0; c < 8; c++) {
            const along = (c & 4) === 0 ? 0 : len;
            const sa = (c & 2) === 0 ? -g : g;
            const sb = (c & 1) === 0 ? -g : g;
            corner[c * 3] = hx + dx * along + ax * sa + bx * sb;
            corner[c * 3 + 1] = hy + dy * along + ay * sa + by * sb;
            corner[c * 3 + 2] = hz + dz * along + az * sa + bz * sb;
        }

        // Six faces: two caps across the bone, four sides along it.
        face(2 | 1, 4 | 2 | 1, 4 | 2, 2, ax, ay, az); // +A
        face(0, 4, 4 | 1, 1, -ax, -ay, -az); // -A
        face(1, 4 | 1, 4 | 2 | 1, 2 | 1, bx, by, bz); // +B
        face(2, 4 | 2, 4, 0, -bx, -by, -bz); // -B
        face(4, 4 | 2, 4 | 2 | 1, 4 | 1, dx, dy, dz); // far cap
        face(0, 1, 2 | 1, 2, -dx, -dy, -dz); // near cap

        /** Four corners and an outward normal, as two triangles. */
        function face(c0: number, c1: number, c2: number, c3: number, nx: number, ny: number, nz: number): void {
            const base = v;
            const ids = [c0, c1, c2, c3];
            for (let k = 0; k < 4; k++) {
                const p = v * 3;
                positions[p] = corner[ids[k] * 3];
                positions[p + 1] = corner[ids[k] * 3 + 1];
                positions[p + 2] = corner[ids[k] * 3 + 2];
                normals[p] = nx;
                normals[p + 1] = ny;
                normals[p + 2] = nz;
                const q = v * 4;
                // Rigid: both influences are the same bone, so the weight cannot matter.
                skins[q] = b;
                skins[q + 1] = b;
                skins[q + 2] = 0;
                skins[q + 3] = material;
                v++;
            }
            indices[t++] = base;
            indices[t++] = base + 1;
            indices[t++] = base + 2;
            indices[t++] = base;
            indices[t++] = base + 2;
            indices[t++] = base + 3;
        }
    }

    const data = new VertexData();
    data.positions = positions as unknown as number[];
    data.normals = normals as unknown as number[];
    data.indices = indices as unknown as number[];
    return { data, skins };
}
