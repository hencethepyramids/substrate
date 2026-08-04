/**
 * The rig: eighteen bones, written down rather than imported, because this project
 * ships no assets.
 *
 * EVERYTHING IS SOLVED IN CHARACTER SPACE — origin at the feet, +Y up, +Z the facing
 * direction, +X the character's right — and the whole figure is carried into the world
 * by one root transform at the very end. That choice is what makes the rest of this
 * file short: at rest every bone's orientation is the identity, so a bone's inverse
 * bind matrix is nothing more than a translation by minus its own joint, and skinning
 * collapses to
 *
 *     world(p) = root( head[b] + R[b] * (p - restHead[b]) )
 *
 * with R the rotation that carries the bone's rest direction onto its current one. No
 * quaternion chain, no matrix inverses, no bind pose to keep in step with anything.
 *
 * R is the shortest arc between the two directions. For limbs that are round in
 * cross-section the twist it leaves undetermined is not observable, and choosing the
 * shortest arc keeps it continuous everywhere except a full reversal, which no joint
 * in a gait ever reaches.
 *
 * Nothing here allocates after construction.
 */

/** Bones. The order is the palette order, so these are also uniform indices. */
export const B = {
    pelvis: 0,
    spine: 1,
    chest: 2,
    neck: 3,
    head: 4,
    thighR: 5,
    shinR: 6,
    footR: 7,
    thighL: 8,
    shinL: 9,
    footL: 10,
    upperArmR: 11,
    foreArmR: 12,
    handR: 13,
    upperArmL: 14,
    foreArmL: 15,
    handL: 16,
    /** Anchor for the Phase 7 pass E cloth. Hangs at rest and is not driven yet. */
    cloak: 17,
} as const;

export const BONE_COUNT = 18;

/**
 * Joint heights and offsets in metres, for a figure 1.8 m tall — the same height the
 * placeholder capsule was, so the camera rig and the spring arm do not need retuning.
 *
 * These are proportions, not measurements: the leg is 53% of standing height and the
 * shoulders sit at 79%, which is close enough to a real body that the gait derived
 * from them lands in a believable range without anyone tuning it by eye.
 */
export const P = {
    height: 1.8,
    /** Ankle height, which is also how far the sole sits below the shin. */
    ankle: 0.09,
    knee: 0.51,
    hip: 0.95,
    spineY: 1.08,
    chestY: 1.26,
    neckY: 1.48,
    headY: 1.56,
    headTop: 1.8,
    hipHalf: 0.09,
    shoulderY: 1.42,
    shoulderHalf: 0.185,
    elbowY: 1.12,
    wristY: 0.85,
    handY: 0.75,
    /** Arms hang slightly clear of the ribs, so a swing does not pass through them. */
    elbowHalf: 0.205,
    wristHalf: 0.225,
    toeY: 0.03,
    toeZ: 0.17,
} as const;

export const THIGH = P.hip - P.knee;
export const SHIN = P.knee - P.ankle;
/** Hip to ankle, fully extended. The gait never asks for more than this. */
export const LEG = THIGH + SHIN;
export const UPPER_ARM = P.shoulderY - P.elbowY;
export const FORE_ARM = P.elbowY - P.wristY;

interface BoneDef {
    /** Joint position at rest, character space. */
    head: [number, number, number];
    /** The far end at rest. Direction and length both come from this. */
    tail: [number, number, number];
    /** Half-thickness, for whatever geometry is lofted onto the bone. */
    girth: number;
}

/**
 * Rest layout. Arms hang at the sides rather than out in a T — an A-pose costs nothing
 * here and keeps every limb bone pointing roughly down, which means the shortest-arc
 * rotation for a swing is a small one.
 */
