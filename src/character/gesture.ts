import type { Settings } from "../core/settings";

/**
 * What the body does because the ground is being commanded.
 *
 * PHASE 13 OPENS ON THE SAME KIND OF GAP PHASE 10 DID. Phase 12 gave the player five ways
 * to move earth and the character performs none of them: the ridge runs, the wall goes up,
 * the drift sweeps aside, and the figure stands there with its arms swinging as though out
 * for a walk. Every other system in this project answers to something; the body answers
 * only to where the feet are going.
 *
 * WHY THIS IS NOT IN gait.ts. The gait solves LOCOMOTION — where the feet land, how the
 * pelvis rides, what the arms do to balance a stride — and it does that from speed and
 * heading alone. A gesture is driven by something the gait has no business knowing about:
 * which verb is held. Putting the two in one file would mean the leg solver could see the
 * verb layer, and the first time a bending pose needed a foot to move, the two would start
 * fighting over the same bones. So this decides a POSE and the gait decides how much of it
 * to believe.
 *
 * WHAT IT DOES NOT TOUCH, deliberately, in this pass: the legs, the pelvis and the spine.
 * A bender leans into the thing they are lifting, and that lean is most of what would sell
 * it — but the pelvis is also what the gait plants the feet against, and reaching into it
 * before the arms read correctly would make one problem into two.
 */

/**
 * The verbs a body can be seen doing, and nothing else about them.
 *
 * Structurally satisfied by Input, so the shipping path passes it straight in — but stated
 * as its own interface because this module has no business knowing what a key is, and the
 * probe drives it with a plain object.
 */
export interface Commanding {
    readonly sweep: boolean;
    readonly draw: boolean;
    readonly raise: boolean;
    readonly lower: boolean;
    readonly pedestal: boolean;
}

/** What the gait blends against its own arm swing. Angles are radians. */
export interface GesturePose {
    /** 0 = the gait owns the arms, 1 = the gesture does. */
    readonly weight: number;
    /** Shoulder angle: 0 hangs, +pi/2 points straight ahead, more than that reaches up. */
    readonly shoulder: number;
    /** Elbow flexion carried on top of the shoulder. */
    readonly elbow: number;
}

const DEG = Math.PI / 180;

/**
 * The five poses, as shoulder and elbow angles.
 *
 * ANGLES RATHER THAN HAND POSITIONS, which is worth saying because the obvious alternative
 * is to name a point in space for the hand and solve for the arm. That would be IK, and IK
 * needs a reachability answer for every pose at every body scale; these are two numbers per
 * pose that cannot fail. The arm is round and short — Phase 7 already established that it
 * reads without IK — so the cheap thing is also the correct thing here.
 *
 * They are stated as a table rather than a switch so that adding the sixth costs a row.
 */
const POSES: Record<keyof Commanding, { shoulder: number; elbow: number }> = {
    // Hands up under the rising ground, palms turned to it. Past vertical-forward, which is
    // what separates lifting from pointing.
    raise: { shoulder: 118 * DEG, elbow: 42 * DEG },
    // Pressing down: arms forward and low, elbows nearly straight, weight going into it.
    lower: { shoulder: 52 * DEG, elbow: 14 * DEG },
    // Carrying material away — arms extended along the bearing the shove is taking.
    sweep: { shoulder: 84 * DEG, elbow: 26 * DEG },
    // Drawing it back: the same line, but folded in toward the chest.
    draw: { shoulder: 58 * DEG, elbow: 95 * DEG },
    // Riding your own pillar up. Arms down and slightly back, pushing against the ground
    // that is lifting you — the one pose where the hands do NOT lead.
    pedestal: { shoulder: -24 * DEG, elbow: 12 * DEG },
};

/** Order matters only when two are held at once; the first one wins. */
const ORDER: (keyof Commanding)[] = ["pedestal", "raise", "lower", "sweep", "draw"];

export class Gesture implements GesturePose {
    weight = 0;
    shoulder = 0;
    elbow = 0;
    /** Which pose is being blended toward, or null. Read by the overlay and the probe. */
    active: keyof Commanding | null = null;

    private readonly _settings: Settings;
    /** Held between frames so a released gesture relaxes from where it was, not from rest. */
    private _shoulder = 0;
    private _elbow = 0;

    constructor(settings: Settings) {
        this._settings = settings;
    }

    /**
     * One frame of intent. Allocates nothing (Rule 1).
     *
     * THE BLEND IS A RATE, NOT A SWITCH, and both directions matter. Snapping to a pose the
     * frame a key goes down is the difference between a body and a mannequin being posed;
     * snapping back on release is worse, because the arms drop into the walk cycle mid-swing
     * and the frame after looks like a dropped puppet. So the weight chases its target and
     * the ANGLES chase theirs — which is what lets one pose become another without passing
     * through the rest pose on the way.
     */
    update(cmd: Commanding, dt: number): void {
        if (!(this._settings.v["sys.gesture"] as boolean)) {
            this.weight = 0;
            this.active = null;
            return;
        }

        let next: keyof Commanding | null = null;
        for (const k of ORDER) {
            if (cmd[k]) {
                next = k;
                break;
            }
        }
        this.active = next;

        // Clamped for the reason every other integrator here clamps: a hitch should slow the
        // gesture, not teleport the arms through the chest.
        const step = Math.min(dt, 1 / 30);
        const rate = this._settings.v["char.gestureBlend"] as number;
        const k = 1 - Math.exp(-rate * step);

        const target = next === null ? null : POSES[next];
        this.weight += ((next === null ? 0 : 1) - this.weight) * k;
        if (target !== null) {
            this._shoulder += (target.shoulder - this._shoulder) * k;
            this._elbow += (target.elbow - this._elbow) * k;
        }
        this.shoulder = this._shoulder;
        this.elbow = this._elbow;
    }
}
