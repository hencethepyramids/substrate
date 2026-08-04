import type { Settings } from "../core/settings";
import type { Mover } from "../core/mover";
import type { Heightfield } from "../terrain/heightfield";
import { Skeleton, B, P, THIGH, SHIN, LEG, UPPER_ARM } from "./skeleton";

/**
 * The gait: a solved walk cycle, not an animation.
 *
 * THE CYCLE IS PHASED ON GROUND TRAVELLED, NOT ON TIME. That is the whole design, and
 * it is the contract Phase 3 wrote down before the legs existed: stride length is a
 * distance you can measure by walking past your own prints, it holds at any speed and
 * through any frame rate, and — the point of all of it — A PLANTED FOOT DOES NOT MOVE.
 * Stance here is not "the foot animating slowly backwards"; it is the foot at a fixed
 * world position while the body travels past it. Feet cannot slide, because nothing in
 * the solve gives them anywhere to slide to.
 *
 * The footfall is emitted from here rather than guessed at by the carve pass. There was
 * previously a second copy of this phase calculation in `carve.ts`, and two copies of
 * "which foot, and where" is exactly how prints end up drifting away from the feet that
 * made them. The gait knows; the carve pass reads.
 *
 * Everything is solved in character space (origin under the feet, +Y up, +Z the facing
 * direction) and carried into the world by the skeleton's root transform. Foot plants
 * are the one exception: those live in WORLD space, because a plant that moved with the
 * body would be no plant at all.
 *
 * Nothing here allocates after construction.
 */

/** A footfall, in world space. Drained by the carve pass, which turns it into a stamp. */
export interface Plant {
    x: number;
    z: number;
    /** How hard it landed, relative to a walking step. */
    load: number;
}

/** Plants emitted in one frame. Two feet cannot land more than twice between frames. */
const MAX_PLANTS = 4;

/** Fraction of a foot's cycle spent on the ground, walking and running. */
const DUTY_WALK = 0.62;
const DUTY_RUN = 0.4;

/** How fast the figure settles into a standing pose once it stops, per second. */
const SETTLE_RATE = 9;

/** Below this the walk cycle has nothing to phase on, and the figure simply stands. */
const MOVING_SPEED = 0.25;

/** Gravity, for the bank angle. Leaning into a turn is a balance, not a style. */
const G = 9.81;

const DEG = Math.PI / 180;

export class Gait {
    readonly skeleton = new Skeleton();

    /** This frame's footfalls. Valid for indices below `plantCount`. */
    readonly plants: Plant[] = [];
    plantCount = 0;

    private readonly _settings: Settings;
    private readonly _field: Heightfield;

    /** Cycle index per foot: 0 is the right, 1 the left. */
    private readonly _cycle = new Int32Array(2);
    /** Where each foot last landed, world space, at ankle height. */
    private readonly _plant = new Float32Array(6);
    /** Where each ankle is now, world space. */
    private readonly _ankle = new Float32Array(6);
    /** Phase within each foot's own cycle, 0 at contact. */
    private readonly _phase = new Float32Array(2);

    /** 0 walking, 1 standing. Damped, so stopping settles rather than snaps. */
    private _stand = 1;
    private _duty = DUTY_WALK;
    private _facingPrev = 0;
    /** Smoothed turn rate, rad/s. */
    private _turn = 0;
    private _seeded = false;

    // The body this frame, so the leg solve can bring a world-space ankle back into
    // character space without the mover being threaded through every call.
    private _px = 0;
    private _py = 0;
    private _pz = 0;
    private _cos = 1;
    private _sin = 0;

    constructor(settings: Settings, field: Heightfield) {
        this._settings = settings;
        this._field = field;
        for (let i = 0; i < MAX_PLANTS; i++) this.plants.push({ x: 0, z: 0, load: 1 });
    }

    /** Phase within a foot's own cycle, 0 at contact. 0 is the right foot, 1 the left. */
    phaseOf(foot: number): number {
        return this._phase[foot];
    }

    /** Fraction of the cycle spent on the ground at the current speed. */
    get duty(): number {
        return this._duty;
    }

    /** 0 walking, 1 standing. Read by the harness; a settle is not a gait. */
    get standing(): number {
        return this._stand;
    }

