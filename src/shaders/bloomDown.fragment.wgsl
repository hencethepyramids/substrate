// One step down the bloom pyramid.
//
// The 13-tap kernel from Sledgehammer's Advanced Warfare talk, not a box and not a
// bilinear halving. Both of those alias, and aliasing in a bloom pyramid is not a
// cosmetic problem: a highlight that lands on a different texel each frame becomes a
// blob that pops in and out, and at this project's exposures — a snow glitter path runs
// about twenty times over white — the blob is the brightest thing on screen.
//
// The taps are four bilinear fetches at the corners of the destination texel, four at its
// edge midpoints offset by a full source texel, and a centre group. Weighted 0.5 / 0.125
// / 0.125 / 0.125 / 0.125, which sums to one, so the pyramid neither gains nor loses
// energy on the way down.

varying vUV: vec2f;
var textureSamplerSampler: sampler;
var textureSampler: texture_2d<f32>;

/// One texel of the SOURCE, not the destination. Getting this backwards halves the
/// kernel's reach and the bloom quietly stops being wide.
uniform bmTexel: vec2f;

/// 1 on the first level, 0 below it. See the Karis note in main.
uniform bmKaris: f32;

fn tap(uv: vec2f, dx: f32, dy: f32) -> vec3f {
    return textureSample(textureSampler, textureSamplerSampler, uv + vec2f(dx, dy) * uniforms.bmTexel).rgb;
}

/// Karis's weight: the reciprocal of a colour's luminance, so a group of taps averages
/// toward its dimmer members.
fn karisWeight(c: vec3f) -> f32 {
    return 1.0 / (1.0 + dot(c, vec3f(0.2126, 0.7152, 0.0722)));
}

/// Average four taps, optionally weighted so one runaway sample cannot dominate.
fn group(a: vec3f, b: vec3f, c: vec3f, d: vec3f) -> vec3f {
    let plain = (a + b + c + d) * 0.25;
    let wa = karisWeight(a);
    let wb = karisWeight(b);
    let wc = karisWeight(c);
    let wd = karisWeight(d);
    let weighted = (a * wa + b * wb + c * wc + d * wd) / max(wa + wb + wc + wd, 1e-6);
    return mix(plain, weighted, uniforms.bmKaris);
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let uv = input.vUV;

    // Corners of the destination texel.
    let a = tap(uv, -2.0, 2.0);
    let b = tap(uv, 0.0, 2.0);
    let c = tap(uv, 2.0, 2.0);
    let d = tap(uv, -2.0, 0.0);
    let e = tap(uv, 0.0, 0.0);
    let f = tap(uv, 2.0, 0.0);
    let g = tap(uv, -2.0, -2.0);
    let h = tap(uv, 0.0, -2.0);
    let i = tap(uv, 2.0, -2.0);
    // The inner quad, offset by half a source texel so it samples between the outer ones.
    let j = tap(uv, -1.0, 1.0);
    let k = tap(uv, 1.0, 1.0);
    let l = tap(uv, -1.0, -1.0);
    let m = tap(uv, 1.0, -1.0);

    // THE KARIS AVERAGE, AND WHY IT IS ONLY ON THE TOP LEVEL. A single pixel of specular
    // glitter can be a hundred times its neighbours. Averaged plainly it survives every
    // downsample and comes back up as a hard dot with a halo, flickering as the sun or
    // the camera moves by a fraction of a texel. Weighting each group by 1/(1+luma)
    // before averaging pulls that spike back toward its neighbourhood. It is not energy
    // conserving, which is exactly why it runs on the first downsample only: below level
    // one the fireflies are already gone and the pyramid should carry light honestly.
    var result = group(j, k, l, m) * 0.5;
    result = result + group(a, b, d, e) * 0.125;
    result = result + group(b, c, e, f) * 0.125;
    result = result + group(d, e, g, h) * 0.125;
    result = result + group(e, f, h, i) * 0.125;

    fragmentOutputs.color = vec4f(result, 1.0);
}
