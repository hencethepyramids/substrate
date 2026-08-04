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
    /// Smoke over this cell, same units. Rides the same wind and the same advection as
    /// the material beside it, because it IS material — just hot enough to leave.
    smoke: f32,
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
    a.smoke = v.b;
    return a;
}

/// How much smoke sits between the eye and a point, as an optical depth.
///
/// The buffer is a column density on a flat grid, so there is no height to march
/// through — what there is instead is the ground track of the view ray, and how much
/// smoke sits along it. Marching that track is what makes a plume actually OBSCURE the
/// ground behind it rather than merely tinting the cell it is standing on.
///
/// Samples are spaced along the ray's XZ projection, so a glancing view through a plume
/// accumulates far more than a view straight down onto it — which is the behaviour that
/// makes smoke read as a volume rather than as a decal.
fn sbSmokeDepth(cameraXZ: vec2f, worldXZ: vec2f, taps: i32) -> f32 {
    let step = (worldXZ - cameraXZ) / f32(taps);
    let len = length(step);
    var acc = 0.0;
    for (var i = 0; i < taps; i++) {
        // Offset by half a step so the march samples cell centres rather than its own
        // endpoints, which would double-count the pixel and miss the camera.
        acc += sbAirborneAt(cameraXZ + step * (f32(i) + 0.5)).smoke;
    }
    return acc * len;
}
