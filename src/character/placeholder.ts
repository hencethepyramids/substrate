import { CreateCapsule } from "@babylonjs/core/Meshes/Builders/capsuleBuilder";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector4, type Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Scene } from "@babylonjs/core/scene";
import type { Camera } from "@babylonjs/core/Cameras/camera";
import type { Settings } from "../core/settings";
import { Sky, SKY_UNIFORMS, SKY_SAMPLERS, WORLD_GROUP } from "../render/sky";
import vertexSource from "../shaders/phase0.vertex.wgsl?raw";
import fragmentSource from "../shaders/phase0.fragment.wgsl?raw";

/**
 * PLACEHOLDER CHARACTER — a capsule. Phase 7 replaces it with the lofted 18-bone
 * figure, the solved gait machine and the cloth solver.
 *
 * It exists so the spring arm has something to orbit and so grounding against the
 * heightfield is visible: if the capsule floats or sinks as you walk, the CPU mirror
 * and the drawn surface have diverged.
 */
const HEIGHT = 1.8;
const RADIUS = 0.35;

export class PlaceholderCharacter {
    readonly mesh: Mesh;
    readonly material: ShaderMaterial;

    private readonly _settings: Settings;
    private readonly _sky: Sky;
    private readonly _params = new Vector4(1, 0, 0, 0);
    private readonly _albedo = new Color3(0.62, 0.24, 0.14);

    constructor(scene: Scene, settings: Settings, sky: Sky) {
        this._settings = settings;
        this._sky = sky;

        this.material = new ShaderMaterial(
            "placeholderCharacter",
            scene,
            { vertexSource, fragmentSource },
            {
                attributes: ["position", "normal"],
                uniforms: ["world", "viewProjection", "baseColor", "lineColor", "cameraPos", "params", ...SKY_UNIFORMS],
                samplers: [...SKY_SAMPLERS],
                shaderLanguage: ShaderLanguage.WGSL,
            },
        );
        sky.bindTo(this.material);

        this.mesh = CreateCapsule("placeholderCharacter", { height: HEIGHT, radius: RADIUS, tessellation: 20, subdivisions: 1 }, scene);
        this.mesh.material = this.material;
        this.mesh.isPickable = false;
        this.mesh.renderingGroupId = WORLD_GROUP;
    }

    /** Feet position in, capsule centre out. */
    setPose(feet: Vector3, facingYaw: number): void {
        this.mesh.position.set(feet.x, feet.y + HEIGHT * 0.5, feet.z);
        this.mesh.rotation.y = facingYaw;
    }

    update(camera: Camera): void {
        const s = this._settings.v;
        this.mesh.setEnabled(s["sys.character"]);
        if (!s["sys.character"]) return;

        this._params.set(1, s["render.exposure"], 0, 0);

        const m = this.material;
        m.setColor3("baseColor", this._albedo);
        m.setColor3("lineColor", this._albedo);
        m.setVector3("cameraPos", camera.globalPosition);
        m.setVector4("params", this._params);
        this._sky.pushTo(m);
    }

    isReady(): boolean {
        return this.material.isReady(this.mesh);
    }

    dispose(): void {
        this.mesh.dispose();
        this.material.dispose();
    }
}
