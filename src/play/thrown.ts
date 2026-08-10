import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";
import type { Camera } from "@babylonjs/core/Cameras/camera";
import type { Settings } from "../core/settings";
import type { Sky } from "../render/sky";
import { SKY_SAMPLERS, SKY_UNIFORMS } from "../render/sky";
import type { BiomeState } from "../core/biome";
import vertexSource from "../shaders/thrown.vertex.wgsl?raw";
import fragmentSource from "../shaders/thrown.fragment.wgsl?raw";

/** What this needs of the verb layer: where the projectiles are, and how many. */
export interface Flight {
    readonly inFlight: number;
    /** Stride-7 records: x, y, z, vx, vy, vz, volume. */
    readonly flight: Float32Array;
}

/** Stride of one projectile record in the flight array. */
const STRIDE = 7;

/**
 * Draws whatever the verb layer has in the air.
 *
 * PASS D SHIPPED THE ARC WITHOUT THE BALL, deliberately — a real trajectory with a real
 * impact and nothing to look at is a better thing to hand over than a decorative sprite on
 * a fake path. This is the other half, and it draws exactly what the simulation already
 * believes: the positions come straight out of the flight array that pass D integrates and
 * that conservation is measured against. There is no second copy of the trajectory here to
 * drift out of step with the first, which is the usual way a projectile ends up landing
 * somewhere other than where its impact is registered.
 *
 * THE RADIUS COMES FROM THE VOLUME, so a full load looks like a full load. A sphere of
 * volume V has radius (3V/4pi)^(1/3) — 250 litres is a 39 cm ball, which is a big
 * two-handed scoop rather than a snowball, and that is honestly what the carry capacity
 * says it is. If it looks absurd in motion, the number to change is the capacity, and the
 * ball will follow it without anything here being touched.
 */
export class Thrown {
    readonly mesh: Mesh;
    readonly material: ShaderMaterial;

    private readonly _settings: Settings;
    private readonly _biome: BiomeState;
    private readonly _flight: Flight;
    private readonly _camera: Camera;
    private readonly _sky: Sky;
    // Written every frame and handed to the GPU. Allocated once (Rule 1).
    private readonly _positions: Float32Array;
    private readonly _uvs: Float32Array;
    // ShaderMaterial takes vectors, not loose floats, and Rule 1 says a frame allocates
    // nothing — so these are written in place rather than rebuilt every update().
    private readonly _right = new Vector3();
    private readonly _up = new Vector3();
    private readonly _fwd = new Vector3();
    private readonly _params = new Vector3();
    private readonly _albedo = new Vector3();
    private readonly _tint = new Vector3();

    constructor(scene: Scene, settings: Settings, camera: Camera, sky: Sky, biome: BiomeState, flight: Flight, max: number) {
        this._settings = settings;
        this._biome = biome;
        this._flight = flight;
        this._camera = camera;
        this._sky = sky;

        this._positions = new Float32Array(max * 4 * 3);
        this._uvs = new Float32Array(max * 4 * 2);
        const indices = new Uint32Array(max * 6);
        for (let i = 0; i < max; i++) {
            for (let c = 0; c < 4; c++) this._uvs[(i * 4 + c) * 2] = c;
            const base = i * 4;
            const t = i * 6;
            indices[t] = base;
            indices[t + 1] = base + 1;
            indices[t + 2] = base + 2;
            indices[t + 3] = base + 1;
            indices[t + 4] = base + 3;
            indices[t + 5] = base + 2;
        }

        this.mesh = new Mesh("thrown", scene);
        const geometry = new VertexData();
        geometry.positions = this._positions as unknown as number[];
        geometry.uvs = this._uvs as unknown as number[];
        geometry.indices = indices as unknown as number[];
        // Updatable: the positions ARE the transform, rewritten every frame.
        geometry.applyToMesh(this.mesh, true);
        // Nothing to cull against — the quads are built in the vertex shader, so the bounds
        // Babylon computed from a buffer of zeros would hide every projectile.
        this.mesh.alwaysSelectAsActiveMesh = true;
        this.mesh.isPickable = false;

        this.material = new ShaderMaterial(
            "thrown",
            scene,
            { vertexSource, fragmentSource },
            {
                attributes: ["position", "uv"],
                uniforms: ["viewProjection", "tpCamRight", "tpCamUp", "tpCamFwd", "tpParams", "tpAlbedo", "tpTint", ...SKY_UNIFORMS],
                samplers: [...SKY_SAMPLERS],
                shaderLanguage: ShaderLanguage.WGSL,
            },
        );
        sky.bindTo(this.material);
        this.mesh.material = this.material;
    }

    /** True once the pipeline exists, so Rule 2 can wait behind the loading screen. */
    get compiled(): boolean {
        return this.material.isReady(this.mesh);
    }

    /**
     * Point the quads at the camera and put them where the simulation says.
     *
     * Rule 1: writes into the two arrays it allocated at construction and hands those to
     * Babylon. A projectile that is not in the air gets radius zero, which collapses its
     * quad to a point rather than needing a branch or a shorter draw.
     */
    update(): void {
        const enabled = this._settings.v["sys.verbs"] as boolean;
        const n = enabled ? this._flight.inFlight : 0;
        const src = this._flight.flight;
        const quads = this._uvs.length / 8;

        for (let i = 0; i < quads; i++) {
            const active = i < n;
            const o = i * STRIDE;
            const x = active ? src[o] : 0;
            const y = active ? src[o + 1] : 0;
            const z = active ? src[o + 2] : 0;
            // Sphere of the carried volume: r = (3V / 4pi)^(1/3).
            const radius = active ? Math.cbrt((3 * src[o + 6]) / (4 * Math.PI)) : 0;
            for (let c = 0; c < 4; c++) {
                const v = (i * 4 + c) * 3;
                this._positions[v] = x;
                this._positions[v + 1] = y;
                this._positions[v + 2] = z;
                this._uvs[(i * 4 + c) * 2 + 1] = radius;
            }
        }

        this.mesh.updateVerticesData(VertexBuffer.PositionKind, this._positions);
        this.mesh.updateVerticesData(VertexBuffer.UVKind, this._uvs);

        // Babylon's world matrix rows ARE the camera basis, the same read the post chain
        // and the reflection pass both make.
        const wm = this._camera.getWorldMatrix().m;
        this._right.copyFromFloats(wm[0], wm[1], wm[2]);
        this._up.copyFromFloats(wm[4], wm[5], wm[6]);
        this._fwd.copyFromFloats(wm[8], wm[9], wm[10]);
        this.material.setVector3("tpCamRight", this._right);
        this.material.setVector3("tpCamUp", this._up);
        this.material.setVector3("tpCamFwd", this._fwd);

        const surf = this._biome.current.surface;
        this._params.copyFromFloats(0, this._settings.v["render.exposure"] as number, surf.subsurfaceStrength);
        this._albedo.copyFromFloats(surf.albedo[0], surf.albedo[1], surf.albedo[2]);
        this._tint.copyFromFloats(surf.subsurfaceTint[0], surf.subsurfaceTint[1], surf.subsurfaceTint[2]);
        this.material.setVector3("tpParams", this._params);
        this.material.setVector3("tpAlbedo", this._albedo);
        this.material.setVector3("tpTint", this._tint);
        this._sky.pushTo(this.material);
    }

    dispose(): void {
        this.mesh.dispose();
        this.material.dispose();
    }
}
