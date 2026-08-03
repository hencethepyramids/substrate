import { ProceduralTexture } from "@babylonjs/core/Materials/Textures/Procedurals/proceduralTexture";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Constants } from "@babylonjs/core/Engines/constants";
import { Vector2, Vector4 } from "@babylonjs/core/Maths/math.vector";
import type { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import type { Scene } from "@babylonjs/core/scene";
import type { TargetCamera } from "@babylonjs/core/Cameras/targetCamera";
import type { WebGPUPerfCounter } from "@babylonjs/core/Engines/WebGPU/webgpuPerfCounter";
import type { Settings } from "../core/settings";
import type { BiomeState } from "../core/biome";
import type { ElementDef } from "../elements/types";
import type { Heightfield } from "../terrain/heightfield";
import { nextFrame } from "../core/loading";
// A ProceduralTexture collects its uniform names from the setters themselves, so this
// pass needs the pusher but not SUBSTRATE_PARAM_UNIFORMS — that list is for the
// ShaderMaterials of Phases 4 and 5, which have to declare what they read up front.
import { pushSubstrateParams } from "./substrateParams";
import relaxSource from "../shaders/substrateRelax.fragment.wgsl?raw";

/**
 * The substrate buffer: what the ground remembers.
 *
 * A camera-following square window, ping-ponged between two RGBA32F targets with one
 * relaxation pass per frame. Channels are documented in shaders/lib/substrateBuffer.wgsl
 * — depression, loose mass, compaction, phase state.
 *
 * Two decisions carry most of the weight:
 *
 * THE WINDOW SNAPS TO ITS OWN TEXEL GRID. A frame's scroll is therefore a whole number
 * of texels, and carrying last frame's contents forward is an exact integer copy rather
 * than a resample. Walking cannot blur what is carved into the ground, and a hollow
 * does not creep across the world while you circle it.
 *
 * NOTHING READS BACK. The buffer is written and sampled entirely on the GPU. The one
 * exception is a 64-texel probe at boot, which checks that a stamp at a known world
 * position is found at that world position when read back through the shared include —
 * the same measurement-not-assertion the heightfield and the sky LUT both carry, for
 * the same reason: a whole-buffer mirror in Z is invisible until it is expensive.
 *
 * Allocation-free after construction.
 */

/** Uniforms a material needs to declare to include substrateBuffer. */
export const SUBSTRATE_UNIFORMS = ["sbSubOrigin", "sbSubExtent", "sbSubSize", "sbSubFade"] as const;
/** Samplers likewise. Bind them with `substrate.bindTo(material)`, every frame. */
export const SUBSTRATE_SAMPLERS = ["sbSubTex"] as const;

/** Texels of edge ramp. Wide enough that geometry never steps at the window boundary. */
const FADE_TEXELS = 8;

/**
 * Longest step the relaxation is asked to take. The slump limiter is stable well past
 * this, but a 200 ms hitch should not also produce 200 ms of collapse in one frame —
 * the simulation slows down rather than jumping.
 *
 * SR_DIFF_GAIN in substrateRelax.fragment.wgsl is sized against this number: it is the
 * worst step the diffusion coefficient has to stay stable at without clamping. Raise
 * this and that gain has to come down, or the fastest elements start clamping and stop
 * being distinguishable from each other.
 */
const MAX_STEP = 1 / 30;

/** Texels across the boot probe. */
const PROBE_WIDTH = 64;

/**
 * Carves waiting for a step. One lands per frame, and the only source that can outrun
 * that is a footfall landing on the same frame as a held carve — so this is deep enough
 * to be irrelevant, and `dropped` says so if it ever is not.
 */
const QUEUE_LENGTH = 16;

/**
 * Reads the buffer back through the shared include, along an oblique world line, and
 * reports the world position it read at.
 *
 * Oblique (z = 0.43x through the stamp) so that a whole-buffer flip in Z changes the
 * answer — along an axis-aligned line through the centre it would not. Carrying the
 * world coordinate out in gb means the comparison needs no assumption about which way
 * readPixels orders its rows.
 */
const PROBE_SOURCE = `
#include<substrateBuffer>
varying vUV: vec2f;
uniform svCentre: vec2f;
uniform svSpan: f32;
@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let t = (input.vUV.x - 0.5) * uniforms.svSpan;
    let p = uniforms.svCentre + vec2f(t, t * 0.43);
    let s = sbSubstrateAt(p);
    fragmentOutputs.color = vec4f(s.depression, p.x, p.y, s.mass);
}`;

export class Substrate {
    /** Relaxation steps since boot. Shown in the overlay next to the sky's bake count. */
    steps = 0;
    /** False if the relaxation pass failed to compile. */
    compiled = false;

    private readonly _scene: Scene;
    private readonly _settings: Settings;
    private readonly _field: Heightfield;
    private readonly _disposers: (() => void)[] = [];

    private readonly _targets: ProceduralTexture[];
    private _front = 0;

    private _element: ElementDef;
    private _size: number;
    private _extent: number;
    private _prepared = false;
    /** False until a window origin has been established, so the first step cannot shift. */
    private _windowValid = false;
    /** Set while the system is off, so it clears once rather than every frame. */
    private _cleared = false;

    // Preallocated: update() runs every frame and rule 1 says frame() allocates nothing.
    private readonly _origin = new Vector2(0, 0);
    private readonly _prevOrigin = new Vector2(0, 0);
    private readonly _shift = new Vector2(0, 0);
    private readonly _fieldOrigin = new Vector2(0, 0);
    private readonly _step = new Vector4(0, 0, 1, 0);
    private readonly _stamp = new Vector4(0, 0, 1, 0);
    private readonly _probeCentre = new Vector2(0, 0);
    /** Ring of (x, z, radius, depth). Preallocated — rule 1 reaches in here every frame. */
    private readonly _queue = new Float32Array(QUEUE_LENGTH * 4);
    private _qHead = 0;
    private _pending = 0;

    private _probe: ProceduralTexture | null = null;

    constructor(scene: Scene, settings: Settings, biome: BiomeState, field: Heightfield) {
        this._scene = scene;
        this._settings = settings;
        this._field = field;
        this._element = biome.current;
        this._size = settings.get("substrate.resolution");
        this._extent = settings.get("substrate.extent");
        this._fieldOrigin.set(field.originX, field.originZ);

        this._targets = [this._createTarget("substrateA"), this._createTarget("substrateB")];
        // Each reads the other. Set once — the pair alternates by swapping which one is
        // rendered, never by rewiring what they sample.
        this._targets[0].setTexture("srPrev", this._targets[1]);
        this._targets[1].setTexture("srPrev", this._targets[0]);

        this._disposers.push(biome.onChange((def) => (this._element = def)));
        // Deliberately NOT cleared on a biome switch. Carving a pit in snow and then
        // switching to desert to watch the same buffer collapse is the shortest
        // demonstration that the elements differ by numbers and nothing else.

        this._disposers.push(
            settings.on("substrate.resolution", (res) => {
                this._size = res;
                for (const t of this._targets) t.resize(res, false);
                this._invalidate();
            }),
        );
        this._disposers.push(
            settings.on("substrate.extent", (m) => {
                this._extent = m;
                // Metres per texel changed, so last frame's contents no longer line up
                // with this frame's grid at any integer offset.
                this._invalidate();
            }),
        );
    }

    get ready(): boolean {
        return this._prepared && this._targets[0].isReady() && this._targets[1].isReady();
    }

    /**
     * GPU time for the relaxation pass, when the adapter granted timestamp-query.
     *
     * Rule 7: resolved per call, not cached. ProceduralTexture keeps its wrapper
     * private and replaces it on every resize, so a held reference would report a
     * stale number forever — which is worse than reporting none.
     */
    get gpuTime(): WebGPUPerfCounter | undefined {
        return (this._targets[this._front] as unknown as { _rtWrapper?: { gpuTimeInFrame?: WebGPUPerfCounter } | null })._rtWrapper?.gpuTimeInFrame;
    }

    /**
     * Compile the pass, clear both buffers, and check that what the relaxation writes is
     * what the shared include reads. Runs behind the loading screen.
     */
    async prepare(report?: (fraction: number) => void): Promise<void> {
        // Every uniform the pass reads, on both targets, BEFORE the readiness loop.
        // isReady() is what builds the effect, and a name it has never seen registers
        // no slot to write into afterwards.
        for (const t of this._targets) {
            this._pushConstants(t);
            this._pushFrame(t);
        }
        for (let guard = 0; guard < 600 && !(this._targets[0].isReady() && this._targets[1].isReady()); guard++) {
            await nextFrame();
        }
        this.compiled = this._targets[0].isReady() && this._targets[1].isReady();
        if (!this.compiled) console.error("[substrate] substrate relaxation shader never became ready");
        report?.(0.4);

        this._clear();
        if (this.compiled) await this._verifyOrientation();

        this._prepared = true;
        report?.(1);
    }

    /**
     * Advance the simulation one step. Must run before scene.render() and before the
     * terrain pushes its uniforms — the beauty pass samples what this writes.
     *
     * @param dt simulation seconds, already scaled and zeroed by the pause.
     */
    update(camera: TargetCamera, dt: number): void {
        const s = this._settings.v;

        if (!s["sys.substrate"]) {
            // Put the ground back rather than freezing whatever was carved into it.
            if (!this._cleared) this._clear();
            return;
        }
        this._cleared = false;

        const step = Math.min(Math.max(dt, 0), MAX_STEP);
        // Paused means paused: the window stops following too, so unpausing resumes the
        // same square of ground rather than one that scrolled while nothing simulated.
        // A queued carve still lands, so the test-pit button works on a paused world.
        if (step <= 0 && this._pending === 0) return;

        this._dequeue();

        const texel = this._extent / this._size;
        const camPos = camera.globalPosition;
        this._origin.set(Math.floor((camPos.x - this._extent * 0.5) / texel) * texel, Math.floor((camPos.z - this._extent * 0.5) / texel) * texel);

        if (this._windowValid) {
            // shift = (new origin - old origin) / texel, because the contract is
            // `old = new + shift`: texel c of this window sits at
            //     originNew + (c + 0.5) * texel,
            // last frame's texel p sat at originPrev + (p + 0.5) * texel, and setting
            // those equal gives p = c + (originNew - originPrev) / texel. Subtracting
            // the other way round scrolls the buffer backwards, which moves everything
            // carved into the ground at twice walking pace.
            this._shift.set(Math.round((this._origin.x - this._prevOrigin.x) / texel), Math.round((this._origin.y - this._prevOrigin.y) / texel));
        } else {
            this._shift.set(0, 0);
            this._windowValid = true;
        }

        this._step.set(step, 0, s["substrate.relaxRate"], 0);
        this._render();
        this._prevOrigin.copyFrom(this._origin);
    }

    /**
     * Queue a pit: a volume-neutral bowl of `depth` metres over `radius`, with its own
     * rim. Negative depth heaps material up instead.
     *
     * One stamp lands per relaxation step, so this queues rather than overwrites. A
     * frame that produces both a footfall and a held carve is common and the second one
     * must not silently replace the first. The queue is never deep in practice — a
     * sprint at 7.7 m/s lays a print every ninth frame — and `pending` is on the overlay
     * so a backlog is visible rather than guessed at.
     */
    stamp(x: number, z: number, radius: number, depth: number): void {
        if (depth === 0) return;
        if (this._pending >= QUEUE_LENGTH) {
            this.dropped++;
            return;
        }
        const i = ((this._qHead + this._pending) % QUEUE_LENGTH) * 4;
        this._queue[i] = x;
        this._queue[i + 1] = z;
        this._queue[i + 2] = Math.max(radius, 1e-3);
        this._queue[i + 3] = depth;
        this._pending++;
    }

    /** Stamps waiting for a step. */
    get pending(): number {
        return this._pending;
    }

    /** Stamps thrown away because the queue was full. Should stay at zero. */
    dropped = 0;

    /** Move the next queued stamp into the uniform, or disarm it. */
    private _dequeue(): void {
        if (this._pending === 0) {
            this._stamp.w = 0;
            return;
        }
        const i = this._qHead * 4;
        this._stamp.set(this._queue[i], this._queue[i + 1], this._queue[i + 2], this._queue[i + 3]);
        this._qHead = (this._qHead + 1) % QUEUE_LENGTH;
        this._pending--;
    }

    /** Wipe the buffer. The overlay hangs a button off this. */
    reset(): void {
        this._clear();
    }

    /**
     * Point a material's substrate sampler at the current front buffer.
     *
     * Every frame, not once: the pair alternates, so a binding taken at construction
     * would be a frame stale half the time and would alias the target being written the
     * other half.
     */
    bindTo(material: ShaderMaterial): void {
        material.setTexture("sbSubTex", this._targets[this._front]);
    }

    /** Push the window uniforms every consumer shares. Once per frame, per material. */
    pushTo(material: ShaderMaterial): void {
        material.setVector2("sbSubOrigin", this._origin);
        material.setFloat("sbSubExtent", this._extent);
        material.setFloat("sbSubSize", this._size);
        material.setFloat("sbSubFade", FADE_TEXELS);
    }

    dispose(): void {
        for (const off of this._disposers) off();
        this._disposers.length = 0;
        this._probe?.dispose();
        this._probe = null;
        for (const t of this._targets) t.dispose();
    }

    // -- internals -----------------------------------------------------------

    private _createTarget(name: string): ProceduralTexture {
        const tex = new ProceduralTexture(
            name,
            this._size,
            { fragmentSource: relaxSource },
            this._scene,
            {
                shaderLanguage: ShaderLanguage.WGSL,
                format: Constants.TEXTUREFORMAT_RGBA,
                // Full float, not half: depression is metres and compaction is a
                // fraction, in the same texel, and this state feeds itself back every
                // frame. Half-float rounding accumulates into visible terracing over a
                // few thousand steps. Nothing filters it — every read is a textureLoad —
                // so this costs nothing but memory.
                type: Constants.TEXTURETYPE_FLOAT,
                samplingMode: Constants.TEXTURE_NEAREST_SAMPLINGMODE,
                generateMipMaps: false,
                // Nothing else should ever render this. It is driven by hand.
                skipSceneRegistration: true,
            },
        );
        tex.refreshRate = 0;
        tex.wrapU = Constants.TEXTURE_CLAMP_ADDRESSMODE;
        tex.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
        return tex;
    }

    /** Render one step into the back buffer and make it the front. */
    private _render(): void {
        const back = this._targets[1 - this._front];
        if (!back.isReady()) return;

        this._pushConstants(back);
        this._pushFrame(back);
        back.render();

        this._front = 1 - this._front;
        this.steps++;
    }

    /** What the pass reads but a frame does not change. Only the target that draws needs it. */
    private _pushConstants(target: ProceduralTexture): void {
        target.setFloat("srSize", this._size);
        target.setFloat("srTexel", this._extent / this._size);
        // The relaxation reads the same heightfield the clipmap is displaced by, so slump
        // sees the total surface rather than the buffer floating on a plane of its own.
        target.setTexture("sbFieldTex", this._field.texture);
        target.setVector2("sbFieldOrigin", this._fieldOrigin);
        target.setFloat("sbFieldExtent", this._field.extent);
        target.setFloat("sbFieldSize", this._field.size);
        target.setFloat("sbHeightScale", this._settings.v["terrain.heightScale"]);
        pushSubstrateParams(target, this._element);
    }

    private _pushFrame(target: ProceduralTexture): void {
        target.setVector2("srOrigin", this._origin);
        target.setVector2("srShift", this._shift);
        target.setVector4("srStep", this._step);
        target.setVector4("srStamp", this._stamp);
    }

    /** Zero both buffers, in place, through the pass's own reset path. */
    private _clear(): void {
        if (!this._targets[0].isReady() || !this._targets[1].isReady()) return;
        this._step.set(0, 1, 0, 0);
        this._stamp.set(0, 0, 1, 0);
        this._shift.set(0, 0);
        this._qHead = 0;
        this._pending = 0;
        for (const t of this._targets) {
            this._pushConstants(t);
            this._pushFrame(t);
            t.render();
        }
        this._step.set(0, 0, 1, 0);
        this._cleared = true;
        this._windowValid = false;
    }

    /** Drop the buffer's contents: they no longer describe this window. */
    private _invalidate(): void {
        this._windowValid = false;
        if (this._prepared) this._clear();
    }

    /**
     * Check that a stamp at a known world position is found at that world position when
     * read back through substrateBuffer.
     *
     * This closes the one gap the ping-pong cannot close on its own. The pass derives a
     * texel from vUV and a world position from that texel; the shared include derives a
     * texel from a world position. If those two disagree — a flip in Z, an axis swap —
     * the buffer is perfectly self-consistent and completely wrong, every carve lands
     * mirrored about the window centre, and it moves as the window scrolls. The
     * heightfield's Z mirror and the sky LUT's v flip were both exactly this bug, and
     * both survived a phase because they looked plausible.
     *
     * So: clear, stamp at an asymmetric offset from the window centre, take one step
     * with dt = 0 (which is the stamp and nothing else), and read the profile back
     * along an oblique line. One 64-texel readback, once.
     */
    private async _verifyOrientation(): Promise<void> {
        const texel = this._extent / this._size;
        const radius = Math.max(this._extent * 0.02, 0.4);
        const depth = 0.5;

        // A fixed window, independent of wherever the camera happens to be at boot.
        this._origin.set(Math.floor(-this._extent * 0.5 / texel) * texel, Math.floor(-this._extent * 0.5 / texel) * texel);
        this._prevOrigin.copyFrom(this._origin);
        this._shift.set(0, 0);

        // Asymmetric in both axes, so a Z flip, an X flip and an axis swap all move the
        // stamp far enough off the probe line to read as an error near 1.
        this._probeCentre.set(this._origin.x + this._extent * 0.68, this._origin.y + this._extent * 0.39);
        // Straight into the uniform rather than through the queue: this is not a step of
        // the simulation, it is one stamp with dt = 0 and nothing else.
        this._stamp.set(this._probeCentre.x, this._probeCentre.y, radius, depth);
        this._step.set(0, 0, 0, 0);
        this._render();

        try {
            const placed = await this._readProbe(radius);
            if (!placed || placed.length < PROBE_WIDTH) {
                console.warn("[substrate] window orientation check skipped: no probe data");
                return;
            }
            const placeError = this._profileError(placed, radius, depth);
            console.info(`[substrate] window orientation: stamp found where it was placed (error ${(placeError * 100).toFixed(2)}% of depth)`);
            if (placeError > 0.05) {
                console.warn(`[substrate] the relaxation pass and substrateBuffer disagree about where a world position lives in the buffer by ${(placeError * 100).toFixed(0)}% of a stamp — every carve will land in the wrong place`);
            }

            // NOW SCROLL THE WINDOW AND LOOK FOR THE STAMP IN THE SAME PLACE.
            //
            // The check above ran on a stationary window and therefore proved only half
            // of what matters. The other half is that the buffer is world-locked while
            // the window slides under it — and the sign of that shift shipped inverted,
            // which sends everything carved into the ground drifting at twice walking
            // pace. It is obvious the moment anyone walks and completely invisible to a
            // check that never moves. Eleven texels one way and seven the other, so a
            // sign error displaces the profile by more than the stamp's own radius and
            // an axis swap does too.
            this._prevOrigin.copyFrom(this._origin);
            this._origin.set(this._origin.x + texel * 11, this._origin.y - texel * 7);
            this._shift.set(Math.round((this._origin.x - this._prevOrigin.x) / texel), Math.round((this._origin.y - this._prevOrigin.y) / texel));
            this._stamp.w = 0;
            this._render();

            const scrolled = await this._readProbe(radius);
            if (!scrolled || scrolled.length < PROBE_WIDTH) {
                console.warn("[substrate] window scroll check skipped: no probe data");
                return;
            }
            const scrollError = this._profileError(scrolled, radius, depth);
            console.info(`[substrate] window scroll: stamp stayed put across an 11 x -7 texel scroll (error ${(scrollError * 100).toFixed(2)}% of depth)`);
            if (scrollError > 0.05) {
                console.warn(`[substrate] the buffer is NOT world-locked — a scrolling window drags its contents by ${(scrollError * 100).toFixed(0)}% of a stamp, so anything carved into the ground will slide as you walk`);
            }
        } catch (err) {
            console.warn("[substrate] window orientation check failed:", err);
        } finally {
            this._clear();
        }
    }

    private async _readProbe(radius: number): Promise<Float32Array | null> {
        if (this._probe === null) {
            this._probe = new ProceduralTexture(
                "substrateProbe",
                { width: PROBE_WIDTH, height: 1 },
                { fragmentSource: PROBE_SOURCE },
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
            this._probe.refreshRate = 0;
        }
        const probe = this._probe;
        probe.setTexture("sbSubTex", this._targets[this._front]);
        probe.setVector2("sbSubOrigin", this._origin);
        probe.setFloat("sbSubExtent", this._extent);
        probe.setFloat("sbSubSize", this._size);
        probe.setFloat("sbSubFade", FADE_TEXELS);
        probe.setVector2("svCentre", this._probeCentre);
        probe.setFloat("svSpan", radius * 3.2);

        for (let guard = 0; guard < 600 && !probe.isReady(); guard++) {
            await nextFrame();
        }
        probe.render();
        return (await probe.readPixels(0, 0, null, true, false, 0, 0, PROBE_WIDTH, 1)) as Float32Array | null;
    }

    /**
     * Mean disagreement between the profile the buffer holds and the kernel that was
     * stamped into it, as a fraction of the stamp's depth.
     *
     * The expected value is recomputed here from scratch rather than shared with the
     * shader — a verifier that imports the thing it verifies checks nothing.
     */
    private _profileError(data: Float32Array, radius: number, depth: number): number {
        const stride = Math.max(1, Math.round(data.length / PROBE_WIDTH));
        const pack = this._element.substrate.cohesion;
        let sum = 0;
        for (let i = 0; i < PROBE_WIDTH; i++) {
            const measured = data[i * stride];
            const dx = data[i * stride + 1] - this._probeCentre.x;
            const dz = data[i * stride + 2] - this._probeCentre.y;
            const u2 = (dx * dx + dz * dz) / (radius * radius);
            const k = (1 - u2) * Math.exp(-u2);
            const expected = depth * (Math.max(k, 0) - Math.max(-k, 0) * (1 - pack));
            sum += Math.abs(measured - expected);
        }
        return sum / (PROBE_WIDTH * depth);
    }
}