    /**
     * Re-phase onto wherever the character now is, laying no print. Called on a
     * teleport: a jump is not a stride, and without this the next contact would fire at
     * a random point in the cycle wherever the character landed.
     */
    resync(mover: Mover): void {
        const stride = Math.max(this._settings.v["char.strideLength"], 0.05);
        const stepPhase = mover.distance / stride;
        const half = this._settings.v["char.stanceWidth"] * 0.5;
        const cos = Math.cos(mover.facing);
        const sin = Math.sin(mover.facing);
        for (let i = 0; i < 2; i++) {
            const side = i === 0 ? 1 : -1;
            this._cycle[i] = Math.floor((stepPhase - i) * 0.5);
            const x = mover.position.x + cos * half * side;
            const z = mover.position.z - sin * half * side;
            this._setPlant(i, x, z);
            this._ankle[i * 3] = x;
            this._ankle[i * 3 + 1] = this._plant[i * 3 + 1];
            this._ankle[i * 3 + 2] = z;
            this._phase[i] = 0;
        }
        this._facingPrev = mover.facing;
        this._turn = 0;
        this._stand = 1;
        this._seeded = true;
    }

    /** @param dt simulation seconds, already scaled and zeroed by the pause. */
    update(mover: Mover, dt: number): void {
        this.plantCount = 0;
        if (!this._seeded) this.resync(mover);

        const s = this._settings.v;
        const stride = Math.max(s["char.strideLength"], 0.05);
        const walk = Math.max(s["char.walkSpeed"], 0.1);
        const speedRatio = mover.speed / walk;

        this._px = mover.position.x;
        this._py = mover.position.y;
        this._pz = mover.position.z;
        this._cos = Math.cos(mover.facing);
        this._sin = Math.sin(mover.facing);

        // A walk rolls through a long stance; a run spends most of the cycle airborne.
        const duty = Math.min(Math.max(DUTY_WALK + (DUTY_RUN - DUTY_WALK) * clamp01(speedRatio - 1), 0.3), 0.75);
        this._duty = duty;

        // Standing is a separate state, cross-faded in. The cycle is phased on distance,
        // so when the character stops, distance stops and the phase FREEZES — without
        // this, halting mid-stride would leave a foot hanging in the air forever.
        const moving = mover.speed >= MOVING_SPEED;
        const decay = dt > 0 ? 1 - Math.exp(-SETTLE_RATE * dt) : 0;
        this._stand += ((moving ? 0 : 1) - this._stand) * decay;

        // Turn rate, for the bank. Wrapped, because facing crosses pi every time the
        // character walks south.
        let turned = mover.facing - this._facingPrev;
        while (turned > Math.PI) turned -= Math.PI * 2;
        while (turned < -Math.PI) turned += Math.PI * 2;
        this._facingPrev = mover.facing;
        const rate = dt > 1e-5 ? turned / dt : 0;
        this._turn += (rate - this._turn) * (dt > 0 ? 1 - Math.exp(-12 * dt) : 0);

        const stepPhase = mover.distance / stride;
        const half = s["char.stanceWidth"] * 0.5;
        const lift = s["char.stepLift"] * Math.min(0.6 + 0.4 * speedRatio, 2);

        // Where the body is heading, for predicting where a swinging foot lands. Facing
        // when almost stopped, because a near-zero velocity has no direction.
        let travelX = this._sin;
        let travelZ = this._cos;
        if (mover.speed > 0.05) {
            travelX = mover.velocity.x / mover.speed;
            travelZ = mover.velocity.z / mover.speed;
        }

        for (let i = 0; i < 2; i++) {
            const side = i === 0 ? 1 : -1;
            // The right foot contacts on even steps and the left on odd — the same
            // alternation, and the same side convention, the carve pass used before it
            // started reading from here.
            const cyc = (stepPhase - i) * 0.5;
            const k = Math.floor(cyc);
            const t = cyc - k;
            this._phase[i] = t;

            const neutralX = this._px + this._cos * half * side;
            const neutralZ = this._pz - this._sin * half * side;

            if (k !== this._cycle[i]) {
                // One plant however many cycles were skipped. A hitch drops prints; it
                // does not pay them back as a burst all landing in one footstep.
                this._cycle[i] = k;
                this._setPlant(i, neutralX, neutralZ);
                if (this.plantCount < MAX_PLANTS && moving) {
                    const p = this.plants[this.plantCount++];
                    p.x = neutralX;
                    p.z = neutralZ;
                    // A run presses harder than a walk, capped: sprinting is 2.4x walking
                    // and a print two and a half times as deep reads as a crater.
                    p.load = 1 + Math.min(speedRatio, 3) * 0.4;
                }
            }

            const px = this._plant[i * 3];
            const py = this._plant[i * 3 + 1];
            const pz = this._plant[i * 3 + 2];

            let ax: number;
            let ay: number;
            let az: number;
            if (t < duty) {
                // Stance. The foot IS the plant — it does not move at all.
                ax = px;
                ay = py;
                az = pz;
            } else {
                const u = (t - duty) / (1 - duty);
                // Where the body will be when this foot next touches down. Recomputed
                // every frame, so a turn mid-swing steers the foot rather than leaving
                // it committed to a landing the character is no longer walking towards.
                const remaining = (1 - t) * 2 * stride;
                const tx = this._px + travelX * remaining + this._cos * half * side;
                const tz = this._pz + travelZ * remaining - this._sin * half * side;
                const ease = u * u * (3 - 2 * u);
                ax = px + (tx - px) * ease;
                az = pz + (tz - pz) * ease;
                const ty = this._field.sampleHeight(tx, tz) + P.ankle;
                ay = py + (ty - py) * ease + Math.sin(Math.PI * u) * lift;
                // Never through a rise the swing happens to cross.
                const here = this._field.sampleHeight(ax, az) + P.ankle;
                if (ay < here) ay = here;
            }

            // Settle to a stand — THE SWINGING FOOT ONLY.
            //
            // Blending both feet towards neutral is the obvious thing to write and it is
            // wrong: a foot in stance is already standing on the ground at a place it
            // legitimately landed, and dragging it towards where the body has since got
            // to is foot sliding, exactly the failure this whole design exists to avoid.
            // It showed up as a few centimetres of creep in the first half second of
            // every walk — invisible in motion, and plainly there in the measurement.
            //
            // So the planted foot holds and the swinging one comes down beside it, which
            // is also what stopping actually looks like: you finish the step you were
            // taking, you do not slide the one you were standing on.
            if (this._stand > 0.001 && t >= duty) {
                const ny = this._field.sampleHeight(neutralX, neutralZ) + P.ankle;
                ax += (neutralX - ax) * this._stand;
                ay += (ny - ay) * this._stand;
                az += (neutralZ - az) * this._stand;
            }

            this._ankle[i * 3] = ax;
            this._ankle[i * 3 + 1] = ay;
            this._ankle[i * 3 + 2] = az;
        }

        this._pose(mover, stepPhase, stride, speedRatio);
    }

