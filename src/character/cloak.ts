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
import type { AirProbe } from "../air/airProbe";
import type { Gait } from "./gait";
import { B, P, type Skeleton } from "./skeleton";
import cloakVertex from "../shaders/cloak.vertex.wgsl?raw";
import figureFragment from "../shaders/figure.fragment.wgsl?raw";

/**
 * The cloak: a Verlet cloth, moved by the wind that carves the dunes.
 *
 * THE WIND IS THE SAME WIND. Not a similar one, not a sine — the velocity comes from
 * `sbAirAt` through `AirProbe`, which is the include the smoke plumes and the embers
 * ride. So the cape fills on an exposed crest and goes slack in the lee of the dune the
 * character has just walked behind, without anyone writing a rule that says so, and it
 * agrees with the plume drifting past it because they are reading the same function.
 *
 * Solved on the CPU, unlike almost everything else here, and deliberately: the cloth has
 * to stay off the body, and a collision against the figure's own spine is a few lines
 * against a skeleton that already exists on this side of the bus. A hundred and seventeen
 * particles at six iterations is nothing next to one clipmap draw.
 *
 * Verlet with a FIXED substep. Position-based integration is only stable at a fixed dt,
 * and a frame rate that swings between 60 and 240 is exactly what makes a variable-dt
 * cloth explode the first time someone alt-tabs.
 *
 * Allocation-free after construction.
 */

/** Particles across the back, and down. Odd across so there is a centre column. */
const COLS = 9;
const ROWS = 13;
const COUNT = COLS * ROWS;

/**
 * Cloth substep, seconds.
 *
 * SET BY HOW FAR THE ANCHORS MOVE, not by what looks like a reasonable physics rate. The
 * seam is pinned to a body travelling at 3.2 m/s, and the rest length between rows is
 * 6.8 cm — so at 120 Hz the anchor jumps 2.7 cm between steps, which is 40% of an edge,
 * and no number of relaxation iterations makes that look like cloth. It measured at a
 * median 28% edge stretch while walking and peaks over 150%. At 240 Hz the jump is 1.3 cm,
 * and it is interpolated across the substeps on top of that.
 */
const SUBSTEP = 1 / 240;
/** Substeps chased in one frame. A hitch slows the cloth; it does not detonate it. */
const MAX_SUBSTEPS = 8;

/** Gravity. The one place in this project that needed it, so it lives here. */
const GRAVITY = -9.81;

/**
 * How far the cloth is held off the spine, in metres.
 *
 * IT MUST BE SMALLER THAN THE OFFSET THE CLOAK IS SEWN AT, and getting that backwards is
 * the single worst-behaved thing cloth does. At 0.20 the capsule swallowed the seam: the
 * anchors sit 12 cm behind the spine and are pinned, while every particle just below them
 * was ejected to 20 cm on every substep, so the top edge fought the pins for ever and the
 * first row stretched 76% past its rest length. The sheet came out crumpled onto one
 * shoulder and looked, plausibly, like a solver that had simply diverged.
 *
 * The chest's own half-depth at the shoulders is 0.118, so this sits just outside the
 * surface the loft draws.
 */
const BODY_RADIUS = 0.145;

export class Cloak {
    readonly mesh: Mesh;
    readonly material: ShaderMaterial;
    compiled = false;

    private readonly _settings: Settings;
    private readonly _sky: Sky;
    private readonly _shadows: Shadows;
    private readonly _skeleton: Skeleton;
    private readonly _probe: AirProbe;

    /** Current and previous positions, world space. Verlet keeps velocity in the gap. */
    private readonly _pos = new Float32Array(COUNT * 3);
    private readonly _prev = new Float32Array(COUNT * 3);
    private readonly _normal = new Float32Array(COUNT * 3);
    /** Where the pinned top row should be this frame, from the skeleton. */
    private readonly _anchor = new Float32Array(COLS * 3);
    /** Last frame's anchor positions, so a substep can interpolate between the two. */
    private readonly _anchorFrom = new Float32Array(COLS * 3);
    /** Rest-space anchor points on the upper back, fed through the chest bone. */
    private readonly _anchorRest = new Float32Array(COLS * 3);

    private readonly _restCol: number;
    private readonly _restRow: number;
    private _accumulator = 0;
    private _seeded = false;