const REST: BoneDef[] = [
    /* pelvis    */ { head: [0, P.hip, 0], tail: [0, P.spineY, 0], girth: 0.125 },
    /* spine     */ { head: [0, P.spineY, 0], tail: [0, P.chestY, 0], girth: 0.13 },
    /* chest     */ { head: [0, P.chestY, 0], tail: [0, P.neckY, 0], girth: 0.145 },
    /* neck      */ { head: [0, P.neckY, 0], tail: [0, P.headY, 0], girth: 0.055 },
    /* head      */ { head: [0, P.headY, 0], tail: [0, P.headTop, 0], girth: 0.1 },

    /* thighR    */ { head: [P.hipHalf, P.hip, 0], tail: [P.hipHalf, P.knee, 0], girth: 0.085 },
    /* shinR     */ { head: [P.hipHalf, P.knee, 0], tail: [P.hipHalf, P.ankle, 0], girth: 0.062 },
    /* footR     */ { head: [P.hipHalf, P.ankle, 0], tail: [P.hipHalf, P.toeY, P.toeZ], girth: 0.048 },

    /* thighL    */ { head: [-P.hipHalf, P.hip, 0], tail: [-P.hipHalf, P.knee, 0], girth: 0.085 },
    /* shinL     */ { head: [-P.hipHalf, P.knee, 0], tail: [-P.hipHalf, P.ankle, 0], girth: 0.062 },
    /* footL     */ { head: [-P.hipHalf, P.ankle, 0], tail: [-P.hipHalf, P.toeY, P.toeZ], girth: 0.048 },

    /* upperArmR */ { head: [P.shoulderHalf, P.shoulderY, 0], tail: [P.elbowHalf, P.elbowY, 0], girth: 0.055 },
    /* foreArmR  */ { head: [P.elbowHalf, P.elbowY, 0], tail: [P.wristHalf, P.wristY, 0], girth: 0.045 },
    /* handR     */ { head: [P.wristHalf, P.wristY, 0], tail: [P.wristHalf, P.handY, 0], girth: 0.04 },

    /* upperArmL */ { head: [-P.shoulderHalf, P.shoulderY, 0], tail: [-P.elbowHalf, P.elbowY, 0], girth: 0.055 },
    /* foreArmL  */ { head: [-P.elbowHalf, P.elbowY, 0], tail: [-P.wristHalf, P.wristY, 0], girth: 0.045 },
    /* handL     */ { head: [-P.wristHalf, P.wristY, 0], tail: [-P.wristHalf, P.handY, 0], girth: 0.04 },

    /* cloak     */ { head: [0, P.chestY + 0.1, -0.075], tail: [0, P.hip - 0.08, -0.14], girth: 0.17 },
];

/** Rows of the 3x4 palette, three vec4s a bone. */
const PALETTE_FLOATS = BONE_COUNT * 3 * 4;

export class Skeleton {
    /** Joint position at rest, character space, flat xyz. Also the geometry's frame. */
    readonly restHead = new Float32Array(BONE_COUNT * 3);
    /** Unit vector head-to-tail at rest. */
    readonly restDir = new Float32Array(BONE_COUNT * 3);
    readonly length = new Float32Array(BONE_COUNT);
    readonly girth = new Float32Array(BONE_COUNT);

    /** Posed joint position, character space. Written by the gait, read by `solve`. */
    readonly head = new Float32Array(BONE_COUNT * 3);
    /** Posed direction, character space. Need not be normalised; `solve` does that. */
    readonly dir = new Float32Array(BONE_COUNT * 3);

    /**
     * The uniform palette. A plain array because `ShaderMaterial.setArray4` stores the
     * reference rather than copying, so writing into this in place is what keeps the
     * per-frame upload free of allocation.
     */
    readonly palette: number[] = new Array<number>(PALETTE_FLOATS).fill(0);

    constructor() {
        for (let b = 0; b < BONE_COUNT; b++) {
            const def = REST[b];
            const dx = def.tail[0] - def.head[0];
            const dy = def.tail[1] - def.head[1];
            const dz = def.tail[2] - def.head[2];
            const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
            this.length[b] = len;
            this.girth[b] = def.girth;
            const i = b * 3;
            this.restHead[i] = def.head[0];
            this.restHead[i + 1] = def.head[1];
            this.restHead[i + 2] = def.head[2];
            this.restDir[i] = dx / len;
            this.restDir[i + 1] = dy / len;
            this.restDir[i + 2] = dz / len;
        }
        this.rest();
    }

    /** Put the pose back to the rest layout. Also the state the geometry is authored in. */
    rest(): void {
        this.head.set(this.restHead);
        this.dir.set(this.restDir);
    }

    /** Posed joint of a bone, into three consecutive slots. */
    setHead(bone: number, x: number, y: number, z: number): void {
        const i = bone * 3;
        this.head[i] = x;
        this.head[i + 1] = y;
        this.head[i + 2] = z;
    }

    setDir(bone: number, x: number, y: number, z: number): void {
        const i = bone * 3;
        this.dir[i] = x;
        this.dir[i + 1] = y;
        this.dir[i + 2] = z;
    }

    /** Where a bone's far end has ended up, given its posed head and direction. */
    tailX(bone: number): number {
        return this.head[bone * 3] + this.dir[bone * 3] * this.length[bone];
    }
    tailY(bone: number): number {
        return this.head[bone * 3 + 1] + this.dir[bone * 3 + 1] * this.length[bone];
    }
    tailZ(bone: number): number {
        return this.head[bone * 3 + 2] + this.dir[bone * 3 + 2] * this.length[bone];
    }

