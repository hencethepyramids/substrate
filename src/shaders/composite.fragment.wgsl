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

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let scene = textureSample(textureSampler, textureSamplerSampler, input.vUV);

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
    let mapped = sbDisplay(scene.rgb);
    fragmentOutputs.color = vec4f(mix(scene.rgb, mapped, saturate(scene.a)), 1.0);
}
