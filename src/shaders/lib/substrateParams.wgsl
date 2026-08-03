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
// Only the fields Phase 3 actually consumes are declared. windSusceptibility and
// liftThreshold belong to the Phase 5 air coupling and are deliberately absent — a
// uniform nothing reads still costs a slot in the UBO, and the shader check flags it.

uniform spCohesion: f32;
uniform spReposeDeg: f32;
uniform spSlumpAnisotropy: f32;
uniform spDiffusionRate: f32;
uniform spDecayHalfLife: f32;
uniform spThermalCoupling: f32;

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

/// The slope the material holds, as a tangent.
///
/// angleOfRepose is what a cohesionless heap of it stands at; cohesion carries it the
/// rest of the way toward vertical. That single line is the whole difference between a
/// boot print in snow and one in dry sand. Snow's 0.82 over 38 degrees gives about 78,
/// sand's 0.02 over 34 gives 35, and ash sits just over its own 30.
fn spTanRepose(compaction: f32, phase: f32) -> f32 {
    let angle = mix(uniforms.spReposeDeg, SP_MAX_ANGLE, spCohesionAt(compaction, phase));
    return tan(clamp(angle, 1.0, SP_MAX_ANGLE) * SP_DEG2RAD);
}
