// An ember. A round, soft, blackbody-coloured spark, drawn additively.
//
// It borrows the emissive ramp the ground uses rather than carrying a palette of its own,
// so a spark and the crack it came out of are the same colour by construction.

// substrateBrdf's glints and crust reference sbHash2 and sbNoiseD. WGSL wants every
// function a module mentions to exist whether or not this shader can reach it, so the
// noise library comes along even though an ember only ever calls sbEmissive.
#include<substrateNoise>
#include<substrateBrdf>

varying vCorner: vec2f;
varying vGlow: f32;

uniform emExposure: f32;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    // Round, not square. The quad is a carrier; anything outside the disc is thrown away
    // by the falloff rather than by a discard, which keeps the shader branchless.
    let r2 = dot(input.vCorner, input.vCorner);
    let disc = clamp(1.0 - r2, 0.0, 1.0);
    // Squared so the core is tight and the edge is soft — a spark is mostly its centre.
    let alpha = disc * disc * input.vGlow;

    // Full phase, because an ember IS the molten material, not the crust over it.
    let radiance = sbEmissive(1.0, 1.0) * alpha * exp2(uniforms.emExposure);

    // Additive, and now additive in the space where addition means something. Two
    // sparks overlapping used to sum two tonemapped values, which double-counts the
    // shoulder and makes the pair dimmer than one bright spark; they now sum as light
    // and the curve runs once over the total. Alpha is the composite's transform
    // weight — a spark is light, so 1.
    fragmentOutputs.color = vec4f(radiance, 1.0);
}
