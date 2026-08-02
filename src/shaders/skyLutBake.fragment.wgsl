// Bakes the sky-view LUT: 256x128 RGBA16F, rgb = in-scattered radiance for the
// direction, a = distance in km to the ground hit along it.
//
// Rebaked only when the sun moves or an atmosphere parameter changes, which for a
// static sun is never. Half float rather than RGBA32F because the LUT is the one
// sky texture that wants bilinear filtering, and rgba16float filters without asking
// the adapter for float32-filterable.

#include<substrateAtmosphere>
#include<substrateSkyMap>

varying vUV: vec2f;

/// Whether v runs the other way. NOT a constant, and not reasoned about — measured.
/// See _resolveLutOrientation in render/sky.ts.
uniform slFlipV: f32;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    // Which texel row a given vUV.y lands on is a Babylon question, not a WGSL one:
    // the processor appends `position.y *= yFactor_` to every vertex main, and
    // yFactor is -1 whenever the target is a render target — which a procedural
    // texture always is. Getting this backwards is invisible in a heightfield,
    // because mirrored noise is still noise. In a sky it means every upward ray
    // reads a downward one, the in-scatter is near zero, and the entire scene loses
    // its sky. So the orientation is probed at boot and this uniform carries the
    // answer.
    let v = select(input.vUV.y, 1.0 - input.vUV.y, uniforms.slFlipV > 0.5);
    let dir = sbSkyDirFromUv(vec2f(input.vUV.x, v));

    let sky = sbSkyRadiance(dir);

    fragmentOutputs.color = vec4f(sky.radiance, sky.groundDist);
}
