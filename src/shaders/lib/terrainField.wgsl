// SHARED INCLUDE — substrateTerrainField
//
// RULE 4 LIVES HERE. This is the single definition of "where is the ground".
// The beauty pass includes it, and every shadow cascade in Phase 2 will include
// this same file. There is no second copy. The most common way a project like this
// fails is terrain displacement in the beauty pass disagreeing by a few centimetres
// with displacement in the shadow map, which reads as terrain shadowing itself in
// thin stripes and is nearly impossible to diagnose after the fact.
//
// The CPU mirror in terrain/heightfield.ts reproduces sbSampleField exactly, so
// character grounding stands on the surface that is actually drawn.

var sbFieldTexSampler: sampler;
var sbFieldTex: texture_2d<f32>;

uniform sbFieldOrigin: vec2f;
uniform sbFieldExtent: f32;
uniform sbFieldSize: f32;
uniform sbHeightScale: f32;

// Requires <substratePack> for sbUnpackDeriv.

fn sbFieldTexel(c: vec2i) -> vec3f {
    let m = i32(uniforms.sbFieldSize) - 1;
    let t = textureLoad(sbFieldTex, clamp(c, vec2i(0, 0), vec2i(m, m)), 0);
    return vec3f(t.r, sbUnpackDeriv(t.g));
}

/// Height in metres and analytic derivative at a world XZ.
///
/// Explicit bilinear over textureLoad rather than a filtered sample. Two reasons:
/// it removes any dependence on the float32-filterable feature, and it is
/// reproducible on the CPU, which is what lets grounding be exact rather than close.
fn sbSampleField(worldXZ: vec2f) -> vec3f {
    let size = uniforms.sbFieldSize;
    let t = (worldXZ - uniforms.sbFieldOrigin) / uniforms.sbFieldExtent * size - 0.5;
    let i = floor(t);
    let f = t - i;
    let c = vec2i(i);

    let h00 = sbFieldTexel(c + vec2i(0, 0));
    let h10 = sbFieldTexel(c + vec2i(1, 0));
    let h01 = sbFieldTexel(c + vec2i(0, 1));
    let h11 = sbFieldTexel(c + vec2i(1, 1));

    let v = mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
    return v * uniforms.sbHeightScale;
}

/// Surface normal from the analytic derivative. Height scale steepens slopes, so it
/// has to be applied to the derivative too or the shading detaches from the geometry.
fn sbFieldNormal(deriv: vec2f) -> vec3f {
    return normalize(vec3f(-deriv.x, 1.0, -deriv.y));
}
