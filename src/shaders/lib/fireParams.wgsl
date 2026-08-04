// SHARED INCLUDE — substrateFireParams
//
// The element's heat block. Five numbers, and between them the whole difference between
// snow melting, sand refusing to, and rock going molten and setting into crust.
//
// Split from the buffer declarations for the reason that keeps recurring: an include
// that declares a texture obliges every shader including it to bind that texture, and
// the relaxation pass wants these numbers without wanting the buffer.

uniform fpIgnition: f32;
uniform fpConductivity: f32;
uniform fpCooling: f32;
uniform fpLatent: f32;
uniform fpPhaseLag: f32;

/// How far through its phase change the material is at this heat.
///
/// The ramp is `latent` wide rather than instantaneous, and that width is the whole
/// point: a material with a large latent heat sits part-way through the transition over
/// a broad band of heat instead of flipping. Snow's 0.8 is why a snowfield holds at
/// melting point rather than vanishing the moment it is warmed.
fn fpPhaseTarget(heat: f32) -> f32 {
    return smoothstep(uniforms.fpIgnition, uniforms.fpIgnition + max(uniforms.fpLatent, 1.0e-3), heat);
}