    private readonly _params = new Vector4(0, 0, 0, 0);
    private readonly _cloth = new Color3(0.17, 0.13, 0.15);
    private readonly _tint = new Color3(0.55, 0.22, 0.2);
    private readonly _camera = new Vector3(0, 0, 0);
    /** Spine capsule in world space, for collision: pelvis to neck. */
    private readonly _spine = new Float32Array(6);

    constructor(scene: Scene, settings: Settings, sky: Sky, shadows: Shadows, gait: Gait, probe: AirProbe) {
        this._settings = settings;
        this._sky = sky;
        this._shadows = shadows;
        this._skeleton = gait.skeleton;
        this._probe = probe;

        const width = settings.get("cloth.width");
        const length = settings.get("cloth.length");
        this._restCol = width / (COLS - 1);
        this._restRow = length / (ROWS - 1);

        // The top edge, sewn across the upper back in the REST pose. It goes through the
        // chest bone's palette entry every frame, so it follows the body exactly as the
        // lofted surface over the same bone does.
        for (let c = 0; c < COLS; c++) {
            const t = c / (COLS - 1) - 0.5;
            this._anchorRest[c * 3] = t * width;
            this._anchorRest[c * 3 + 1] = P.chestY + 0.13;
            // Just outside the back the loft draws — its half-depth there is 0.118 — and
            // therefore just outside the collision capsule too, which is what stops the
            // seam and the collision from pulling in opposite directions.
            this._anchorRest[c * 3 + 2] = -0.125 - Math.abs(t) * 0.02;
        }

        this.mesh = new Mesh("cloak", scene);
        const data = new VertexData();
        const indices = new Uint32Array((COLS - 1) * (ROWS - 1) * 6);
        let t = 0;
        for (let r = 0; r < ROWS - 1; r++) {
            for (let c = 0; c < COLS - 1; c++) {
                const a = r * COLS + c;
                indices[t++] = a;
                indices[t++] = a + COLS;
                indices[t++] = a + 1;
                indices[t++] = a + 1;
                indices[t++] = a + COLS;
                indices[t++] = a + COLS + 1;
            }
        }
        data.positions = this._pos as unknown as number[];
        data.normals = this._normal as unknown as number[];
        data.indices = indices as unknown as number[];
        data.applyToMesh(this.mesh, true);

        this.material = new ShaderMaterial(
            "cloak",
            scene,
            { vertexSource: cloakVertex, fragmentSource: figureFragment },
            {
                attributes: ["position", "normal"],
                uniforms: ["viewProjection", "fgCloth", "fgSkin", "fgTint", "fgParams", "fgCameraPos", ...SKY_UNIFORMS, ...SHADOW_UNIFORMS],
                samplers: [...SKY_SAMPLERS, ...SHADOW_SAMPLERS],
                shaderLanguage: ShaderLanguage.WGSL,
            },
        );
        sky.bindTo(this.material);
        shadows.bindTo(this.material);
        // A sheet has two sides and you see both of them.
        this.material.backFaceCulling = false;

        this.mesh.material = this.material;
        this.mesh.renderingGroupId = WORLD_GROUP;
        this.mesh.isPickable = false;
        this.mesh.alwaysSelectAsActiveMesh = true;
        this.mesh.doNotSyncBoundingInfo = true;
    }

    async prepare(): Promise<void> {
        this._push();
        this.compiled = await compileOrWarn("cloak", () => this.material.forceCompilationAsync(this.mesh));
    }

    get ready(): boolean {
        return this.material.isReady(this.mesh);
    }

    /** @param dt simulation seconds, already scaled and zeroed by the pause. */
    update(camera: Camera, dt: number): void {
        const on = this._settings.v["sys.cloth"] && this._settings.v["sys.character"];
        this.mesh.setEnabled(on);
        if (!on) return;

        this._anchorFrom.set(this._anchor);
        this._readAnchors();
        if (!this._seeded) {
            this._anchorFrom.set(this._anchor);
            this._seed();
            this._seeded = true;
        }

        // Fixed substeps. Verlet is only stable at a constant dt, and the accumulator is
        // what keeps a 240 Hz machine and a 60 Hz one solving the same cloth.
        this._accumulator = Math.min(this._accumulator + dt, SUBSTEP * MAX_SUBSTEPS);
        const steps = Math.floor(this._accumulator / SUBSTEP);
        for (let k = 0; k < steps; k++) {
            this._accumulator -= SUBSTEP;
            // THE SEAM MOVES SMOOTHLY ACROSS THE SUBSTEPS. Handing every substep in a
            // frame the same final anchor position makes the first one absorb the whole
            // frame's travel in one jump, and the cloth spends the rest of the frame
            // recovering from a stretch that never physically happened.
            this._step(SUBSTEP, (k + 1) / steps);
        }

        this._computeNormals();
        this.mesh.updateVerticesData("position", this._pos as unknown as number[], false, false);
        this.mesh.updateVerticesData("normal", this._normal as unknown as number[], false, false);

        this._camera.copyFrom(camera.globalPosition);
        this._push();
    }