    private _setPlant(i: number, x: number, z: number): void {
        this._plant[i * 3] = x;
        this._plant[i * 3 + 1] = this._field.sampleHeight(x, z) + P.ankle;
        this._plant[i * 3 + 2] = z;
    }

    /** Build the whole pose, in character space, and bake the palette. */
    private _pose(mover: Mover, stepPhase: number, stride: number, speedRatio: number): void {
        const s = this._settings.v;
        const sk = this.skeleton;
        const moving = 1 - this._stand;

        // --- pelvis ---------------------------------------------------------
        //
        // THE BOB IS NOT A CHOSEN NUMBER. With the feet split by one stride at contact,
        // each is stride/2 from the body, so a leg of fixed length can only reach the
        // ground by lowering the hip through the sagitta of that triangle. At mid-stance
        // the leg is vertical and the hip rides at full height. That is the whole of it:
        // the pelvis falls by exactly as much as the geometry says it must, which is why
        // changing the stride slider changes the walk rather than breaking it.
        const halfStride = Math.min(stride * 0.5, LEG * 0.95);
        const drop = LEG - Math.sqrt(Math.max(LEG * LEG - halfStride * halfStride, 0));
        const standY = P.ankle + LEG * 0.97;
        const bob = drop * 0.5 * (1 + Math.cos(2 * Math.PI * stepPhase)) * moving;

        // Weight shifts onto whichever foot is in mid-stance: the right at half-integer
        // steps, the left a step later.
        const sway = s["char.stanceWidth"] * 0.32 * Math.sin(Math.PI * stepPhase) * moving;

        // Forward lean grows with speed. The bank into a turn is the real balance angle
        // — tan(bank) = v * omega / g, the sum a cyclist does — so it falls out of how
        // fast the character is actually turning rather than out of a curve someone drew.
        const leanZ = Math.tan(s["char.lean"] * DEG) * Math.min(speedRatio, 2.4) * moving;
        const leanX = clampAbs((mover.speed * this._turn) / G, 0.55) * s["char.bank"];

        const pelvisY = standY - bob;
        sk.setHead(B.pelvis, sway, pelvisY, 0);
        sk.setDir(B.pelvis, leanX, 1, leanZ);

        // --- torso, chained head to tail ------------------------------------
        //
        // Each segment leans less than the one below it, so the lean is spent through the
        // spine and the head arrives very nearly upright — which is what a body does, and
        // what keeps the camera's subject from tipping over at speed.
        this._chain(B.pelvis, B.spine, leanX * 0.6, 1, leanZ * 0.5);
        this._chain(B.spine, B.chest, leanX * 0.25, 1, leanZ * 0.2);
        this._chain(B.chest, B.neck, leanX * 0.1, 1, leanZ * 0.06);
        this._chain(B.neck, B.head, 0, 1, 0.04);

        // --- legs -----------------------------------------------------------
        //
        // Hips ride on the pelvis and roll with it. The right vector of a segment that
        // only leans is (up.y, -up.x, 0) normalised, so the hip drops on whichever side
        // the body has tipped towards, which is what makes the roll read at all.
        const rl = Math.sqrt(1 + leanX * leanX);
        const rightX = 1 / rl;
        const rightY = -leanX / rl;
        this._leg(B.thighR, B.shinR, B.footR, sway + rightX * P.hipHalf, pelvisY + rightY * P.hipHalf, 0, speedRatio);
        this._leg(B.thighL, B.shinL, B.footL, sway - rightX * P.hipHalf, pelvisY - rightY * P.hipHalf, 1, speedRatio);

        // --- arms -----------------------------------------------------------
        //
        // Counter-phased against the legs: the right arm is back at the moment the right
        // foot lands. That opposition is what stops a walk reading as a shuffle, and it
        // costs one sign.
        const swing = s["char.armSwing"] * DEG * Math.min(0.5 + 0.5 * speedRatio, 1.8) * moving;
        const wave = Math.cos(Math.PI * stepPhase);
        // A hanging arm still has a slight bend; a running one has a lot.
        const elbow = (12 + 34 * clamp01(speedRatio)) * DEG;
        const neckX = sk.head[B.neck * 3];
        const neckY = sk.head[B.neck * 3 + 1];
        const neckZ = sk.head[B.neck * 3 + 2];
        const shoulderY = neckY - (P.neckY - P.shoulderY);
        this._arm(B.upperArmR, B.foreArmR, B.handR, neckX + P.shoulderHalf, shoulderY, neckZ, -swing * wave, elbow);
        this._arm(B.upperArmL, B.foreArmL, B.handL, neckX - P.shoulderHalf, shoulderY, neckZ, swing * wave, elbow);

        // --- cloak ----------------------------------------------------------
        // Rides the chest and hangs. Pass E gives it a solver and the wind that already
        // moves the smoke; until then it is a bone that goes where the back goes.
        sk.setHead(B.cloak, sk.tailX(B.chest), sk.tailY(B.chest) - 0.06, sk.tailZ(B.chest) - 0.075);
        sk.setDir(B.cloak, -leanX * 0.3, -1, -0.16 - leanZ * 0.4);

        sk.solve(this._px, this._py, this._pz, mover.facing);
    }

