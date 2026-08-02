import { CreateGround } from "@babylonjs/core/Meshes/Builders/groundBuilder";
import { CreateCapsule } from "@babylonjs/core/Meshes/Builders/capsuleBuilder";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3, Vector4 } from "@babylonjs/core/Maths/math.vector";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Scene } from "@babylonjs/core/scene";
import type { Camera } from "@babylonjs/core/Cameras/camera";
import type { Settings } from "./settings";
import type { BiomeState } from "./biome";
import type { ElementDef } from "../elements/types";
import vertexSource from "../shaders/phase0.vertex.wgsl?raw";
import fragmentSource from "../shaders/phase0.fragment.wgsl?raw";

/**
 * PHASE 0 PLACEHOLDER WORLD — delete this file when the Phase 1 clipmap lands.
 *
 * A ground plane and a capsule, both drawn by hand-written WGSL. It exists to make
 * the harness observable: you can see that you are moving, that the biome switch is
 * live, and that the WGSL pipeline compiles and warms correctly.
 *
 * It is not a preview of the real material. Phase 1 replaces the ground, Phase 4
 * replaces the shading and Phase 7 replaces the capsule.
 */

const DEG2RAD = Math.PI / 180;
const CAPSULE_HEIGHT = 1.8;
const CAPSULE_RADIUS = 0.35;
const GROUND_EXTENT = 2400;
/**
 * The real haze densities are tuned for the Phase 2 far-range raymarch, which puts
 * terrain at the horizon. With a flat 2.4 km plane and nothing behind it, the plane's
 * edge stays visible at those values, so the placeholder leans on fog harder.
 */
const PHASE0_FOG_GAIN = 6;

const UNIFORMS = ["world", "viewProjection", "baseColor", "lineColor", "sunDir", "sunColor", "ambient", "fogColor", "cameraPos", "params"];

export class Phase0World {
    readonly ground: Mesh;
    readonly character: Mesh;
    readonly materials: ShaderMaterial[];
    readonly meshes: Mesh[];

    /** Linear sky/fog colour. Fed to the shader, which mixes toward it before the transfer. */
    readonly skyColor = new Color3(0, 0, 0);

    private readonly _scene: Scene;
    private readonly _settings: Settings;
    private readonly _groundMat: ShaderMaterial;
    private readonly _charMat: ShaderMaterial;
    private readonly _disposers: (() => void)[] = [];

    // Preallocated uniform scratch — the frame path only mutates these.
    private readonly _sunDir = new Vector3(0, 1, 0);
    private readonly _sunColor = new Color3(1, 1, 1);
    private readonly _ambient = new Color3(0, 0, 0);
    private readonly _groundParams = new Vector4(0, 0, 0, 0);
    private readonly _charParams = new Vector4(1, 0, 0, 0);
    private readonly _baseColor = new Color3(1, 1, 1);
    private readonly _lineColor = new Color3(1, 1, 1);
    private readonly _charColor = new Color3(0.9, 0.35, 0.2);
    private readonly _charLine = new Color3(0.9, 0.35, 0.2);

    private _element: ElementDef;

    constructor(scene: Scene, settings: Settings, biome: BiomeState) {
        this._scene = scene;
        this._settings = settings;
        this._element = biome.current;

        this._groundMat = makeMaterial("phase0Ground", scene);
        this._charMat = makeMaterial("phase0Character", scene);

        this.ground = CreateGround("phase0Ground", { width: GROUND_EXTENT, height: GROUND_EXTENT, subdivisions: 1 }, scene);
        this.ground.material = this._groundMat;
        this.ground.isPickable = false;

        this.character = CreateCapsule("phase0Character", { height: CAPSULE_HEIGHT, radius: CAPSULE_RADIUS, tessellation: 20, subdivisions: 1 }, scene);
        this.character.material = this._charMat;
        this.character.isPickable = false;

        this.materials = [this._groundMat, this._charMat];
        this.meshes = [this.ground, this.character];

        this._disposers.push(biome.onChange((def) => this._applyElement(def)));
        this._disposers.push(
            settings.on("debug.wireframe", (on) => {
                this._groundMat.wireframe = on;
                this._charMat.wireframe = on;
            }),
        );
        this._groundMat.wireframe = settings.get("debug.wireframe");
        this._charMat.wireframe = settings.get("debug.wireframe");
    }

    /** Place the visual capsule from the controller's feet position. */
    setCharacterPose(feet: Vector3, facingYaw: number): void {
        this.character.position.set(feet.x, feet.y + CAPSULE_HEIGHT * 0.5, feet.z);
        this.character.rotation.y = facingYaw;
    }