    dispose(): void {
        this.mesh.dispose();
        this.material.dispose();
    }

    /** Put the whole sheet at rest, hanging straight down from the anchors. */
    private _seed(): void {
        for (let r = 0; r < ROWS; r++) {
            for (let c = 0; c < COLS; c++) {
                const i = (r * COLS + c) * 3;
                this._pos[i] = this._anchor[c * 3];
                this._pos[i + 1] = this._anchor[c * 3 + 1] - r * this._restRow;
                this._pos[i + 2] = this._anchor[c * 3 + 2];
            }
        }
        this._prev.set(this._pos);
    }

    private _readAnchors(): void {
        const sk = this._skeleton;
        for (let c = 0; c < COLS; c++) {
            sk.worldOf(B.chest, this._anchorRest[c * 3], this._anchorRest[c * 3 + 1], this._anchorRest[c * 3 + 2], this._anchor, c * 3);
        }
        // The spine, for collision. Both ends through the palette, so the capsule leans
        // and bobs with the body rather than standing in a fixed place near it.
        sk.worldOf(B.pelvis, 0, P.hip, 0, this._spine, 0);
        sk.worldOf(B.neck, 0, P.neckY, 0, this._spine, 3);
    }

    private _step(dt: number, blend: number): void {
        const s = this._settings.v;

        // CARRY THE WHOLE SHEET WITH THE SEAM FIRST.
        //
        // Without this the body walks out from under the cloth every substep and the
        // entire strain lands on one edge — the pinned row, measured at a median 28% past
        // its rest length and peaks over 400%, always on row 0. Relaxation cannot fix it:
        // Gauss-Seidel propagates one row per iteration, so the correction is still
        // crawling down the sheet when the next substep pulls the seam away again.
        //
        // Translating every particle by the seam's own displacement — position AND
        // previous position, so velocity is untouched — moves the solve into the body's
        // frame, where it only ever sees the residual. The cape still trails, because the
        // drag term works on velocity relative to the air and that difference is exactly
        // what walking creates. What goes away is the part that was never physical.
        let dx = 0;
        let dy = 0;
        let dz = 0;
        for (let c = 0; c < COLS; c++) {
            const p = c * 3;
            dx += this._anchorFrom[p] + (this._anchor[p] - this._anchorFrom[p]) * blend - this._pos[p];
            dy += this._anchorFrom[p + 1] + (this._anchor[p + 1] - this._anchorFrom[p + 1]) * blend - this._pos[p + 1];
            dz += this._anchorFrom[p + 2] + (this._anchor[p + 2] - this._anchorFrom[p + 2]) * blend - this._pos[p + 2];
        }
        dx /= COLS;
        dy /= COLS;
        dz /= COLS;
        for (let i = 0; i < COUNT; i++) {
            const p = i * 3;
            this._pos[p] += dx;
            this._pos[p + 1] += dy;
            this._pos[p + 2] += dz;
            this._prev[p] += dx;
            this._prev[p + 1] += dy;
            this._prev[p + 2] += dz;
        }

        const drag = s["cloth.drag"];
        const damping = Math.exp(-s["cloth.damping"] * dt);
        const wx = this._probe.velocity.x;
        const wz = this._probe.velocity.y;
        const wy = this._probe.vertical;
        const dt2 = dt * dt;

        // How fast the frame itself is moving, which is the body's velocity through the air.
        const carryX = dx / dt;
        const carryY = dy / dt;
        const carryZ = dz / dt;

        this._computeNormals();

        for (let i = COLS; i < COUNT; i++) {
            const p = i * 3;
            const vx = (this._pos[p] - this._prev[p]) * damping;
            const vy = (this._pos[p + 1] - this._prev[p + 1]) * damping;
            const vz = (this._pos[p + 2] - this._prev[p + 2]) * damping;

            // AERODYNAMIC DRAG, PROJECTED ON THE SURFACE NORMAL. A sheet only feels the
            // component of the flow that hits it face on — that is the whole reason cloth
            // billows and fills instead of being shoved sideways like a rock. Taking the
            // relative velocity along the normal is the difference between a cape and a
            // rigid flag on a stick.
            const nx = this._normal[p];
            const ny = this._normal[p + 1];
            const nz = this._normal[p + 2];
            // Apparent wind, in the WORLD frame. The solve runs in the body's frame — the
            // block above carried every particle along with the seam — so a particle at
            // rest against the back has `v` of zero even at a full sprint, and taking the
            // relative wind from that alone would mean a running cape felt no air at all.
            // It hung dead straight, which looks exactly like stiff cloth and is actually
            // a missing term. The frame's own velocity goes back in here and nowhere else.
            const rx = wx - (vx / dt + carryX);
            const ry = wy - (vy / dt + carryY);
            const rz = wz - (vz / dt + carryZ);
            const along = rx * nx + ry * ny + rz * nz;
            // Plus a small share of the flow along the cloth, so a sheet edge-on to the
            // wind is not perfectly transparent to it and stalls there for ever.
            const ax = drag * (along * nx + rx * 0.12);
            const ay = drag * (along * ny + ry * 0.12) + GRAVITY;
            const az = drag * (along * nz + rz * 0.12);

            this._prev[p] = this._pos[p];
            this._prev[p + 1] = this._pos[p + 1];
            this._prev[p + 2] = this._pos[p + 2];
            this._pos[p] += vx + ax * dt2;
            this._pos[p + 1] += vy + ay * dt2;
            this._pos[p + 2] += vz + az * dt2;
        }

        // The top row is the body's, not the solver's — placed where the seam has got to
        // by this point in the frame rather than where it will be at the end of it.
        for (let c = 0; c < COLS; c++) {
            const p = c * 3;
            this._prev[p] = this._pos[p];
            this._prev[p + 1] = this._pos[p + 1];
            this._prev[p + 2] = this._pos[p + 2];
            this._pos[p] = this._anchorFrom[p] + (this._anchor[p] - this._anchorFrom[p]) * blend;
            this._pos[p + 1] = this._anchorFrom[p + 1] + (this._anchor[p + 1] - this._anchorFrom[p + 1]) * blend;
            this._pos[p + 2] = this._anchorFrom[p + 2] + (this._anchor[p + 2] - this._anchorFrom[p + 2]) * blend;
        }

        const iterations = Math.max(1, Math.round(s["cloth.iterations"]));
        for (let k = 0; k < iterations; k++) this._relax();
        this._collide();
    }

