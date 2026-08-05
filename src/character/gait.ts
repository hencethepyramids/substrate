import type { Settings } from "../core/settings";
import type { Mover } from "../core/mover";
import type { Heightfield } from "../terrain/heightfield";
import type { GroundProbe } from "../substrate/groundProbe";
import { Skeleton, B, P, THIGH, SHIN, LEG, UPPER_ARM } from "./skeleton";
import { legPoseAt, type LegPose } from "./gaitCurves";

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
/** A sprinter is airborne for most of the cycle. This is what buys a long stride. */
const DUTY_RUN = 0.20;

/**
 * Where walking becomes running, in metres per second — ABSOLUTE, not relative.
 *
 * Everything used to key off speed divided by char.walkSpeed, which quietly asserted that
 * whatever the slider says is a walk. It says 3.2 m/s, and 3.2 m/s is a run for a 1.8 m
 * figure — so the gait used a walking duty of 0.62 at a speed no one walks at, and the
 * geometry cap then held the stride down to something that needed 4.3 steps a second.
 * A human transitions at about 2 m/s regardless of what any slider is called.
 */
const RUN_FROM = 1.8;
const RUN_TO = 5.5;

/** Steps per second at a stroll and at a sprint. Cadence barely moves; stride does. */
const CADENCE_WALK = 1.95;
const CADENCE_RUN = 3.6;

/** The stride slider reads as a scale against this, so its default means "unchanged". */
const STRIDE_REFERENCE = 0.75;

/** How fast the figure settles into a standing pose once it stops, per second. */
const SETTLE_RATE = 9;

/**
 * How fast a planted foot follows ground that gives way beneath it, per second.
 *
 * THIS IS ANTI-POP, NOT SOIL MECHANICS. The stamp is instantaneous in the model, so
 * without any damping a boot drops the full depth of its own print in a single frame. A
 * time constant of ten milliseconds spreads that over a couple of frames and no more —
 * anything slower is a foot failing to keep up with ground it is supposed to be standing
 * on, which at a sprint is most of the contact, because a sprint's stance is 78 ms long.
 */
