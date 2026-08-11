// SHARED INCLUDE — substrateParams
//
// The element's substrate block, as uniforms, plus the two derived quantities every
// consumer of it has to agree on: how cohesive the material is right now, and the
// slope it will therefore hold.
//
// These numbers are the entire difference between snow, sand and ash at the
// simulation level. There is no branch on biome below and there must never be one:
// if an element cannot be expressed here, the shared system is wrong, not the element.
//
// The last two arrived with Phase 5 and are the element's coupling to the air. The
// relaxation pass declares them without reading them, which the shader check will say
// so about — that is the honest trade for keeping ONE parameter block rather than
// splitting the element in half to dodge two warnings.

uniform spCohesion: f32;
uniform spReposeDeg: f32;
uniform spSlumpAnisotropy: f32;
uniform spDiffusionRate: f32;
uniform spDecayHalfLife: f32;
uniform spThermalCoupling: f32;
/// How strongly this material couples to the air field. 0..1
uniform spWindSusceptibility: f32;
/// Loose depth above which material starts leaving the ground, in metres.
uniform spLiftThreshold: f32;

const SP_DEG2RAD: f32 = 0.017453292;

/// The steepest face any material is allowed to hold. Not 90: tan blows up there, and
/// a cliff standing at exactly vertical is a numerical accident rather than a look.
const SP_MAX_ANGLE: f32 = 87.0;

/// How much fully packed material adds to its own cohesion. Packed snow holds a
/// steeper wall than the loose snow it was made from, and this is the size of that.
const SP_PACK_COHESION: f32 = 0.3;

/// How cohesive this material is right now: its own cohesion, raised by compaction and
/// lowered by heat.
///
/// The phase channel is zero everywhere until Phase 6 drives it, so the thermal term is
/// inert today. Wiring it here rather than in Phase 6 means Phase 6 only has to WRITE
/// the channel, and cannot introduce a second opinion about what heat does to a
/// material — which is exactly how a "shared" system quietly stops being one.
fn spCohesionAt(compaction: f32, phase: f32) -> f32 {
    return clamp(uniforms.spCohesion + compaction * SP_PACK_COHESION - phase * uniforms.spThermalCoupling, 0.0, 1.0);
}

/// Metres of standing face a material holds per unit of cohesion.
///
/// COHESION USED TO MAKE MATERIAL INFINITELY STRONG. spCohesionAt carries the repose angle
/// toward vertical and says nothing about how much is stacked on top, so snow's 0.82 held a
/// face at 78 degrees whether it was one metre tall or thirty. A player could pile a tower
/// to the buffer's own ceiling and it stood there.
///
/// Real cohesive ground has a critical height for a vertical cut — soil mechanics puts it at
/// roughly 4c/gamma, proportional to how well the stuff sticks together and inversely to what
/// it weighs. Past it the face fails under its own weight no matter how cohesive it is. This
/// is that constant of proportionality, and it is what turns "cohesion" from a licence into a
/// budget: snow's 0.82 buys about 2.1 m of standing face, sand's 0.02 buys five centimetres,
/// which is why sand has never needed this rule and snow always did.
const SP_CRIT_PER_COHESION: f32 = 2.6;

/// How cohesive the material still is with `proud` metres of pile standing on it.
///
/// FULL STRENGTH UP TO THE CRITICAL HEIGHT, then gone over the next half of it. A falloff
/// that began at zero would quietly weaken every print and berm in the world — every result
/// measured before this rule existed was measured on material below its critical height, and
/// they should all still hold. What changes is only what happens ABOVE it, which is the case
/// nobody could previously reach.
fn spCohesionUnder(compaction: f32, phase: f32, proud: f32) -> f32 {
    let c = spCohesionAt(compaction, phase);
    let critical = max(c * SP_CRIT_PER_COHESION, 1e-3);
    return c * (1.0 - smoothstep(critical, critical * 1.5, proud));
}

/// The slope the material holds, as a tangent.
///
/// angleOfRepose is what a cohesionless heap of it stands at; cohesion carries it the
/// rest of the way toward vertical. That single line is the whole difference between a
/// boot print in snow and one in dry sand. Snow's 0.82 over 38 degrees gives about 78,
/// sand's 0.02 over 34 gives 35, and ash sits just over its own 30.
/// `proud` is how far the material stands above the undisturbed field — the load its own
/// cohesion has to carry. Below the critical height this is exactly what it always was.
fn spTanRepose(compaction: f32, phase: f32, proud: f32) -> f32 {
    let angle = mix(uniforms.spReposeDeg, SP_MAX_ANGLE, spCohesionUnder(compaction, phase, proud));
    return tan(clamp(angle, 1.0, SP_MAX_ANGLE) * SP_DEG2RAD);
}