    /** Put a bone's head on its parent's tail and point it somewhere. */
    private _chain(parent: number, bone: number, dx: number, dy: number, dz: number): void {
        const sk = this.skeleton;
        sk.setHead(bone, sk.tailX(parent), sk.tailY(parent), sk.tailZ(parent));
        sk.setDir(bone, dx, dy, dz);
    }

    /**
     * Two-bone analytic IK, hip to ankle, plus the foot roll.
     *
     * The law of cosines gives the angle between the thigh and the straight line to the
     * ankle; the knee then sits somewhere on the circle that angle sweeps, and the pole
     * picks which point. Knees bend forward, splayed very slightly outward so they clear
     * each other at the bottom of a stride.
     */
    private _leg(thigh: number, shin: number, foot: number, hx: number, hy: number, i: number, speedRatio: number): void {
        const sk = this.skeleton;
        const side = i === 0 ? 1 : -1;

        // The ankle is tracked in world space so a planted foot cannot drift. Bringing it
        // into character space is one yaw and one translation.
        const dxw = this._ankle[i * 3] - this._px;
        const dzw = this._ankle[i * 3 + 2] - this._pz;
        const ax = dxw * this._cos - dzw * this._sin;
        const az = dxw * this._sin + dzw * this._cos;
        const ay = this._ankle[i * 3 + 1] - this._py;

        let tx = ax - hx;
        let ty = ay - hy;
        let tz = az;
        let d = Math.sqrt(tx * tx + ty * ty + tz * tz);
        // Never ask for more than the leg has. This clamp is the difference between a
        // steep step and a NaN that quietly turns the whole figure inside out.
        const dMin = Math.abs(THIGH - SHIN) + 1e-3;
        const dMax = LEG - 1e-3;
        if (d < 1e-5) {
            tx = 0;
            ty = -dMin;
            tz = 0;
            d = dMin;
        } else {
            const scale = Math.min(Math.max(d, dMin), dMax) / d;
            tx *= scale;
            ty *= scale;
            tz *= scale;
            d *= scale;
        }
        const ux = tx / d;
        const uy = ty / d;
        const uz = tz / d;

        const cosA = Math.min(Math.max((THIGH * THIGH + d * d - SHIN * SHIN) / (2 * THIGH * d), -1), 1);
        const a = Math.acos(cosA);

        // Pole, made perpendicular to the hip-ankle line.
        const polX = side * 0.18;
        const dotP = polX * ux + uz;
        let qx = polX - ux * dotP;
        let qy = -uy * dotP;
        let qz = 1 - uz * dotP;
        const ql = Math.sqrt(qx * qx + qy * qy + qz * qz);
        if (ql > 1e-5) {
            qx /= ql;
            qy /= ql;
            qz /= ql;
        } else {
            qx = 0;
            qy = 0;
            qz = 1;
        }

        const sa = Math.sin(a);
        const ca = Math.cos(a);
        const thighX = ux * ca + qx * sa;
        const thighY = uy * ca + qy * sa;
        const thighZ = uz * ca + qz * sa;

        const kneeX = hx + thighX * THIGH;
        const kneeY = hy + thighY * THIGH;
        const kneeZ = thighZ * THIGH;

        sk.setHead(thigh, hx, hy, 0);
        sk.setDir(thigh, thighX, thighY, thighZ);
        sk.setHead(shin, kneeX, kneeY, kneeZ);
        sk.setDir(shin, ax - kneeX, ay - kneeY, az - kneeZ);

        // The foot rolls: flat through early stance, up off the toe at the end of it,
        // toe raised through the swing so it clears the ground it is crossing.
        const t = this._phase[i];
        const duty = this._duty;
        const roll = this._settings.v["char.footRoll"] * DEG;
        const pitch =
            (t < duty ? roll * smoothstep(0.55, 1, t / duty) : -roll * 0.7 * Math.sin((Math.PI * (t - duty)) / (1 - duty))) *
            (1 - this._stand) *
            Math.min(0.7 + 0.3 * speedRatio, 1.5);

        const fi = foot * 3;
        const ry = sk.restDir[fi + 1];
        const rz = sk.restDir[fi + 2];
        const cp = Math.cos(pitch);
        const sp = Math.sin(pitch);
        sk.setHead(foot, ax, ay, az);
        sk.setDir(foot, sk.restDir[fi], ry * cp - rz * sp, ry * sp + rz * cp);
    }

