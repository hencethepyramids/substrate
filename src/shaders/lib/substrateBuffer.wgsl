// SHARED INCLUDE — substrateBuffer
//
// Reading the substrate buffer: the texture declaration, the window it covers, and the
// one function that samples it. Every phase from 4 onward reads the ground through
// this file, the same way every phase reads the terrain through substrateTerrainField.
//
// Split from substrateParams for the mechanical reason that keeps recurring: an
// include which declares a texture obliges every shader including it to BIND that
// texture, and the relaxation pass writes this buffer rather than sampling it.
//
// The window is a camera-following square, snapped to its own texel grid so a frame's
// scroll is a whole number of texels. Outside it the ground is undisturbed.

var sbSubTexSampler: sampler;
var sbSubTex: texture_2d<f32>;

/// World XZ of the window's minimum corner.
uniform sbSubOrigin: vec2f;
/// Metres across the window.
uniform sbSubExtent: f32;
/// Texels across the window.
uniform sbSubSize: f32;
/// Width of the edge ramp, in texels.
uniform sbSubFade: f32;

struct SbSubstrate {
    /// Metres below the undisturbed heightfield. Negative is a heap, not a hollow.
    depression: f32,
    /// Loose, unconsolidated material present here, in metres of it. This is what
    /// slump is allowed to move and what Phase 5 is allowed to lift.
    mass: f32,
    /// 0 loose, 1 fully packed. Packed snow, wet sand, crushed ash.
    compaction: f32,
    /// Phase state, driven by heat in Phase 6.
    phase: f32,
    /// d(depression)/dx and d(depression)/dz, metres per metre. This is what turns a
    /// number in a buffer into something you can see: it bends the surface normal, so a
    /// print catches the light along one edge and loses it along the other.
    ///
    /// It costs no extra texture reads. It is the analytic gradient of the very same
    /// interpolation the value came from, off the very same four texels — so the normal
    /// cannot describe a surface different from the one the depression describes.
    slope: vec2f,
};

/// Full strength close in, gone by the window edge.
///
/// A 24 cm footprint is sub-pixel long before the buffer runs out at 32 m, and a
/// sub-pixel normal perturbation is not detail, it is aliasing. Fading it out where the
/// buffer itself ends means there is one boundary in the picture rather than two.
const SB_RELIEF_NEAR: f32 = 12.0;
const SB_RELIEF_FAR: f32 = 30.0;

fn sbReliefFade(dist: f32) -> f32 {
    return clamp(1.0 - (dist - SB_RELIEF_NEAR) / (SB_RELIEF_FAR - SB_RELIEF_NEAR), 0.0, 1.0);
}

/// 1 well inside the window, ramping to 0 at its edge.
///
/// Everything the buffer holds is multiplied by this. Without it the window boundary
/// is a cliff in whatever the buffer drives, and it moves with the camera — so a
/// hollow the player walks away from would not fade, it would be sheared off.
fn sbSubWindow(worldXZ: vec2f) -> f32 {
    let t = (worldXZ - uniforms.sbSubOrigin) / uniforms.sbSubExtent * uniforms.sbSubSize;
    let edge = min(min(t.x, t.y), min(uniforms.sbSubSize - t.x, uniforms.sbSubSize - t.y));
    return clamp(edge / max(uniforms.sbSubFade, 1e-4), 0.0, 1.0);
}

fn sbSubTexel(c: vec2i) -> vec4f {
    let m = i32(uniforms.sbSubSize) - 1;
    return textureLoad(sbSubTex, clamp(c, vec2i(0, 0), vec2i(m, m)), 0);
}

/// The substrate at a world XZ, and the slope of it.
///
/// Explicit interpolation over textureLoad, for the same two reasons
/// substrateTerrainField does it: no dependence on the float32-filterable feature, and
/// it is reproducible on the CPU, which is what will let Phase 7's per-foot contact be
/// exact rather than close.
///
/// SMOOTHSTEP WEIGHTS, NOT LINEAR ONES. Plain bilinear is C0 — its gradient is constant
/// within a texel and jumps at every boundary. Taking a normal from that turns a
/// footprint into a 6 cm grid of flat facets, and the facets are in world space so they
/// crawl as you walk. u = f*f*(3-2f) is C1, so the gradient is continuous, and
/// du/df = 6f(1-f) is what carries the smoothing into it. Two extra multiplies.
fn sbSubstrateAt(worldXZ: vec2f) -> SbSubstrate {
    let texelsPerMetre = uniforms.sbSubSize / uniforms.sbSubExtent;
    let t = (worldXZ - uniforms.sbSubOrigin) * texelsPerMetre - 0.5;
    let i = floor(t);
    let f = t - i;
    let c = vec2i(i);

    let v00 = sbSubTexel(c + vec2i(0, 0));
    let v10 = sbSubTexel(c + vec2i(1, 0));
    let v01 = sbSubTexel(c + vec2i(0, 1));
    let v11 = sbSubTexel(c + vec2i(1, 1));

    let u = f * f * (3.0 - 2.0 * f);
    let du = 6.0 * f * (1.0 - f);

    let lo = mix(v00, v10, u.x);
    let hi = mix(v01, v11, u.x);
    let w = sbSubWindow(worldXZ);
    let v = mix(lo, hi, u.y) * w;

    var s: SbSubstrate;
    s.depression = v.r;
    s.mass = v.g;
    s.compaction = v.b;
    s.phase = v.a;

    // Chain rule through the interpolation, then out of texel space into metres. The
    // window's own ramp is not differentiated: it only bites in the last 8 texels, where
    // the buffer holds nothing worth taking a normal from anyway.
    let dx = ((v10.r - v00.r) + ((v11.r - v01.r) - (v10.r - v00.r)) * u.y) * du.x;
    let dz = ((v01.r - v00.r) + ((v11.r - v10.r) - (v01.r - v00.r)) * u.x) * du.y;
    s.slope = vec2f(dx, dz) * texelsPerMetre * w;
    return s;
}
