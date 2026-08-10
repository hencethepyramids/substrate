// The last pass: sharpening and grain, both of which belong AFTER the display transform.
//
// WHY THIS IS A SEPARATE PASS FROM THE COMPOSITE, and why the vignette is not in it.
// Phase 9 has been sorting effects by where they physically happen, and these three land
// in two different places:
//
//   Vignette is a LENS effect. Less light reaches the corner of the sensor than the
//   centre, so it scales radiance, and it has to happen before the curve — in the
//   composite. Put it after and you are darkening a display value, which is a different
//   and wrong number, and it stops interacting with the tonemap's shoulder the way real
//   falloff does.
//
//   Sharpening and grain are SENSOR AND OUTPUT effects. Film grain lives in density, not
//   in radiance: it is silver halide crystals, and it is most visible in the midtones
//   because that is where the response curve is steepest. Sharpening is an output-side
//   correction for a display, applied to the image a viewer actually sees. Both belong
//   after the transform, which means after the composite, which means here.
//
// So this pass reads display-referred colour in 0..1 and hands back the same.

varying vUV: vec2f;
var textureSamplerSampler: sampler;
var textureSampler: texture_2d<f32>;

/// x: sharpen strength 0..1. y: grain strength. z: the grain's frame index. w: unused.
uniform fnParams: vec4f;

/// This pass's own texel — the sharpen kernel's reach and the grain's pixel index.
uniform fnTexel: vec2f;

fn tap(uv: vec2f, dx: f32, dy: f32) -> vec3f {
    return textureSample(textureSampler, textureSamplerSampler, uv + vec2f(dx, dy) * uniforms.fnTexel).rgb;
}

/// Integer hash. Not `fract(sin(x) * k)` — see lib/shadow.wgsl for the afternoon that
/// idiom cost, and note that grain is exactly the kind of thing where a hash going
/// chaotic on the last bit would never be noticed until it broke a pixel diff.
fn fnHash(x: u32, y: u32, z: u32) -> f32 {
    var h = (x * 0x9e3779b9u) ^ (y * 0x85ebca6bu) ^ (z * 0xc2b2ae35u);
    h ^= h >> 15u;
    h *= 0x2c1b3c6du;
    h ^= h >> 12u;
    h ^= h >> 16u;
    return f32(h & 0xffffffu) * (1.0 / 16777216.0);
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let uv = input.vUV;
    var rgb = tap(uv, 0.0, 0.0);

    // CONTRAST-ADAPTIVE SHARPENING, in the shape AMD published it. The adaptive part is
    // the whole reason to use it rather than an unsharp mask: the amplification is scaled
    // by how much headroom the neighbourhood has left, so flat sky gets sharpened hard
    // (there is nothing to ring) and an already high-contrast edge gets sharpened barely
    // (ringing there is exactly the halo that makes sharpening look cheap). A snow field
    // under a low sun is mostly the first case and every silhouette is the second, so the
    // distinction is not academic here.
    if (uniforms.fnParams.x > 0.0) {
        let n = tap(uv, 0.0, -1.0);
        let w = tap(uv, -1.0, 0.0);
        let e = tap(uv, 1.0, 0.0);
        let s = tap(uv, 0.0, 1.0);
        let mn = min(min(min(n, w), min(e, s)), rgb);
        let mx = max(max(max(n, w), max(e, s)), rgb);
        // How far the darkest neighbour is from black against how far the brightest is
        // from white — whichever is tighter is the headroom.
        let headroom = min(mn, vec3f(1.0) - mx) / max(mx, vec3f(1.0e-5));
        let amp = sqrt(clamp(headroom, vec3f(0.0), vec3f(1.0)));
        // Negative: the neighbours are subtracted. 1/8 at full strength is the strongest
        // the kernel stays stable at, since the divisor below is 1 + 4w.
        let k = -amp * (uniforms.fnParams.x * 0.125);
        rgb = (rgb + (n + w + e + s) * k) / (vec3f(1.0) + 4.0 * k);
    }

    // GRAIN, AND WHY IT IS MONOCHROME AND MIDTONE-WEIGHTED. Film grain is a variation in
    // how many crystals developed, not in their colour, so per-channel noise reads as
    // digital chroma noise rather than film. And it vanishes in both the toe and the
    // shoulder: clipped black has no crystals to vary and clipped white has them all
    // developed. `4L(1-L)` is that arch, peaking in the midtones and zero at either end.
    //
    // The frame index comes from the SIMULATION clock, not from a frame counter, which
    // means grain stops when the simulation is paused. That is deliberate: every A/B in
    // this phase is measured on a paused frame, and grain driven by wall time would make
    // two captures of an identical build differ — destroying the one instrument that has
    // caught every real bug in Phase 9.
    if (uniforms.fnParams.y > 0.0) {
        let px = uv / uniforms.fnTexel;
        let noise = fnHash(u32(px.x), u32(px.y), u32(uniforms.fnParams.z)) * 2.0 - 1.0;
        let luma = dot(rgb, vec3f(0.2126, 0.7152, 0.0722));
        let response = 4.0 * luma * (1.0 - luma);
        rgb = rgb + noise * (uniforms.fnParams.y * 0.03 * response);
    }

    fragmentOutputs.color = vec4f(clamp(rgb, vec3f(0.0), vec3f(1.0)), 1.0);
}
