import { B, BONE_COUNT, type Skeleton } from "./skeleton";

/**
 * The figure's surface, lofted over the rig.
 *
 * Rings of vertices swept along chains of bones, with an elliptical cross-section whose
 * radii come from a small table per chain. That is the whole idea. A body is not a set of
 * cylinders — it is wider than it is deep almost everywhere, and the ratio changes down
 * its length — so the cross-section carries two radii rather than one, which is most of
 * the difference between a figure and a bundle of sausages.
 *
 * WHAT MAKES A JOINT BEND SMOOTHLY IS THE RINGS EITHER SIDE OF IT SHARING BOTH BONES.
 * Pass A weighted every vertex rigidly to one bone, which is exactly right for boxes and
 * would put a hard crease at every knee here. Rings within a blend window of a joint take
 * a weight in both, so the surface across a bend is the average of two transforms. That
 * average loses a little volume on a hard bend, which is the standard cost of linear blend
 * skinning; the window is set from the local radius so the loss is spread over a length
 * comparable to the limb's own thickness rather than concentrated in one ring.
 *
 * Authored in the REST pose, in character space, because that is the space the palette
 * maps from. Nothing here runs after construction.
 */

/** Vertices around each ring. Twelve reads as round at the distance a third-person camera sits. */
const SEGMENTS = 12;

/** Ring spacing along a chain, metres. */
const SPACING = 0.042;

/** Blend window around a joint, as a multiple of the local radius. */
const BLEND = 1.15;

interface Stop {
    /** Fraction along the chain's total length. */
    t: number;
    /** Half-width across the body, and half-depth front to back. */
    rx: number;
    rz: number;
}

interface Chain {
    bones: number[];
    profile: Stop[];
}

/**
 * Torso, neck and head as one sweep.
 *
 * One chain rather than three because the silhouette from hips to crown is continuous and
 * the places it pinches — the waist, the neck — are exactly the places two separate tubes
 * would have left a seam. The shoulders are the widest stop and sit where the arms leave.
 */
const BODY: Chain = {
    bones: [B.pelvis, B.spine, B.chest, B.neck, B.head],
    profile: [
        { t: 0.0, rx: 0.128, rz: 0.1 }, // hips — narrower than the widest point, because
        { t: 0.06, rx: 0.145, rz: 0.107 }, // the seat is just below the joint, not at it
        { t: 0.22, rx: 0.125, rz: 0.095 }, // waist
        { t: 0.4, rx: 0.166, rz: 0.113 },
        { t: 0.53, rx: 0.198, rz: 0.12 }, // shoulders, wider than the joint beneath them
        { t: 0.6, rx: 0.125, rz: 0.1 },
        { t: 0.66, rx: 0.058, rz: 0.058 }, // neck
        { t: 0.72, rx: 0.082, rz: 0.09 },
        { t: 0.8, rx: 0.099, rz: 0.111 }, // head, at the cheekbones
        { t: 0.9, rx: 0.098, rz: 0.108 },
        { t: 1.0, rx: 0.09, rz: 0.098 }, // the dome closes the crown from here
    ],
};

const ARM: Stop[] = [
    { t: 0.0, rx: 0.062, rz: 0.062 }, // shoulder, buried in the torso
    { t: 0.08, rx: 0.058, rz: 0.058 },
    { t: 0.4, rx: 0.05, rz: 0.05 },
    { t: 0.45, rx: 0.052, rz: 0.052 }, // elbow
    { t: 0.7, rx: 0.041, rz: 0.041 },
    { t: 0.85, rx: 0.032, rz: 0.032 }, // wrist
    { t: 0.92, rx: 0.043, rz: 0.037 }, // hand
    { t: 1.0, rx: 0.022, rz: 0.02 },
];

