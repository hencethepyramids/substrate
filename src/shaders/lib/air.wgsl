// SHARED INCLUDE — substrateAir
//
// Where the wind goes. Phase 5's velocity field, and it is deliberately NOT a buffer.
//
// Air over a heightfield is a pure function of the heightfield and the free-stream wind,
// so storing it would mean keeping a second copy of something already known, kept in
// sync by hand, at a resolution someone has to choose. Evaluating it costs a dot product
// and a smoothstep. The airborne MATERIAL in pass B is different — that carries history
// and does need a buffer.
//
// Declares no textures, so anything may include it. Takes the terrain derivative as an
// argument rather than sampling the field itself, which is what keeps it that way.
// Requires <substrateNoise> for sbNoiseD.

/// Free-stream wind velocity in m/s. Direction is where the wind is going.
uniform swBase: vec2f;
/// x: speed-up gain over a windward slope, y: lee slope at which flow separates,
/// z: gust frequency in cycles per metre, w: gust amount 0..1.
uniform swParams: vec4f;
/// Seconds. Gusts advect downwind rather than pulsing in place.
uniform swTime: f32;

/// How much of the free stream survives inside a separation bubble, reversed.
const SB_AIR_RECIRC: f32 = 0.22;

struct SbAir {
    /// Full velocity in m/s. The vertical component follows the surface.
    velocity: vec3f,
    /// Surface shear RELATIVE to the free stream, so about 1 on flat ground. Good for
    /// asking "is this face scoured or sheltered", useless for asking "is the wind
    /// strong enough to pick anything up" — it is a ratio, and it does not know how hard
    /// the wind is blowing.
    shear: f32,
    /// Horizontal speed in m/s. THIS is what lifts material, because a threshold has to
    /// be compared against a speed and not against a ratio.
    speed: f32,
    /// 0 attached, 1 fully separated.
    separated: f32,
};

/// The air at a world XZ, given the terrain derivative there.
///
/// Three things happen to wind crossing a dune, and all three come out of one dot
/// product with the slope:
///
///   it ACCELERATES up the windward face, because the streamlines compress against the
///   rising ground — which is why the stoss side is stripped and the trough is not;
///
///   it SEPARATES past the crest, once the lee is steep enough that the flow cannot stay
///   attached, leaving a recirculating bubble where the near-surface air runs backwards
///   — which is why a slip face is where material lands and stays rather than being
///   carried onward, and therefore why dunes migrate at all;
///
///   and it FOLLOWS the surface, which fixes the vertical component exactly with no
///   free parameter: w = horizontal . grad(h) is the kinematic boundary condition.
fn sbAirAt(worldXZ: vec2f, deriv: vec2f) -> SbAir {
    let speed = length(uniforms.swBase);
    var dir = vec2f(0.0, 1.0);
    if (speed > 1.0e-4) {
        dir = uniforms.swBase / speed;
    }

    // Gusts ride downwind with the air rather than pulsing in place, so a lull travels
    // across the field the way a real one does.
    let drift = worldXZ - dir * (uniforms.swTime * speed * 0.35);
    let gust = 1.0 + uniforms.swParams.w * sbNoiseD(drift * uniforms.swParams.z).x;

    // Slope along the wind. Positive is uphill.
    let along = dot(deriv, dir);

    let speedup = max(1.0 + uniforms.swParams.x * along, 0.0);

    // Separation begins at HALF the threshold slope and is complete at it, rather than
    // ramping all the way from flat. A gently sloping lee does not detach — the flow
    // stays glued to it — and starting the ramp at zero marked every downwind face in
    // the world as a recirculation bubble, which is most of the terrain.
    let brink = max(uniforms.swParams.y, 1.0e-3);
    let sep = smoothstep(-brink * 0.5, -brink, along);

    // Attached flow over the crest, and a weak reversed flow in the bubble behind it.
    let attached = dir * (speed * speedup * gust * (1.0 - sep));
    let reversed = dir * (-speed * SB_AIR_RECIRC * sep);
    let horizontal = attached + reversed;

    var air: SbAir;
    air.velocity = vec3f(horizontal.x, dot(horizontal, deriv), horizontal.y);
    air.shear = speedup * gust * (1.0 - sep);
    air.speed = length(horizontal);
    air.separated = sep;
    return air;
}