    /** Shoulder, elbow and hand from two angles. A round limb needs no IK to read. */
    private _arm(upper: number, fore: number, hand: number, sx: number, sy: number, sz: number, angle: number, elbow: number): void {
        const sk = this.skeleton;
        // Keep the outward splay the rest pose has and spend the swing on the other two
        // axes, so the arms stay clear of the ribs however far they travel.
        const splay = sk.restDir[upper * 3];
        const drop = Math.sqrt(Math.max(1 - splay * splay, 0));

        const uy = -Math.cos(angle) * drop;
        const uz = Math.sin(angle) * drop;
        sk.setHead(upper, sx, sy, sz);
        sk.setDir(upper, splay, uy, uz);

        const fa = angle + elbow;
        const fy = -Math.cos(fa) * drop;
        const fz = Math.sin(fa) * drop;
        sk.setHead(fore, sx + splay * UPPER_ARM, sy + uy * UPPER_ARM, sz + uz * UPPER_ARM);
        sk.setDir(fore, splay, fy, fz);

        sk.setHead(hand, sk.tailX(fore), sk.tailY(fore), sk.tailZ(fore));
        sk.setDir(hand, splay, fy, fz);
    }
}

function clamp01(v: number): number {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clampAbs(v: number, limit: number): number {
    return v < -limit ? -limit : v > limit ? limit : v;
}

function smoothstep(a: number, b: number, x: number): number {
    const t = clamp01((x - a) / (b - a));
    return t * t * (3 - 2 * t);
}