const SINK_RATE = 100;

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
    private _probe: GroundProbe | null = null;

    /** Cycle index per foot: 0 is the right, 1 the left. */
    private readonly _cycle = new Int32Array(2);
    /** Where each foot last landed, world space, at ankle height. */
    private readonly _plant = new Float32Array(6);
    /** Where each ankle is now, world space. */
    private readonly _ankle = new Float32Array(6);
    /** The same ankles in character space, so the pelvis and the legs share one answer. */
    private readonly _ankleChar = new Float32Array(6);
    /** Phase within each foot's own cycle, 0 at contact. */
    private readonly _phase = new Float32Array(2);

    /** 0 walking, 1 standing. Damped, so stopping settles rather than snaps. */
    private _stand = 1;
    private _duty = DUTY_WALK;
    private _stride = 0.75;
    /** 0 walking, 1 running, on the clock of absolute speed. Shared by the whole pose. */
    private _run = 0;
    /** 0 upright, 1 fully into the slide crouch. Damped, so dropping into it is a move. */
    private _slide = 0;
    /** Hip height above the ankle this frame, metres. Shared by the pose and the cap. */
    private _hipHeight = LEG * 0.83;
    /** Integrated gait phase, in steps. Not derived from total distance — see update. */
    private _stepPhase = 0;
    private _distancePrev = 0;
    private _facingPrev = 0;
    /** Smoothed turn rate, rad/s. */
    private _turn = 0;
    private _seeded = false;
    /** Wall clock for the idle. Simulation seconds, so a pause holds the pose. */
    private _clock = 0;
    /** Scratch for the measured swing pose. Rule 1: frame() allocates nothing. */
    private readonly _pose1: LegPose = { hip: 0, knee: 0 };

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

    /**
     * Give the gait the CPU window of the substrate, so feet land on the ground the
     * character has carved rather than on the one underneath it. Called from main once
     * both exist. Without it the gait still runs — on the undisturbed heightfield.
     */
    setProbe(probe: GroundProbe): void {
        this._probe = probe;
    }

    /**
     * The height of the surface that is actually DRAWN: the heightfield less whatever has
     * been taken out of it. Everything in this file that asks where the ground is asks
     * here, so a print, a carve and a wake all hold the foot that finds them.
     */
    groundAt(x: number, z: number): number {
        const h = this._field.sampleHeight(x, z);
        return this._probe === null ? h : h - this._probe.depressionAt(x, z);
    }

    /** Phase within a foot's own cycle, 0 at contact. 0 is the right foot, 1 the left. */
    phaseOf(foot: number): number {
        return this._phase[foot];
    }

    /** The stride the gait is actually using, metres of ground per step. */
    get stride(): number {
        return this._stride;
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
        this._stepPhase = stepPhase;
        this._distancePrev = mover.distance;
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
        const walk = Math.max(s["char.walkSpeed"], 0.1);
        const speedRatio = mover.speed / walk;

        this._clock += dt;
        this._px = mover.position.x;
        this._py = mover.position.y;
        this._pz = mover.position.z;
        this._cos = Math.cos(mover.facing);
        this._sin = Math.sin(mover.facing);

        // A walk rolls through a long stance; a run spends most of the cycle airborne.
        // How far into running the character is, on the clock of absolute speed.
        const run = clamp01((mover.speed - RUN_FROM) / (RUN_TO - RUN_FROM));
        this._run = run;
        const duty = DUTY_WALK + (DUTY_RUN - DUTY_WALK) * run;
        this._duty = duty;

        // STRIDE GROWS WITH SPEED, AND IS CAPPED BY THE LEGS.
        //
        // Holding it fixed is what made fast movement read as a frantic shuffle: cadence
        // is speed over stride, so a fixed 0.75 m stride meant 4.3 steps per second at
        // walking pace and 10.2 at a sprint, against about 3 for a real runner. No amount
        // of knee bend fixes a figure taking ten steps a second.
        //
        // Most of a human's speed increase comes from a longer stride rather than a
        // faster cadence, which is the 0.7 exponent — and the slider keeps its meaning as
        // the stride at walking pace.
        //
        // THE CAP IS GEOMETRY, NOT TASTE. A foot is planted for `duty * 2 * stride` of
        // ground and sits half that either side of the hip, so that half has to stay
        // inside what the leg can span at walking hip height. Lowering the duty is
        // precisely what buys a runner a longer stride, and this says so in one line.
        // A RUNNER CROUCHES, and that is what buys the reach a long stride needs. The
        // same figure feeds the pose below, because a cap derived from a taller hip than
        // the character actually stands at licenses a stride the leg cannot make — and
        // the leg-reach clamp then drags the foot short of where the gait put it, which
        // on sloped ground reads as the foot sinking into the hill.
        this._hipHeight = LEG * (0.97 - 0.14 * (1 - this._stand) - 0.04 * run - 0.2 * this._slide);
        const reach = Math.sqrt(Math.max(LEG * LEG - this._hipHeight * this._hipHeight, 0)) * 0.95;
        // Stride follows from a cadence a human would actually use, and is then held to
        // what the legs can span. The slider still sets the walking stride; below the run
        // threshold it is what it always was.
        const cadence = CADENCE_WALK + (CADENCE_RUN - CADENCE_WALK) * run;
        // The slider scales the whole gait rather than setting one number, because the
        // stride is derived now. At its default it is exactly 1, so the control still
        // means what it did — longer steps, fewer of them — without pretending to fix a
        // length that speed and leg geometry between them decide.
        const scale = Math.max(s["char.strideLength"], 0.05) / STRIDE_REFERENCE;
        const stride = Math.min(Math.max((mover.speed / cadence) * scale, 0.12), reach / duty);
        this._stride = stride;

        // Standing is a separate state, cross-faded in. The cycle is phased on distance,
        // so when the character stops, distance stops and the phase FREEZES — without
        // this, halting mid-stride would leave a foot hanging in the air forever.
        // A SLIDING BODY IS NOT TAKING STEPS, so the walk cycle is switched off and the
        // feet ride under the hips exactly as they do when standing. That suspends the
        // no-sliding contract on purpose: the feet ARE sliding, which is the whole point,
        // and pretending otherwise would plant them in ground that is moving past.
        const moving = mover.speed >= MOVING_SPEED && !mover.sliding;
        const decay = dt > 0 ? 1 - Math.exp(-SETTLE_RATE * dt) : 0;
        this._stand += ((moving ? 0 : 1) - this._stand) * decay;
        this._slide += ((mover.sliding ? 1 : 0) - this._slide) * (dt > 0 ? 1 - Math.exp(-7 * dt) : 0);

        // Turn rate, for the bank. Wrapped, because facing crosses pi every time the
        // character walks south.
        let turned = mover.facing - this._facingPrev;
        while (turned > Math.PI) turned -= Math.PI * 2;
        while (turned < -Math.PI) turned += Math.PI * 2;
        this._facingPrev = mover.facing;
        const rate = dt > 1e-5 ? turned / dt : 0;
        this._turn += (rate - this._turn) * (dt > 0 ? 1 - Math.exp(-12 * dt) : 0);

        // THE PHASE ACCUMULATES; IT IS NOT DIVIDED OUT OF THE TOTAL.
        //
        //  was correct while the stride was a constant. It is not,
        // now that the stride grows with speed: changing the divisor rewrites the whole
        // history, so the phase jumps the moment the character accelerates and the gait
        // skips or repeats a step. Integrating the ground travelled, divided by the stride
        // IN FORCE AT THE TIME, keeps it continuous — and it is still phased on distance,
        // which is the contract that matters.
        this._stepPhase += Math.max(mover.distance - this._distancePrev, 0) / stride;
        this._distancePrev = mover.distance;
        const stepPhase = this._stepPhase;
        const half = s["char.stanceWidth"] * 0.5;
        // THE KNEE HAS TO CYCLE, NOT SCYTHE.
        //
        // This was another speedRatio, so the swing foot cleared the ground by the same
        // 13 cm at 3.2 m/s as it does at a stroll. Thirteen centimetres is a walk's
        // clearance; a runner brings the heel up towards the backside and the foot passes
        // 40 cm off the deck. With too little lift the leg swings through almost straight,
        // which is most of what made the cycle read as stiff — the legs looked like they
        // were being swept forward rather than picked up and put down.
        const lift = s["char.stepLift"] * (0.9 + 2.6 * this._run);

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

            // A FOOT PLANTS AHEAD OF THE BODY, NOT UNDER IT.
            //
            // This is the single thing that made the walk look wrong, and it is geometry
            // rather than taste. A foot is down for `duty` of its cycle and a cycle is two
            // strides of ground, so while it is planted the body travels `duty * 2 *
            // stride` past it. Landing it underneath means it ends stance that entire
            // distance behind the hip — 0.93 m against a leg of 0.86 — so the leg is
            // straight for the whole back half of every step and the IK clamps: the foot
            // is drawn somewhere the leg physically cannot reach, and the shin stops
            // short of it. Measured at 97% mean extension with peaks of 111%, and 40% of
            // frames pinned at full stretch.
            //
            // Landing it `duty * stride` ahead makes the excursion symmetric — the same
            // distance in front at touchdown as behind at toe-off — which halves the reach
            // the leg is asked for and lets the knee bend through the whole of stance. It
            // is also the geometry the pelvis bob was derived for.
            const lead = duty * stride;
            const plantX = this._px + travelX * lead + this._cos * half * side;
            const plantZ = this._pz + travelZ * lead - this._sin * half * side;
            // Where the foot belongs when the character is simply standing: underneath.
            const standX = this._px + this._cos * half * side;
            const standZ = this._pz - this._sin * half * side;

            if (k !== this._cycle[i]) {
                // One plant however many cycles were skipped. A hitch drops prints; it
                // does not pay them back as a burst all landing in one footstep.
                this._cycle[i] = k;
                this._setPlant(i, plantX, plantZ);
                if (this.plantCount < MAX_PLANTS && moving) {
                    const p = this.plants[this.plantCount++];
                    p.x = plantX;
                    p.z = plantZ;
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
                // Stance. The foot IS the plant in X and Z — that is the no-sliding claim
                // and it does not bend.
                ax = px;
                az = pz;
                // BUT IT SINKS. The plant's height is recorded at the moment of contact,
                // which is before the print exists — the carve pass stamps it on the same
                // frame and the relaxation deepens it over the next few. Holding the foot
                // at the height the ground USED to be leaves the boot hanging over its own
                // print by the full depth of it, which measured at 10.7 cm in snow.
                //
                // So the foot follows the surface down, damped rather than teleported,
                // because snow gives way under a boot over a few tens of milliseconds and
                // an instant drop reads as a pop. Horizontally fixed, vertically live: the
                // ground is allowed to move under a planted foot, and it does.
                const settled = this.groundAt(px, pz) + P.ankle;
                const prev = this._ankle[i * 3 + 1];
                ay = dt > 0 ? prev + (settled - prev) * (1 - Math.exp(-SINK_RATE * dt)) : settled;
            } else {
                const u = (t - duty) / (1 - duty);
                // THE SWING COMES FROM MEASURED KINEMATICS, NOT FROM AN ARC.
                //
                // Sliding the foot along a lerp with a sine lift on it is the obvious
                // thing and it is why the leg looked swept rather than cycled: a real
                // swing is a hip reaching and a knee tucking, and the ankle position is
                // what falls OUT of those, not what drives them. So the hip and knee come
                // from gaitCurves and the ankle is their forward kinematics.
                //
                // Blended to the real landing over the last third, because the plant is
                // still the plant — the print has to be under the foot and the foot has
                // to stop where the ground is. Authored where the look matters, IK where
                // the contract does.
                legPoseAt(t, this._run, this._pose1);
                const hipY = P.ankle + this._hipHeight;
                const kneeZ = Math.sin(this._pose1.hip) * THIGH;
                const kneeY = hipY - Math.cos(this._pose1.hip) * THIGH;
                const shinA = this._pose1.hip - this._pose1.knee;
                const poseZ = kneeZ + Math.sin(shinA) * SHIN;
                const poseY = kneeY - Math.cos(shinA) * SHIN;
                const lat = half * side;
                const poseWX = this._px + lat * this._cos + poseZ * this._sin;
                const poseWZ = this._pz - lat * this._sin + poseZ * this._cos;
                const poseWY = this._py + poseY;
                // Where the body will be when this foot next touches down. Recomputed
                // every frame, so a turn mid-swing steers the foot rather than leaving
                // it committed to a landing the character is no longer walking towards.
                const remaining = (1 - t) * 2 * stride;
                const tx = this._px + travelX * (remaining + lead) + this._cos * half * side;
                const tz = this._pz + travelZ * (remaining + lead) - this._sin * half * side;
                const ease = u * u * (3 - 2 * u);
                // Wide enough that a sprint can converge. At duty 0.20 the last third of
                // swing is about thirty milliseconds, which is not long enough to travel
                // from a 105-degree tuck to a foot on the ground — the print ended up
                // somewhere the foot was not.
                const land = smoothstep(0.3, 1.0, u);
                const ty = this.groundAt(tx, tz) + P.ankle;
                ax = poseWX + (px + (tx - px) * ease - poseWX) * land;
                az = poseWZ + (pz + (tz - pz) * ease - poseWZ) * land;
                ay = poseWY + (py + (ty - py) * ease + Math.sin(Math.PI * u) * lift - poseWY) * land;
                // Never through a rise the swing happens to cross.
                const here = this.groundAt(ax, az) + P.ankle;
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
                const ny = this.groundAt(standX, standZ) + P.ankle;
                ax += (standX - ax) * this._stand;
                ay += (ny - ay) * this._stand;
                az += (standZ - az) * this._stand;
            }

            this._ankle[i * 3] = ax;
            this._ankle[i * 3 + 1] = ay;
            this._ankle[i * 3 + 2] = az;
        }

        this._pose(mover, stepPhase, stride);
    }

    private _setPlant(i: number, x: number, z: number): void {
        this._plant[i * 3] = x;
        this._plant[i * 3 + 1] = this.groundAt(x, z) + P.ankle;
        this._plant[i * 3 + 2] = z;
    }

    /** Build the whole pose, in character space, and bake the palette. */
    private _pose(mover: Mover, stepPhase: number, stride: number): void {
        const s = this._settings.v;
        const sk = this.skeleton;
        const moving = 1 - this._stand;

        // The ankles, brought into character space once. Both the pelvis and the leg solve
        // need them, and computing them twice is how the two end up disagreeing about
        // where a foot is.
        for (let i = 0; i < 2; i++) {
            const dx = this._ankle[i * 3] - this._px;
            const dz = this._ankle[i * 3 + 2] - this._pz;
            this._ankleChar[i * 3] = dx * this._cos - dz * this._sin;
            this._ankleChar[i * 3 + 1] = this._ankle[i * 3 + 1] - this._py;
            this._ankleChar[i * 3 + 2] = dx * this._sin + dz * this._cos;
        }

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
        // YOU STAND TALL AND YOU WALK WITH BENT KNEES.
        //
        // A single standing height was the other half of the locked-leg problem. The reach
        // cap below is a LIMIT, and if the pose sits at the limit then the leg is straight
        // by construction — which is what it did, at 97% extension through the whole cycle.
        // Real walking carries the hip at about 0.88 of leg length rather than 0.97, and
        // that difference is the entire knee bend. Standing gets the tall pose back, and
        // the crossfade is the same `moving` the rest of the gait already uses.
        const standY = P.ankle + this._hipHeight;
        const bob = drop * 0.5 * (1 + Math.cos(2 * Math.PI * stepPhase)) * moving;

        // Weight shifts onto whichever foot is in mid-stance: the right at half-integer
        // steps, the left a step later.
        const sway = s["char.stanceWidth"] * 0.32 * Math.sin(Math.PI * stepPhase) * moving;

        // Forward lean grows with speed. The bank into a turn is the real balance angle
        // — tan(bank) = v * omega / g, the sum a cyclist does — so it falls out of how
        // fast the character is actually turning rather than out of a curve someone drew.
        //
        // Climbing adds to it, because you lean into a hill for the same reason you lean
        // into speed: the line from your feet through your centre of mass has to stay
        // over the ground you are pushing against.
        const climb = clampAbs(this._slopeAlong(this._px, this._pz, this._sin, this._cos, 0.5), 0.8);
        const leanZ = (Math.tan(s["char.lean"] * DEG) * (0.35 + 1.6 * this._run) * moving + climb * 0.32) * 1;
        const leanX = clampAbs((mover.speed * this._turn) / G, 0.55) * s["char.bank"];

        // NEVER ASK A LEG FOR MORE THAN IT HAS. The bob above is the flat-ground case of a
        // general constraint: the pelvis can be no higher above either ankle than a leg can
        // span at that horizontal distance. On a slope, in a hole, or over a print the
        // character has just stamped, the two feet sit at different heights and the bob
        // alone leaves the lower leg straight and still short — the foot hanging above its
        // own print, which is precisely the thing this pass exists to fix. So the same
        // triangle that gives the bob also gives a cap, and the cap only ever binds when
        // the ground is doing something the flat case did not anticipate.
        let cap = Infinity;
        for (let i = 0; i < 2; i++) {
            const dx = this._ankleChar[i * 3] - sway;
            const dz = this._ankleChar[i * 3 + 2];
            const flat = Math.sqrt(dx * dx + dz * dz);
            const reach = Math.sqrt(Math.max(LEG * LEG - flat * flat, 0)) * 0.99;
            cap = Math.min(cap, this._ankleChar[i * 3 + 1] + reach);
        }

        // Standing still is not standing rigid. Two slow oscillations at unrelated
        // periods — breath, and the weight drifting from one foot to the other — which
        // beat against each other so the figure never repeats a pose. Faded in by the
        // same `_stand` the settle uses, so it is absent the moment anyone walks and no
        // second state machine is needed to switch it off.
        const idle = this._stand;
        const breath = Math.sin(this._clock * 1.55) * 0.007 * idle;
        const shift = Math.sin(this._clock * 0.83) * 0.013 * idle;

        const pelvisY = Math.min(standY - bob + breath, cap);
        sk.setHead(B.pelvis, sway + shift, pelvisY, 0);
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
        const hipMid = sway + shift;
        this._leg(B.thighR, B.shinR, B.footR, hipMid + rightX * P.hipHalf, pelvisY + rightY * P.hipHalf, 0);
        this._leg(B.thighL, B.shinL, B.footL, hipMid - rightX * P.hipHalf, pelvisY - rightY * P.hipHalf, 1);

        // --- arms -----------------------------------------------------------
        //
        // Counter-phased against the legs: the right arm is back at the moment the right
        // foot lands. That opposition is what stops a walk reading as a shuffle, and it
        // costs one sign.
        const swing = s["char.armSwing"] * DEG * (0.6 + 0.5 * this._run) * moving;
        const wave = Math.cos(Math.PI * stepPhase);
        // THE FOREARM LAGS THE SHOULDER. An arm is not a rigid rod hinged at the top: the
        // elbow trails what the shoulder is doing by a fraction of a beat, and that lag is
        // most of what makes a swinging arm look loose rather than bolted on. An eighth of
        // a step is small enough to read as slack and large enough to see.
        const waveLag = Math.cos(Math.PI * (stepPhase - 0.16));
        // A hanging arm still has a slight bend; a running one has a lot.
        // ON ABSOLUTE SPEED, NOT ON THE RATIO TO A SLIDER CALLED "walk".
        //
        // This was 12 + 34 * clamp01(speedRatio), which is 46 degrees the moment the
        // character reaches char.walkSpeed — and char.walkSpeed is 3.2 m/s, a jog. So a
        // running arm carriage was applied at walking pace: the forearm sat 46 degrees
        // forward of the upper arm at ALL times, which meant that however far the shoulder
        // swung, the forearm never once came behind vertical. Every frame of the cycle had
        // both arms held out in front, horizontally, like a sleepwalker. It is the single
        // thing that made the walk look wrong, and no single screenshot showed it — it
        // took a contact sheet of a whole cycle to see that the arms were not moving.
        const elbow = (6 + 54 * this._run) * DEG;
        const neckX = sk.head[B.neck * 3];
        const neckY = sk.head[B.neck * 3 + 1];
        const neckZ = sk.head[B.neck * 3 + 2];
        const shoulderY = neckY - (P.neckY - P.shoulderY);
        this._arm(B.upperArmR, B.foreArmR, B.handR, neckX + P.shoulderHalf, shoulderY, neckZ, -swing * wave, elbow, -swing * waveLag);
        this._arm(B.upperArmL, B.foreArmL, B.handL, neckX - P.shoulderHalf, shoulderY, neckZ, swing * wave, elbow, swing * waveLag);

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
    private _leg(thigh: number, shin: number, foot: number, hx: number, hy: number, i: number): void {
        const sk = this.skeleton;
        const side = i === 0 ? 1 : -1;

        // The ankle is tracked in world space so a planted foot cannot drift; `_pose` has
        // already brought both into character space, and this reads that one answer.
        const ax = this._ankleChar[i * 3];
        const ay = this._ankleChar[i * 3 + 1];
        const az = this._ankleChar[i * 3 + 2];

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

        // THE ANKLE THE LEG CAN ACTUALLY REACH, which is the clamped one. Pointing the
        // shin at a target beyond the leg's length and then drawing the foot AT that
        // target leaves the two disconnected — a foot floating off the end of a shin that
        // stops short of it. Whatever the gait wanted, the leg is as long as it is.
        const reachX = hx + tx;
        const reachY = hy + ty;
        const reachZ = tz;

        sk.setHead(thigh, hx, hy, 0);
        sk.setDir(thigh, thighX, thighY, thighZ);
        sk.setHead(shin, kneeX, kneeY, kneeZ);
        sk.setDir(shin, reachX - kneeX, reachY - kneeY, reachZ - kneeZ);

        // The foot rolls: flat through early stance, up off the toe at the end of it,
        // toe raised through the swing so it clears the ground it is crossing.
        const t = this._phase[i];
        const duty = this._duty;
        const roll = this._settings.v["char.footRoll"] * DEG;
        const gaitPitch =
            (t < duty ? roll * smoothstep(0.55, 1, t / duty) : -roll * 0.7 * Math.sin((Math.PI * (t - duty)) / (1 - duty))) *
            (1 - this._stand) *
            (0.8 + 0.6 * this._run);

        // AND THE GROUND'S OWN PITCH. A sole that stays level while the hill under it does
        // not is the tell that a character is walking on an idea of the terrain rather
        // than on the terrain — one half of the foot sinks in and the other floats. The
        // slope is measured along the foot's own forward direction on the DRAWN surface,
        // so a print, a carve and a hillside all tilt it the same way.
        //
        // Pitch only, not roll: the bone's orientation comes from a shortest-arc rotation
        // onto its direction, which leaves the twist about that direction undetermined by
        // construction. Sideways tilt needs a frame the rig does not carry.
        const wx = this._ankle[i * 3];
        const wz = this._ankle[i * 3 + 2];
        const ground = clampAbs(this._slopeAlong(wx, wz, this._sin, this._cos, P.toeZ), 0.7);
        const pitch = gaitPitch - Math.atan(ground);

        const fi = foot * 3;
        const ry = sk.restDir[fi + 1];
        const rz = sk.restDir[fi + 2];
        const cp = Math.cos(pitch);
        const sp = Math.sin(pitch);
        sk.setHead(foot, reachX, reachY, reachZ);
        sk.setDir(foot, sk.restDir[fi], ry * cp - rz * sp, ry * sp + rz * cp);
    }

    /**
     * Rise per metre of the DRAWN surface along a horizontal direction, measured over a
     * span rather than differentiated at a point.
     *
     * A central difference over a real distance is what makes this usable: the substrate
     * window is 6 cm texels and its bilinear surface has derivative jumps at every one of
     * them, so a point derivative would have the foot flicking between texel slopes as it
     * crossed. Measuring over the length of the thing being tilted asks the question at
     * the scale it is being asked about.
     */
    private _slopeAlong(x: number, z: number, dirX: number, dirZ: number, span: number): number {
        const ahead = this.groundAt(x + dirX * span, z + dirZ * span);
        const behind = this.groundAt(x - dirX * span, z - dirZ * span);
        return (ahead - behind) / (2 * span);
    }

    /** Shoulder, elbow and hand from two angles. A round limb needs no IK to read. */
    private _arm(upper: number, fore: number, hand: number, sx: number, sy: number, sz: number, angle: number, elbow: number, lagged: number): void {
        const sk = this.skeleton;
        // Keep the outward splay the rest pose has and spend the swing on the other two
        // axes, so the arms stay clear of the ribs however far they travel.
        const splay = sk.restDir[upper * 3];
        const drop = Math.sqrt(Math.max(1 - splay * splay, 0));

        const uy = -Math.cos(angle) * drop;
        const uz = Math.sin(angle) * drop;
        sk.setHead(upper, sx, sy, sz);
        sk.setDir(upper, splay, uy, uz);

        // The forearm is carried by where the shoulder WAS, plus the flexion.
        const fa = lagged + elbow;
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