    /**
     * One Gauss-Seidel pass over the distance constraints.
     *
     * Structural along both axes, shear on the diagonals, and a slack bend constraint two
     * apart. The bend one is why the cloth does not fold flat back on itself the moment
     * the wind drops, and it is deliberately loose — a cloak that resists bending like a
     * board reads as sheet metal.
     */
    private _relax(): void {
        const diag = Math.hypot(this._restCol, this._restRow);
        for (let r = 0; r < ROWS; r++) {
            for (let c = 0; c < COLS; c++) {
                const i = r * COLS + c;
                if (c + 1 < COLS) this._constrain(i, i + 1, this._restCol, 1);
                if (r + 1 < ROWS) this._constrain(i, i + COLS, this._restRow, 1);
                if (c + 1 < COLS && r + 1 < ROWS) {
                    this._constrain(i, i + COLS + 1, diag, 0.4);
                    this._constrain(i + 1, i + COLS, diag, 0.4);
                }
                // Bend, and DELIBERATELY SLACK. This is the only thing stopping the sheet
                // folding flat back on itself, and it is the only thing that will stop it
                // folding at all if it is set too high — at 0.25 with fourteen iterations
                // the cape came out as a rigid dark rectangle, which is a solver doing
                // exactly what it was told and cloth doing nothing anyone would recognise.
                if (r + 2 < ROWS) this._constrain(i, i + 2 * COLS, this._restRow * 2, 0.08);
                if (c + 2 < COLS) this._constrain(i, i + 2, this._restCol * 2, 0.08);
            }
        }
    }