const LEG: Stop[] = [
    { t: 0.0, rx: 0.1, rz: 0.1 }, // hip, buried in the torso
    { t: 0.12, rx: 0.093, rz: 0.095 },
    { t: 0.4, rx: 0.07, rz: 0.072 },
    { t: 0.51, rx: 0.064, rz: 0.066 }, // knee
    { t: 0.62, rx: 0.06, rz: 0.064 }, // calf
    { t: 0.86, rx: 0.041, rz: 0.043 },
    { t: 1.0, rx: 0.038, rz: 0.04 }, // ankle
];

const FOOT: Stop[] = [
    { t: 0.0, rx: 0.046, rz: 0.042 },
    { t: 0.45, rx: 0.048, rz: 0.034 },
    { t: 1.0, rx: 0.042, rz: 0.024 }, // toe
];

/** Bare skin rather than cloth: the head, the forearms below a rolled sleeve, the hands. */
const BARE = new Set<number>([B.head, B.foreArmR, B.handR, B.foreArmL, B.handL]);

export interface LoftMesh {
    positions: Float32Array;
    normals: Float32Array;
    skins: Float32Array;
    indices: Uint32Array;
    vertexCount: number;
    triangleCount: number;
}

export function buildLoft(sk: Skeleton): LoftMesh {
    const positions: number[] = [];
    const normals: number[] = [];
    const skins: number[] = [];
    const indices: number[] = [];

    const chains: Chain[] = [
        BODY,
        { bones: [B.upperArmR, B.foreArmR, B.handR], profile: ARM },
        { bones: [B.upperArmL, B.foreArmL, B.handL], profile: ARM },
        { bones: [B.thighR, B.shinR], profile: LEG },
        { bones: [B.thighL, B.shinL], profile: LEG },
        { bones: [B.footR], profile: FOOT },
        { bones: [B.footL], profile: FOOT },
    ];

    for (const chain of chains) sweep(sk, chain, positions, normals, skins, indices);

    return {
        positions: new Float32Array(positions),
        normals: new Float32Array(normals),
        skins: new Float32Array(skins),
        indices: new Uint32Array(indices),
        vertexCount: positions.length / 3,
        triangleCount: indices.length / 3,
    };
}

