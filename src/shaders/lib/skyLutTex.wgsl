// SHARED INCLUDE — substrateSkyLut
//
// The baked sky-view LUT and the one function that reads it. Requires
// <substrateSkyMap> for the direction mapping.
//
// rgb is in-scattered radiance for the direction. a is the distance in km to the
// ground hit along that ray, or 0 if the ray leaves the atmosphere — which is what
// lets a consumer add the bounced ground back in, correctly hazed, without a second
// raymarch. Filtering across the horizon mixes a 0 with a very large number, and
// very large is exactly where the transmittance for it goes to zero, so the seam
// costs nothing.

var sbSkyLutSampler: sampler;
var sbSkyLut: texture_2d<f32>;

fn sbSkyRaw(dir: vec3f) -> vec4f {
    // textureSampleLevel, not textureSample, and the difference is about WHERE this may be
    // called from. The LUT has no mip chain, so the two are identical in result — but
    // textureSample computes derivatives and WGSL therefore forbids it outside uniform
    // control flow. The reflection pass reads the sky after an early-out that branches on a
    // depth value, which is not uniform, and the shader simply fails to parse. Asking for
    // level 0 explicitly costs nothing and lets any caller use it.
    return textureSampleLevel(sbSkyLut, sbSkyLutSampler, sbSkyUvFromDir(dir), 0.0);
}
