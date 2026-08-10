// The end of the frame: scene-referred radiance in, a pixel out.
//
// THE TONEMAP LIVES HERE NOW, and that move is the whole of Phase 9 pass A. Through
// Phases 1 to 8 every material ran `sbDisplay` itself and wrote a finished pixel, which
// was correct while there was nothing after them. It stops being correct the moment
// anything wants to work on the image: bloom on display-referred values blooms a curve's
// output rather than light, and a highlight that AgX has already rolled off to 0.9 has
// lost exactly the information bloom needs — how much brighter than white it was.
//
// So the materials now write LINEAR RADIANCE into a half-float buffer, the effects work
// in that space, and the curve runs once, here, at the end.

#include<substrateTonemap>

varying vUV: vec2f;
var textureSamplerSampler: sampler;
var textureSampler: texture_2d<f32>;

/// The top of the bloom pyramid, at half resolution. Bound to the scene itself with a
/// weight of zero when bloom is off, so there is one shader rather than two variants.
var cpBloomSampler: sampler;
var cpBloom: texture_2d<f32>;

/// In-scattered sunlight along the view ray. Bound to the scene with a gain of zero when
/// shafts are off, for the same reason as the bloom above.
var cpShaftsSampler: sampler;
var cpShafts: texture_2d<f32>;

/// How much of the frame's light arrives scattered rather than focused.
uniform cpBloomWeight: f32;

/// Gain on the shaft buffer. Separate from the bloom weight because one redistributes
/// energy and the other brings in light that was not in the frame at all.
uniform cpShaftWeight: f32;

/// x: vignette amount, 0 off and 1 the physical falloff. y: tan of half the vertical
/// field of view. z: aspect ratio.
uniform cpVignette: vec3f;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    var scene = textureSample(textureSampler, textureSamplerSampler, input.vUV);

    // MIXED, NOT ADDED, and the distinction is the whole physical claim. Bloom here is
    // veiling glare: light that should have landed on one point of the sensor and instead
    // scattered across it, in the atmosphere between the lens elements, in the eye's own
    // vitreous humour. Scattering MOVES energy, it does not make any, so the scattered
    // fraction has to come out of the focused image. Adding a blurred copy on top would
    // brighten the whole frame, which is why an added bloom always needs a threshold to
    // stop it washing everything out — and a threshold is a lie, because real glare has
    // no cutoff. A snow field glares. This one is thresholdless and energy conserving.
    //
    // GATED BY THE SAME WEIGHT AS THE TONEMAP, for the same reason. A debug view showing
    // roughness is not emitting light, so nothing about it scatters; smearing a blurred
    // copy of it across itself would soften exactly the per-texel structure those views
    // exist to show. The weight is the frame's own answer to "is this light", so both the
    // curve and the glare ask it.
    let bloom = textureSample(cpBloom, cpBloomSampler, input.vUV).rgb;
    let glare = uniforms.cpBloomWeight * saturate(scene.a);
    scene = vec4f(mix(scene.rgb, bloom, glare), scene.a);

    // ADDED, because a shaft is light that was never in the frame: photons from the sun
    // scattering off air somewhere along this view ray. It is new radiance, not
    // redistributed radiance, and it arrives BEFORE the tonemap so a bright shaft rolls
    // off on the same curve as a bright anything else. Gated by the same class weight —
    // a debug view is not air and nothing scatters through it.
    let shafts = textureSample(cpShafts, cpShaftsSampler, input.vUV).rgb;
    scene = vec4f(scene.rgb + shafts * (uniforms.cpShaftWeight * saturate(scene.a)), scene.a);

    // ALPHA IS THE TRANSFORM WEIGHT, and it exists for the debug views. Most of them do
    // not emit light — `vec3f(roughness)` is a number between 0 and 1 that means "how
    // rough", and running a film curve over it turns a linear ramp into a curved one. The
    // instrument stops reading in the units it is labelled in, which is the exact failure
    // this project keeps writing probes to catch.
    //
    // So anything that emits radiance writes 1 here and gets the curve; a debug view
    // showing a raw quantity writes 0 and arrives at the backbuffer untouched. Saturated
    // because additive blending pushes alpha past 1 and an unclamped mix would then
    // extrapolate past the tonemapped colour instead of landing on it.
    // VIGNETTE, BEFORE THE CURVE, BECAUSE IT IS A LENS AND NOT A LOOK. Less light reaches
    // the corner of a sensor than the centre, and the falloff is not an arbitrary radial
    // gradient — it is cos^4 of the angle off the optical axis, which for a pinhole is
    // exactly 1/(1+tan^2)^2. Deriving it from the actual field of view rather than from a
    // radius in UV means it does the right thing on its own: widen the lens and the
    // corners darken more, because they are further off-axis. A UV-radius vignette would
    // look identical at every focal length, which no lens does.
    //
    // Being before the tonemap is what makes it behave: darkening radiance pulls a corner
    // back down the curve, so a blown highlight in the corner rolls off into colour
    // instead of staying flat white and getting greyer. Applied after the transform it
    // would just be a grey wash.
    if (uniforms.cpVignette.x > 0.0) {
        let ndc = input.vUV * 2.0 - vec2f(1.0);
        // Position on the sensor in units of focal length.
        let sensor = vec2f(ndc.x * uniforms.cpVignette.y * uniforms.cpVignette.z, ndc.y * uniforms.cpVignette.y);
        let cos2 = 1.0 / (1.0 + dot(sensor, sensor));
        scene = vec4f(scene.rgb * mix(1.0, cos2 * cos2, uniforms.cpVignette.x), scene.a);
    }

    let mapped = sbDisplay(scene.rgb);
    fragmentOutputs.color = vec4f(mix(scene.rgb, mapped, saturate(scene.a)), 1.0);
}