/** Sweep one chain, closing both ends with a pole. */
function sweep(sk: Skeleton, chain: Chain, positions: number[], normals: number[], skins: number[], indices: number[]): void {
    const bones = chain.bones;

    // Arc position of each joint, and the total.
    const starts: number[] = [];
    let total = 0;
    for (const b of bones) {
        starts.push(total);
        total += sk.length[b];
    }

    // THE SWEEP STOPS SHORT AND THE DOME FINISHES THE JOB. Running rings all the way to
    // the end of the chain and then adding a dome on top would put the crown of the head
    // eight centimetres above the height the rig says the figure is, and the toe past the
    // end of the foot. The surface has to end where the bone does.
    const rEnd = radiusAt(chain.profile, 1);
    const span = Math.max(total - Math.max(rEnd.rx, rEnd.rz) * DOME_END, total * 0.4);

    // Ring positions: evenly spaced, with a ring landing exactly on every joint so the
    // blend window is centred on something rather than straddling a gap.
    const stops = new Set<number>([0, span]);
    for (let i = 1; i < bones.length; i++) if (starts[i] < span) stops.add(starts[i]);
    const count = Math.max(2, Math.round(span / SPACING));
    for (let i = 1; i < count; i++) stops.add((i / count) * span);
    const arcs = [...stops].sort((a, b) => a - b);

    const ringBase: number[] = [];

    for (const s of arcs) {
        // Which bone this ring sits inside, and how far along it.
        let bi = bones.length - 1;
        while (bi > 0 && s < starts[bi]) bi--;
        const bone = bones[bi];
        const local = Math.min(s - starts[bi], sk.length[bone]);

        const i3 = bone * 3;
        const wx = sk.restDir[i3];
        const wy = sk.restDir[i3 + 1];
        const wz = sk.restDir[i3 + 2];
        const cx = sk.restHead[i3] + wx * local;
        const cy = sk.restHead[i3 + 1] + wy * local;
        const cz = sk.restHead[i3 + 2] + wz * local;

        const { ux, uy, uz, vx, vy, vz } = crossSection(wx, wy, wz);

        const t = total > 0 ? s / total : 0;
        const r = radiusAt(chain.profile, t);
        // Slope of the taper, for the normal. Taken from the profile rather than from
        // neighbouring rings so a ring next to a joint is not handed the wrong one.
        const h = 0.004;
        const rp = radiusAt(chain.profile, Math.min(t + h, 1));
        const rm = radiusAt(chain.profile, Math.max(t - h, 0));
        const span = Math.max((Math.min(t + h, 1) - Math.max(t - h, 0)) * total, 1e-5);
        const drx = (rp.rx - rm.rx) / span;
        const drz = (rp.rz - rm.rz) / span;

        // Skin weights. A ring near a joint takes both bones; everywhere else it is rigid.
        let boneA = bone;
        let boneB = bone;
        let weight = 0;
        const window = Math.max(r.rx, r.rz) * BLEND;
        for (let j = 1; j < bones.length; j++) {
            const d = s - starts[j];
            if (Math.abs(d) >= window) continue;
            // Below the joint the ring belongs to the parent and leans on the child, and
            // above it the other way round. Half a weight exactly on the joint itself.
            boneA = d < 0 ? bones[j - 1] : bones[j];
            boneB = d < 0 ? bones[j] : bones[j - 1];
            // EXACTLY HALF ON THE JOINT, falling to nothing at the window's edge. It has
            // to be half: the two bones swap roles as the ring crosses the joint, so any
            // other value means the ring just below the joint and the ring just above it
            // resolve to different blends, and the surface creases along the seam that
            // this window exists to remove.
            weight = smooth(0.5 - Math.abs(d) / (2 * window));
            break;
        }
        const material = BARE.has(boneA) ? 1 : 0;

        ringBase.push(positions.length / 3);
        for (let k = 0; k < SEGMENTS; k++) {
            const a = (k / SEGMENTS) * Math.PI * 2;
            const ca = Math.cos(a);
            const sa = Math.sin(a);
            positions.push(cx + ux * r.rx * ca + vx * r.rz * sa, cy + uy * r.rx * ca + vy * r.rz * sa, cz + uz * r.rx * ca + vz * r.rz * sa);

            // dP/dtheta x dP/ds, which for an untapered tube is the radial direction and
            // with taper leans along the bone by exactly the slope of the profile.
            const tThX = -r.rx * sa;
            const tThZ = r.rz * ca;
            const tSX = drx * ca;
            const tSZ = drz * sa;
            // In the (U, V, W) frame: dP/dtheta = (tThX, tThZ, 0), dP/ds = (tSX, tSZ, 1).
            const nU = tThZ * 1 - 0 * tSZ;
            const nV = 0 * tSX - tThX * 1;
            const nW = tThX * tSZ - tThZ * tSX;
            const nx = ux * nU + vx * nV + wx * nW;
            const ny = uy * nU + vy * nV + wy * nW;
            const nz = uz * nU + vz * nV + wz * nW;
            const nl = Math.hypot(nx, ny, nz) || 1;
            normals.push(nx / nl, ny / nl, nz / nl);

            skins.push(boneA, boneB, weight, material);
        }
    }

    // Quads between consecutive rings. The order is what makes the face point outward:
    // (theta, theta+1, next ring) has its right-hand normal along dP/dtheta x dP/ds.
    for (let i = 0; i + 1 < arcs.length; i++) {
        const a = ringBase[i];
        const b = ringBase[i + 1];
        for (let k = 0; k < SEGMENTS; k++) {
            const k1 = (k + 1) % SEGMENTS;
            indices.push(a + k, a + k1, b + k1);
            indices.push(a + k, b + k1, b + k);
        }
    }

    cap(sk, chain, arcs, starts, ringBase, positions, normals, skins, indices, true);
    cap(sk, chain, arcs, starts, ringBase, positions, normals, skins, indices, false);
}

