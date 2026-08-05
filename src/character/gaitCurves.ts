/**
 * Sagittal joint angles over a normalised gait cycle, from clinical gait analysis.
 *
 * WHY THIS FILE EXISTS. Everything else in the gait is derived — the bob is the sagitta of
 * a triangle, the bank is v*omega/g, the stride cap is leg geometry. That worked for the
 * things that ARE geometry and failed for the one thing that is not: what a leg looks like
 * while it swings. "Looks like a person walking" does not fall out of leg lengths. It is a
 * shape, and the shape has been measured to death by people with force plates.
 *
 * So the swing comes from measurement rather than from me. These are the standard
 * sagittal-plane kinematics of normal human walking, sampled at ten points across the
 * cycle, with 0 at heel strike and stance running to about 60%.
 *
 * Essentially nobody ships a fully procedural human walk cycle that looks right; real
 * productions blend captured or authored clips and IK the feet onto the ground afterwards.
 * This is that, minus the asset: a table of numbers, and the IK the project already had.
 *
 * SIGN CONVENTIONS, all degrees:
 *   hip   — positive is flexion, thigh forward of vertical.
 *   knee  — positive is flexion, shin folded back under the thigh. Never negative; a knee
 *           does not bend the other way.
 */

/** Samples per curve. Evenly spaced over the cycle, wrapping at the end. */
const N = 10;

/**
 * Hip flexion through the cycle. Peaks just before heel strike as the leg reaches
 * forward, and passes through its extension minimum around 50% as the body travels over
 * the planted foot.
 */
const HIP_WALK = [30, 22, 12, 2, -8, -10, 0, 18, 32, 34];

/**
 * Knee flexion. Two humps, and the small one matters as much as the big one: the loading
 * response around 15% is the knee yielding as weight arrives on it, and a leg without it
 * reads as a stilt however good the rest is. The large peak near 70% is the swing tuck.
 */
const KNEE_WALK = [5, 16, 12, 4, 6, 22, 48, 62, 40, 12];

/** Running is the same shape with more of it — a deeper tuck and a longer reach. */
const HIP_RUN = [42, 30, 14, -2, -16, -18, 4, 30, 48, 50];
const KNEE_RUN = [22, 38, 28, 14, 18, 55, 88, 105, 70, 32];

const DEG = Math.PI / 180;

/** Catmull-Rom through the samples, wrapped — the curve is a loop, not a line. */
function sampleLoop(table: number[], t: number): number {
    const x = (t - Math.floor(t)) * N;
    const i = Math.floor(x);
    const f = x - i;
    const p0 = table[(i - 1 + N) % N];
    const p1 = table[i % N];
    const p2 = table[(i + 1) % N];
    const p3 = table[(i + 2) % N];
    // Catmull-Rom, so the joint does not corner at every sample. A gait with kinks in it
    // reads as a puppet even when the poses either side are correct.
    return 0.5 * (2 * p1 + (p2 - p0) * f + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f * f + (-p0 + 3 * p1 - 3 * p2 + p3) * f * f * f);
}

export interface LegPose {
    /** Radians, flexion positive. */
    hip: number;
    knee: number;
}

/**
 * The measured pose at a point in the cycle.
 *
 * @param t 0..1 through the foot's own cycle, 0 at contact.
 * @param run 0 walking, 1 running.
 */
export function legPoseAt(t: number, run: number, out: LegPose): void {
    out.hip = (sampleLoop(HIP_WALK, t) + (sampleLoop(HIP_RUN, t) - sampleLoop(HIP_WALK, t)) * run) * DEG;
    // Clamped at zero because the interpolation can undershoot between samples and a knee
    // bending backwards is the single most obviously wrong thing a leg can do.
    out.knee = Math.max(sampleLoop(KNEE_WALK, t) + (sampleLoop(KNEE_RUN, t) - sampleLoop(KNEE_WALK, t)) * run, 0) * DEG;
}
