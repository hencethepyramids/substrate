// SHARED INCLUDE — substrateAirborne
//
// Reading the airborne buffer: what is in the air above each cell of the substrate
// window. Declarations only, split from the step that writes it for the usual reason.
//
// IT SHARES THE SUBSTRATE'S WINDOW EXACTLY — same origin, same extent, same texel grid,
// same snapping. That is deliberate: material moves between the ground and the air every
// frame, and on a common grid that exchange is texel-to-texel with no resampling and no
// chance of the two disagreeing about where a cell is. Requires <substrateBuffer> for
// the window uniforms.

var sbAirborneTexSampler: sampler;
var sbAirborneTex: texture_2d<f32>;

struct SbAirborne {
    /// Material currently in the air over this cell, in metres of settled depth
    /// equivalent. This is the same unit the substrate's mass channel uses, so the two
    /// can be added without a conversion factor to get wrong.
    density: f32,
    /// Surface change owed to the ground next step: positive deposited, negative lifted.
    /// Written here rather than applied directly, so the ground stays the only thing
    /// that edits the ground.
    exchange: f32,
};

fn sbAirborneTexel(c: vec2i) -> vec4f {
    let m = i32(uniforms.sbSubSize) - 1;
    return textureLoad(sbAirborneTex, clamp(c, vec2i(0, 0), vec2i(m, m)), 0);
}

/// The air's load at a world XZ. Plain bilinear: nothing takes a gradient of this, so
/// the four-wide stencil substrateBuffer needs would be paying for nothing.
fn sbAirborneAt(worldXZ: vec2f) -> SbAirborne {
    let t = (worldXZ - uniforms.sbSubOrigin) / uniforms.sbSubExtent * uniforms.sbSubSize - 0.5;
    let i = floor(t);
    let f = t - i;
    let c = vec2i(i);

    let v00 = sbAirborneTexel(c + vec2i(0, 0));
    let v10 = sbAirborneTexel(c + vec2i(1, 0));
    let v01 = sbAirborneTexel(c + vec2i(0, 1));
    let v11 = sbAirborneTexel(c + vec2i(1, 1));
    let v = mix(mix(v00, v10, f.x), mix(v01, v11, f.x), f.y) * sbSubWindow(worldXZ);

    var a: SbAirborne;
    a.density = v.r;
    a.exchange = v.g;
    return a;
}