    private _constrain(a: number, b: number, rest: number, stiffness: number): void {
        const pa = a * 3;
        const pb = b * 3;
        const dx = this._pos[pb] - this._pos[pa];
        const dy = this._pos[pb + 1] - this._pos[pa + 1];
        const dz = this._pos[pb + 2] - this._pos[pa + 2];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d < 1e-6) return;
        const correction = ((d - rest) / d) * stiffness;
        // The top row is pinned, so it takes none of the correction and its partner takes
        // all of it. Anything else drags the seam off the shoulders.
        const aFree = a >= COLS;
        const bFree = b >= COLS;
        if (!aFree && !bFree) return;
        const share = aFree && bFree ? 0.5 : 1;
        if (aFree) {
            this._pos[pa] += dx * correction * share;
            this._pos[pa + 1] += dy * correction * share;
            this._pos[pa + 2] += dz * correction * share;
        }
        if (bFree) {
            this._pos[pb] -= dx * correction * share;
            this._pos[pb + 1] -= dy * correction * share;
            this._pos[pb + 2] -= dz * correction * share;
        }
    }

    /** Push the cloth out of the body, treated as one capsule down the spine. */
    private _collide(): void {
        const ax = this._spine[0];
        const ay = this._spine[1];
        const az = this._spine[2];
        const bx = this._spine[3] - ax;
        const by = this._spine[4] - ay;
        const bz = this._spine[5] - az;
        const len2 = bx * bx + by * by + bz * bz;
        if (len2 < 1e-6) return;

        for (let i = COLS; i < COUNT; i++) {
            const p = i * 3;
            const dx = this._pos[p] - ax;
            const dy = this._pos[p + 1] - ay;
            const dz = this._pos[p + 2] - az;
            let t = (dx * bx + dy * by + dz * bz) / len2;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const cx = dx - bx * t;
            const cy = dy - by * t;
            const cz = dz - bz * t;
            const d = Math.sqrt(cx * cx + cy * cy + cz * cz);
            if (d >= BODY_RADIUS || d < 1e-6) continue;
            const push = (BODY_RADIUS - d) / d;
            this._pos[p] += cx * push;
            this._pos[p + 1] += cy * push;
            this._pos[p + 2] += cz * push;
        }
    }

    /** Grid normals from the two in-plane differences, one per particle. */
    private _computeNormals(): void {
        for (let r = 0; r < ROWS; r++) {
            for (let c = 0; c < COLS; c++) {
                const i = (r * COLS + c) * 3;
                const cPrev = (r * COLS + Math.max(c - 1, 0)) * 3;
                const cNext = (r * COLS + Math.min(c + 1, COLS - 1)) * 3;
                const rPrev = (Math.max(r - 1, 0) * COLS + c) * 3;
                const rNext = (Math.min(r + 1, ROWS - 1) * COLS + c) * 3;
                const ux = this._pos[cNext] - this._pos[cPrev];
                const uy = this._pos[cNext + 1] - this._pos[cPrev + 1];
                const uz = this._pos[cNext + 2] - this._pos[cPrev + 2];
                const vx = this._pos[rNext] - this._pos[rPrev];
                const vy = this._pos[rNext + 1] - this._pos[rPrev + 1];
                const vz = this._pos[rNext + 2] - this._pos[rPrev + 2];
                let nx = uy * vz - uz * vy;
                let ny = uz * vx - ux * vz;
                let nz = ux * vy - uy * vx;
                const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
                if (l < 1e-6) {
                    nx = 0;
                    ny = 0;
                    nz = 1;
                } else {
                    nx /= l;
                    ny /= l;
                    nz /= l;
                }
                this._normal[i] = nx;
                this._normal[i + 1] = ny;
                this._normal[i + 2] = nz;
            }
        }
    }

    private _push(): void {
        const s = this._settings.v;
        const m = this.material;
        m.setColor3("fgCloth", this._cloth);
        m.setColor3("fgSkin", this._cloth);
        m.setColor3("fgTint", this._tint);
        // Cloth roughness on both slots: every vertex here reports the clothed material,
        // so the second one is never selected.
        this._params.set(s["render.exposure"], s["char.clothRoughness"], s["char.clothRoughness"], s["cloth.subsurface"]);
        m.setVector4("fgParams", this._params);
        m.setVector3("fgCameraPos", this._camera);
        this._sky.pushTo(m);
        this._shadows.pushTo(m);
    }
}
