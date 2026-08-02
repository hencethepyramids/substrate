// SHARED INCLUDE — substratePack
//
// Derivative packing, used by the bake pass that writes the field and by every
// pass that reads it. Split out from substrateTerrainField so the bake does not
// have to declare a field texture it never binds.
//
// Derivatives are quantised to 12 bits each over +-8 slope and packed into one f32.
//
// Deliberately not pack2x16float + bitcast: that produces arbitrary bit patterns,
// including denormals and NaNs, and a float32 render target is permitted to flush
// denormals. A 24-bit integer is exactly representable in f32 and survives the round
// trip through the render target, the CPU readback and back with no special cases.

const SB_DERIV_RANGE: f32 = 8.0;

fn sbPackDeriv(d: vec2f) -> f32 {
    let q = floor(clamp(d / SB_DERIV_RANGE, vec2f(-1.0), vec2f(1.0)) * 2047.0 + 2048.5);
    return q.x * 4096.0 + q.y;
}

fn sbUnpackDeriv(p: f32) -> vec2f {
    let qx = floor(p * (1.0 / 4096.0));
    let qy = p - qx * 4096.0;
    return (vec2f(qx, qy) - 2048.0) * (SB_DERIV_RANGE / 2047.0);
}