/**
 * Close one end of a sweep with a dome.
 *
 * NOT A SINGLE POLE. Fanning the last ring straight to one vertex is three lines shorter
 * and draws a cone, which put a spike on the crown of the head, a point between the legs
 * and a pair of angular tabs where the arms leave the shoulders. A dome is the same fan
 * with two intermediate rings on a quarter ellipse, and it is the difference between a
 * head and a party hat.
 *
 * The start dome is shallow because it is nearly always buried inside another chain — an
 * arm begins inside the shoulder and a leg inside the hip — and a deep one there only
 * pushes geometry out through the torso it should be hidden in.
 */
const DOME_RINGS = 2;
const DOME_END = 0.95;
const DOME_START = 0.4;

function cap(
    sk: Skeleton,
    chain: Chain,
    arcs: number[],
    starts: number[],
    ringBase: number[],
    positions: number[],
    normals: number[],
    skins: number[],
    indices: number[],
    atStart: boolean,
): void {
    const bones = chain.bones;
    const ring = atStart ? 0 : arcs.length - 1;
    const s = arcs[ring];
    const total = chainLength(sk, chain);

    let bi = bones.length - 1;
    while (bi > 0 && s < starts[bi]) bi--;
    const bone = bones[bi];
    const i3 = bone * 3;
    const local = Math.min(s - starts[bi], sk.length[bone]);
    const wx = sk.restDir[i3];
    const wy = sk.restDir[i3 + 1];
    const wz = sk.restDir[i3 + 2];
    const cx = sk.restHead[i3] + wx * local;
    const cy = sk.restHead[i3 + 1] + wy * local;
    const cz = sk.restHead[i3 + 2] + wz * local;
    const r = radiusAt(chain.profile, total > 0 ? s / total : 0);

    const basis = crossSection(wx, wy, wz);
    const sign = atStart ? -1 : 1;
    const reach = Math.max(r.rx, r.rz) * (atStart ? DOME_START : DOME_END);

    // Skin the dome exactly as the ring it grows from, so a hand or a crown cannot be
    // weighted to anything the surface beside it is not.
    const base = ringBase[ring] * 4;
    const sa = skins[base];
    const sb = skins[base + 1];
    const sw = skins[base + 2];
    const sm = skins[base + 3];

    const rows = [ringBase[ring]];
    for (let i = 1; i <= DOME_RINGS; i++) {
        const phi = (i / (DOME_RINGS + 1)) * (Math.PI / 2);
        const shrink = Math.cos(phi);
        const push = Math.sin(phi) * reach * sign;
        rows.push(positions.length / 3);
        for (let k = 0; k < SEGMENTS; k++) {
            const a = (k / SEGMENTS) * Math.PI * 2;
            const ca = Math.cos(a);
            const sn = Math.sin(a);
            const ex = basis.ux * r.rx * ca * shrink + basis.vx * r.rz * sn * shrink;
            const ey = basis.uy * r.rx * ca * shrink + basis.vy * r.rz * sn * shrink;
            const ez = basis.uz * r.rx * ca * shrink + basis.vz * r.rz * sn * shrink;
            positions.push(cx + ex + wx * push, cy + ey + wy * push, cz + ez + wz * push);
            // On an ellipsoid the normal leans along the axis by exactly sin(phi).
            const rl = Math.hypot(ex, ey, ez) || 1;
            const nx = (ex / rl) * shrink + wx * sign * Math.sin(phi);
            const ny = (ey / rl) * shrink + wy * sign * Math.sin(phi);
            const nz = (ez / rl) * shrink + wz * sign * Math.sin(phi);
            const nl = Math.hypot(nx, ny, nz) || 1;
            normals.push(nx / nl, ny / nl, nz / nl);
            skins.push(sa, sb, sw, sm);
        }
    }

    const pole = positions.length / 3;
    positions.push(cx + wx * reach * sign, cy + wy * reach * sign, cz + wz * reach * sign);
    normals.push(wx * sign, wy * sign, wz * sign);
    skins.push(sa, sb, sw, sm);

    for (let i = 0; i + 1 < rows.length; i++) {
        const a = rows[i];
        const b = rows[i + 1];
        for (let k = 0; k < SEGMENTS; k++) {
            const k1 = (k + 1) % SEGMENTS;
            if (atStart) {
                indices.push(a + k, b + k1, a + k1);
                indices.push(a + k, b + k, b + k1);
            } else {
                indices.push(a + k, a + k1, b + k1);
                indices.push(a + k, b + k1, b + k);
            }
        }
    }

    const last = rows[rows.length - 1];
    for (let k = 0; k < SEGMENTS; k++) {
        const k1 = (k + 1) % SEGMENTS;
        // Reversed at the start, because the fan faces the other way there.
        if (atStart) indices.push(pole, a2(last, k1), a2(last, k));
        else indices.push(pole, a2(last, k), a2(last, k1));
    }

    function a2(row: number, k: number): number {
        return row + k;
    }
}

