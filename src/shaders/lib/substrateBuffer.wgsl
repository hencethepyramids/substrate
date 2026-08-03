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

/// Catmull-Rom basis over four taps at -1, 0, 1, 2, and its derivative.
///
/// Sum of the weights is 1 and sum of the derivative weights is 0, at every t. At t = 0
/// the weights collapse to (0,1,0,0), so it passes exactly through the samples, and the
/// derivative weights become (-0.5, 0, 0.5, 0) — the plain central difference. At t = 1
/// they become the central difference at the NEXT node, which is what makes the
/// derivative continuous across a cell boundary without ever being zero there.
fn sbCubic(t: f32) -> vec4f {
    let t2 = t * t;
    let t3 = t2 * t;
    return vec4f(-0.5 * t3 + t2 - 0.5 * t, 1.5 * t3 - 2.5 * t2 + 1.0, -1.5 * t3 + 2.0 * t2 + 0.5 * t, 0.5 * t3 - 0.5 * t2);
}

fn sbCubicD(t: f32) -> vec4f {
    let t2 = t * t;
    return vec4f(-1.5 * t2 + 2.0 * t - 0.5, 4.5 * t2 - 5.0 * t, -4.5 * t2 + 4.0 * t + 0.5, 1.5 * t2 - t);
}

struct SbSubRow {
    /// All four channels, weighted along x.
    v: vec4f,
    /// The depression channel weighted by the DERIVATIVE along x.
    dr: f32,
};

/// One row of the 4x4 footprint, weighted both ways from a single set of four loads.
fn sbSubRow(c: vec2i, row: i32, wx: vec4f, dx: vec4f) -> SbSubRow {
    let t0 = sbSubTexel(c + vec2i(-1, row));
    let t1 = sbSubTexel(c + vec2i(0, row));
    let t2 = sbSubTexel(c + vec2i(1, row));
    let t3 = sbSubTexel(c + vec2i(2, row));
    var r: SbSubRow;
    r.v = t0 * wx.x + t1 * wx.y + t2 * wx.z + t3 * wx.w;
    r.dr = t0.r * dx.x + t1.r * dx.y + t2.r * dx.z + t3.r * dx.w;
    return r;
}

/// The substrate at a world XZ, and the slope of it.
///
/// Explicit interpolation over textureLoad, for the same two reasons
/// substrateTerrainField does it: no dependence on the float32-filterable feature, and
/// it is reproducible on the CPU, which is what will let Phase 7's per-foot contact be
/// exact rather than close.
///
/// CATMULL-ROM, AND IT HAS TO BE A FOUR-WIDE STENCIL. This is not a preference.
///
/// A gradient taken from plain bilinear is constant inside a texel and jumps at the
/// boundary: a footprint becomes a grid of flat facets with hard seams. The obvious
/// repair — smoothstep weights, u = f*f*(3-2f) — is worse, because du/df = 6f(1-f) is
/// ZERO AT EVERY NODE. The normal then flattens on a lattice and peaks between, which
/// reads as the same grid with softer edges. Measured on hardware; it was obvious.
///
/// And no 2x2 filter can avoid it. Matching the derivative across a cell boundary needs
/// w'(1)*(v1-v0) = w'(0)*(v2-v1) for arbitrary samples, which forces w'(0) = w'(1) = 0.
/// Any four-texel filter smooth enough to hide its seams has lattice-locked zeros in its
/// derivative, so the stencil has to get wider. Catmull-Rom interpolates its samples
/// exactly, is C1, and its derivative reduces to the central difference at every node —
/// continuous, and never zero for the wrong reason.
///
/// Sixteen loads, but only inside the window. See the early out.
fn sbSubstrateAt(worldXZ: vec2f) -> SbSubstrate {
    var s: SbSubstrate;
    s.depression = 0.0;
    s.mass = 0.0;
    s.compaction = 0.0;
    s.phase = 0.0;
    s.slope = vec2f(0.0, 0.0);

    // MOST OF THE SCREEN IS OUTSIDE THE WINDOW. The buffer covers 32 m and the clipmap
    // draws to 870, so the common case is sixteen texture loads for a guaranteed zero.
    // Spend a compare instead — the branch is screen-space coherent, so it costs a
    // fraction of what it saves.
    let w = sbSubWindow(worldXZ);
    if (w <= 0.0) {
        return s;
    }

    let texelsPerMetre = uniforms.sbSubSize / uniforms.sbSubExtent;
    let t = (worldXZ - uniforms.sbSubOrigin) * texelsPerMetre - 0.5;
    let i = floor(t);
    let f = t - i;
    let c = vec2i(i);

    let wx = sbCubic(f.x);
    let dwx = sbCubicD(f.x);
    let wy = sbCubic(f.y);
    let dwy = sbCubicD(f.y);

    let r0 = sbSubRow(c, -1, wx, dwx);
    let r1 = sbSubRow(c, 0, wx, dwx);
    let r2 = sbSubRow(c, 1, wx, dwx);
    let r3 = sbSubRow(c, 2, wx, dwx);

    let v = (r0.v * wy.x + r1.v * wy.y + r2.v * wy.z + r3.v * wy.w) * w;
    s.depression = v.r;
    s.mass = v.g;
    s.compaction = v.b;
    s.phase = v.a;

    // Out of texel space into metres. The window's own ramp is not differentiated: it
    // only bites in the last 8 texels, where the buffer holds nothing worth taking a
    // normal from anyway.
    let gx = r0.dr * wy.x + r1.dr * wy.y + r2.dr * wy.z + r3.dr * wy.w;
    let gz = r0.v.r * dwy.x + r1.v.r * dwy.y + r2.v.r * dwy.z + r3.v.r * dwy.w;
    s.slope = vec2f(gx, gz) * texelsPerMetre * w;
    return s;
}
