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
};

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

/// The substrate at a world XZ.
///
/// Explicit bilinear over textureLoad, for the same two reasons substrateTerrainField
/// does it: no dependence on the float32-filterable feature, and it is reproducible on
/// the CPU, which is what will let Phase 7's per-foot contact be exact rather than
/// close.
fn sbSubstrateAt(worldXZ: vec2f) -> SbSubstrate {
    let t = (worldXZ - uniforms.sbSubOrigin) / uniforms.sbSubExtent * uniforms.sbSubSize - 0.5;
    let i = floor(t);
    let f = t - i;
    let c = vec2i(i);

    let v00 = sbSubTexel(c + vec2i(0, 0));
    let v10 = sbSubTexel(c + vec2i(1, 0));
    let v01 = sbSubTexel(c + vec2i(0, 1));
    let v11 = sbSubTexel(c + vec2i(1, 1));

    let v = mix(mix(v00, v10, f.x), mix(v01, v11, f.x), f.y) * sbSubWindow(worldXZ);

    var s: SbSubstrate;
    s.depression = v.r;
    s.mass = v.g;
    s.compaction = v.b;
    s.phase = v.a;
    return s;
}