    /** Push per-frame uniforms. Allocation-free. */
    update(camera: Camera): void {
        const s = this._settings.v;
        const el = this._element;

        const elevation = s["world.sunElevation"] * DEG2RAD;
        const azimuth = s["world.sunAzimuth"] * DEG2RAD;
        const cosE = Math.cos(elevation);
        this._sunDir.set(cosE * Math.sin(azimuth), Math.sin(elevation), cosE * Math.cos(azimuth));

        // Direct sun dims and warms as it drops. Phase 2 replaces this with the real
        // Nishita transmittance integral — the shape of the falloff is the same idea.
        //
        // These gains are deliberately conservative. Snow's albedo is ~0.9, so anything
        // near 2.0 here clips the whole surface to flat white and the grid disappears
        // with it. Phase 9's tonemapper is what earns the right to push light harder.
        const horizonFade = Math.max(0, Math.min(1, (s["world.sunElevation"] + 4) / 14));
        const intensity = 0.15 + 1.05 * horizonFade * horizonFade;
        this._sunColor.set(el.sunTint[0] * intensity, el.sunTint[1] * intensity, el.sunTint[2] * intensity);

        // Ambient as bounce + emission — the Phase 2 split, at Phase 0 fidelity.
        const bounce = el.atmosphere.groundBounce * (0.05 + 0.2 * horizonFade);
        this._ambient.set(
            el.atmosphere.groundAlbedo[0] * bounce + el.atmosphere.emissiveAmbient[0],
            el.atmosphere.groundAlbedo[1] * bounce + el.atmosphere.emissiveAmbient[1],
            el.atmosphere.groundAlbedo[2] * bounce + el.atmosphere.emissiveAmbient[2],
        );

        this._updateSkyColor(horizonFade);

        const exposure = s["render.exposure"];
        const fog = el.atmosphere.hazeDensity * PHASE0_FOG_GAIN;
        this._groundParams.set(0, fog, exposure, 0);
        this._charParams.set(1, fog, exposure, 0);

        const camPos = camera.globalPosition;

        // The grid pattern is computed from world XZ in the shader, so sliding the plane
        // under the camera keeps the lines pinned in world space while the ground edge
        // stays a constant distance away. You cannot walk off the world, and the horizon
        // never shows the square boundary of the mesh.
        this.ground.position.x = camPos.x;
        this.ground.position.z = camPos.z;

        // The shader mixes toward the LINEAR sky colour and then applies the transfer, so
        // the clear colour has to be encoded the same way or the horizon shows a hard
        // seam where fogged ground meets unfogged sky.
        const e = Math.pow(2, s["render.exposure"]);
        const clear = this._scene.clearColor;
        clear.set(encode(this.skyColor.r * e), encode(this.skyColor.g * e), encode(this.skyColor.b * e), 1);

        const ground = this._groundMat;
        ground.setColor3("baseColor", this._baseColor);
        ground.setColor3("lineColor", this._lineColor);
        ground.setVector3("sunDir", this._sunDir);
        ground.setColor3("sunColor", this._sunColor);
        ground.setColor3("ambient", this._ambient);
        ground.setColor3("fogColor", this.skyColor);
        ground.setVector3("cameraPos", camPos);
        ground.setVector4("params", this._groundParams);

        const char = this._charMat;
        char.setColor3("baseColor", this._charColor);
        char.setColor3("lineColor", this._charLine);
        char.setVector3("sunDir", this._sunDir);
        char.setColor3("sunColor", this._sunColor);
        char.setColor3("ambient", this._ambient);
        char.setColor3("fogColor", this.skyColor);
        char.setVector3("cameraPos", camPos);
        char.setVector4("params", this._charParams);
    }

    /** True once every pipeline is compiled and safe to draw. */
    isReady(): boolean {
        return this._groundMat.isReady(this.ground) && this._charMat.isReady(this.character);
    }

    dispose(): void {
        for (const off of this._disposers) off();
        this._disposers.length = 0;
        this.ground.dispose();
        this.character.dispose();
        this._groundMat.dispose();
        this._charMat.dispose();
    }

    private _applyElement(def: ElementDef): void {
        this._element = def;
        const a = def.surface.albedo;
        this._baseColor.set(a[0], a[1], a[2]);
        // A proportional darkening rather than the compacted albedo: compacted snow is
        // only slightly darker than fresh, which left the grid invisible. Scaling the
        // base keeps the same relative contrast in every biome, including the dark ones.
        this._lineColor.set(a[0] * 0.45, a[1] * 0.45, a[2] * 0.45);
    }

    /**
     * Placeholder sky. Turbidity washes the zenith toward the sun's colour, emission
     * lifts the floor, and elevation scales the whole thing. Phase 2 deletes this.
     */
    private _updateSkyColor(horizonFade: number): void {
        const atm = this._element.atmosphere;
        const clarity = 1 / (1 + atm.turbidity * 0.22);
        const zenithR = 0.1 * atm.rayleighScale;
        const zenithG = 0.19 * atm.rayleighScale;
        const zenithB = 0.38 * atm.rayleighScale;
        const sun = this._element.sunTint;
        const brightness = 0.1 + 0.9 * horizonFade;
        this.skyColor.set(
            (zenithR * clarity + sun[0] * 0.55 * (1 - clarity)) * brightness + atm.emissiveAmbient[0],
            (zenithG * clarity + sun[1] * 0.55 * (1 - clarity)) * brightness + atm.emissiveAmbient[1],
            (zenithB * clarity + sun[2] * 0.55 * (1 - clarity)) * brightness + atm.emissiveAmbient[2],
        );
    }
}

/** The same transfer the fragment shader applies, so sky and fogged ground agree exactly. */
function encode(linear: number): number {
    return Math.pow(Math.max(0, linear), 1 / 2.2);
}

function makeMaterial(name: string, scene: Scene): ShaderMaterial {
    return new ShaderMaterial(
        name,
        scene,
        { vertexSource, fragmentSource },
        {
            attributes: ["position", "normal"],
            uniforms: UNIFORMS,
            shaderLanguage: ShaderLanguage.WGSL,
        },
    );
}