    /**
     * Bake the posed skeleton into the uniform palette.
     *
     * For each bone the skinning transform is
     *
     *     A = Ry(facing) . R          R = shortest arc restDir -> dir
     *     T = Ry(facing) . (head - R . restHead) + position
     *
     * which is exactly `root . translate(head) . R . translate(-restHead)` multiplied
     * out. Doing it by hand rather than through Matrix keeps this allocation-free and
     * makes the one thing worth checking — that a bone left in its rest pose comes back
     * as the identity — obvious rather than buried in a library.
     */
    solve(x: number, y: number, z: number, facing: number): void {
        const sy = Math.sin(facing);
        const cy = Math.cos(facing);
        const pal = this.palette;

        for (let b = 0; b < BONE_COUNT; b++) {
            const i = b * 3;

            // Normalise the posed direction here so callers may write anything non-zero.
            let dx = this.dir[i];
            let dy = this.dir[i + 1];
            let dz = this.dir[i + 2];
            const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (len > 1e-6) {
                dx /= len;
                dy /= len;
                dz /= len;
            } else {
                dx = this.restDir[i];
                dy = this.restDir[i + 1];
                dz = this.restDir[i + 2];
            }

            const ax = this.restDir[i];
            const ay = this.restDir[i + 1];
            const az = this.restDir[i + 2];

            // Shortest arc from rest to posed, as a matrix: R = I + [v] + [v]^2 / (1+c).
            const vx = ay * dz - az * dy;
            const vy = az * dx - ax * dz;
            const vz = ax * dy - ay * dx;
            const c = ax * dx + ay * dy + az * dz;

            let r00: number, r01: number, r02: number;
            let r10: number, r11: number, r12: number;
            let r20: number, r21: number, r22: number;

            if (c < -0.999999) {
                // Exactly reversed: the arc is a half turn about any perpendicular axis
                // and the formula below divides by zero. No gait reaches this, but a
                // NaN that only appears when someone drags a slider to an extreme is
                // the worst kind of bug to find later.
                const px = Math.abs(ax) < 0.9 ? 1 : 0;
                const py = Math.abs(ax) < 0.9 ? 0 : 1;
                const nx = ay * 0 - az * py;
                const ny = az * px - ax * 0;
                const nz = ax * py - ay * px;
                const nl = Math.max(Math.sqrt(nx * nx + ny * ny + nz * nz), 1e-6);
                const ux = nx / nl;
                const uy = ny / nl;
                const uz = nz / nl;
                r00 = 2 * ux * ux - 1;
                r01 = 2 * ux * uy;
                r02 = 2 * ux * uz;
                r10 = 2 * uy * ux;
                r11 = 2 * uy * uy - 1;
                r12 = 2 * uy * uz;
                r20 = 2 * uz * ux;
                r21 = 2 * uz * uy;
                r22 = 2 * uz * uz - 1;
            } else {
                const k = 1 / (1 + c);
                r00 = vx * vx * k + c;
                r01 = vx * vy * k - vz;
                r02 = vx * vz * k + vy;
                r10 = vy * vx * k + vz;
                r11 = vy * vy * k + c;
                r12 = vy * vz * k - vx;
                r20 = vz * vx * k - vy;
                r21 = vz * vy * k + vx;
                r22 = vz * vz * k + c;
            }

            // head - R . restHead, still in character space.
            const hx = this.restHead[i];
            const hy = this.restHead[i + 1];
            const hz = this.restHead[i + 2];
            const ox = this.head[i] - (r00 * hx + r01 * hy + r02 * hz);
            const oy = this.head[i + 1] - (r10 * hx + r11 * hy + r12 * hz);
            const oz = this.head[i + 2] - (r20 * hx + r21 * hy + r22 * hz);

            // Ry(facing) maps +Z to (sin, 0, cos) and +X to (cos, 0, -sin), which is the
            // same forward and right the mover and the carve pass already use.
            const p = b * 12;
            pal[p] = cy * r00 + sy * r20;
            pal[p + 1] = cy * r01 + sy * r21;
            pal[p + 2] = cy * r02 + sy * r22;
            pal[p + 3] = cy * ox + sy * oz + x;

            pal[p + 4] = r10;
            pal[p + 5] = r11;
            pal[p + 6] = r12;
            pal[p + 7] = oy + y;

            pal[p + 8] = -sy * r00 + cy * r20;
            pal[p + 9] = -sy * r01 + cy * r21;
            pal[p + 10] = -sy * r02 + cy * r22;
            pal[p + 11] = -sy * ox + cy * oz + z;
        }
    }
}