function chainLength(sk: Skeleton, chain: Chain): number {
    let total = 0;
    for (const b of chain.bones) total += sk.length[b];
    return total;
}

/**
 * The cross-section frame for a bone: the character's own +X made perpendicular to it, so
 * "wide" means wide across the body on every limb without a table of per-bone axes, and a
 * third axis completing a right-handed set — which is what makes the winding come out
 * facing outward.
 */
function crossSection(wx: number, wy: number, wz: number): { ux: number; uy: number; uz: number; vx: number; vy: number; vz: number } {
    let ux = 1 - wx * wx;
    let uy = -wy * wx;
    let uz = -wz * wx;
    let ul = Math.hypot(ux, uy, uz);
    if (ul < 1e-4) {
        ux = 0;
        uy = 0;
        uz = 1;
        ul = 1;
    }
    ux /= ul;
    uy /= ul;
    uz /= ul;
    return { ux, uy, uz, vx: wy * uz - wz * uy, vy: wz * ux - wx * uz, vz: wx * uy - wy * ux };
}

function radiusAt(profile: Stop[], t: number): { rx: number; rz: number } {
    if (t <= profile[0].t) return { rx: profile[0].rx, rz: profile[0].rz };
    for (let i = 1; i < profile.length; i++) {
        if (t > profile[i].t) continue;
        const a = profile[i - 1];
        const b = profile[i];
        const f = (t - a.t) / Math.max(b.t - a.t, 1e-6);
        const e = f * f * (3 - 2 * f);
        return { rx: a.rx + (b.rx - a.rx) * e, rz: a.rz + (b.rz - a.rz) * e };
    }
    const last = profile[profile.length - 1];
    return { rx: last.rx, rz: last.rz };
}

function smooth(k: number): number {
    const c = k < 0 ? 0 : k > 1 ? 1 : k;
    return c * c * (3 - 2 * c);
}

/** Sanity: every skin index must name a real bone. Cheap, and runs once. */
export function validateLoft(mesh: LoftMesh): string | null {
    for (let i = 0; i < mesh.skins.length; i += 4) {
        const a = mesh.skins[i];
        const b = mesh.skins[i + 1];
        if (!Number.isInteger(a) || a < 0 || a >= BONE_COUNT) return `bone index ${a} out of range`;
        if (!Number.isInteger(b) || b < 0 || b >= BONE_COUNT) return `bone index ${b} out of range`;
        const w = mesh.skins[i + 2];
        if (!(w >= 0 && w <= 0.5001)) return `weight ${w} outside 0..0.5`;
    }
    return null;
}
