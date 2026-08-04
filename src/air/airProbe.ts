import { ProceduralTexture } from "@babylonjs/core/Materials/Textures/Procedurals/proceduralTexture";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Constants } from "@babylonjs/core/Engines/constants";
import { Vector2 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";
import type { Settings } from "../core/settings";
import type { Heightfield } from "../terrain/heightfield";
import type { AirField } from "./airField";

/**
 * The wind at one point, on the CPU.
 *
 * The cloth solver runs on the CPU and needs to know what the air is doing where the
 * character is standing. `AirField.base` is right there and would have been the easy
 * answer — but it is the AMBIENT wind, before the terrain has had its say, and the whole
 * point of Phase 5 is that the terrain has quite a lot to say: the flow speeds up over a
 * crest and separates in a lee, which is why a dune has a slip face at all.
 *
 * So rather than reimplement any of that on the CPU, this renders one texel through
 * `substrateAir` — the same include the smoke and the embers use — and reads it back. A
 * cape that goes slack in the lee of the dune it is walking behind costs a single-pixel
 * render target and no second opinion about what the wind is.
 *
 * Latency is irrelevant here in a way it was not for the ground: wind changes over
 * seconds, not over the 78 milliseconds of a sprinting footfall.
 */

const SOURCE = `
#include<substratePack>
#include<substrateTerrainField>
#include<substrateNoise>
#include<substrateAir>
varying vUV: vec2f;
uniform apAt: vec2f;
@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let air = sbAirAt(uniforms.apAt, sbSampleField(uniforms.apAt).yz);
    // The FULL velocity, all three components. The vertical one is the flow climbing a
    // windward face or dropping down a lee, and it is what lifts a cape rather than just
    // pushing it — writing air.speed here instead, which is the horizontal magnitude,
    // would have had the cloth blown flat against the back on every slope.
    fragmentOutputs.color = vec4f(air.velocity.x, air.velocity.z, air.velocity.y, air.separated);
}`;

export class AirProbe {
    /** Horizontal wind at the sampled point, m/s. */
    readonly velocity = new Vector2(0, 0);
    /** Vertical component, m/s — the flow climbing or dropping over the ground. */
    vertical = 0;
    /** How separated the flow is here: 1 in a lee, 0 on an exposed face. */
    separated = 0;
    valid = false;

    private readonly _scene: Scene;
    private readonly _settings: Settings;
    private readonly _field: Heightfield;
    private readonly _air: AirField;
    private readonly _at = new Vector2(0, 0);
    private _target: ProceduralTexture | null = null;
    private _pending = false;

    constructor(scene: Scene, settings: Settings, field: Heightfield, air: AirField) {
        this._scene = scene;
        this._settings = settings;
        this._field = field;
        this._air = air;
    }

    update(x: number, z: number): void {
        if (!this._settings.v["sys.air"]) {
            this.velocity.set(0, 0);
            this.vertical = 0;
            this.separated = 0;
            return;
        }
        this._at.set(x, z);
        const target = this._ensure();
        target.setTexture("sbFieldTex", this._field.texture);
        target.setVector2("sbFieldOrigin", this._fieldOrigin());
        target.setFloat("sbFieldExtent", this._field.extent);
        target.setFloat("sbFieldSize", this._field.size);
        target.setFloat("sbHeightScale", this._settings.v["terrain.heightScale"]);
        this._air.pushTo(target);
        target.setVector2("apAt", this._at);
        if (!target.isReady()) return;
        target.render();

        if (this._pending) return;
        this._pending = true;
        const read = target.readPixels();
        if (read === null) {
            this._pending = false;
            return;
        }
        read
            .then((pixels) => {
                this._pending = false;
                if (pixels === null) return;
                const d = pixels as Float32Array;
                if (d.length < 4) return;
                this.velocity.set(d[0], d[1]);
                this.vertical = d[2];
                this.separated = d[3];
                this.valid = true;
            })
            .catch(() => {
                this._pending = false;
            });
    }

    dispose(): void {
        this._target?.dispose();
        this._target = null;
    }

    private readonly _origin = new Vector2(0, 0);

    private _fieldOrigin(): Vector2 {
        this._origin.set(this._field.originX, this._field.originZ);
        return this._origin;
    }

    private _ensure(): ProceduralTexture {
        if (this._target !== null) return this._target;
        const target = new ProceduralTexture(
            "airProbe",
            { width: 1, height: 1 },
            { fragmentSource: SOURCE },
            this._scene,
            {
                shaderLanguage: ShaderLanguage.WGSL,
                format: Constants.TEXTUREFORMAT_RGBA,
                type: Constants.TEXTURETYPE_FLOAT,
                samplingMode: Constants.TEXTURE_NEAREST_SAMPLINGMODE,
                generateMipMaps: false,
                skipSceneRegistration: true,
            },
        );
        target.refreshRate = 0;
        this._target = target;
        return target;
    }
}
