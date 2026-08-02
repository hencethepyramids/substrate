// Bakes the heightfield into a 4096x4096 RG32F target: R = height in metres,
// G = packed analytic derivative. Runs once at load, and again on a biome switch
// or a terrain parameter change. One fullscreen pass.

#include<substrateNoise>
#include<substrateHeightfield>
#include<substrateTerrainParams>
#include<substratePack>

varying vUV: vec2f;

/// Whether v runs the other way. Measured at boot by scoring the baked field
/// against sbTerrainD itself — see _resolveBakeOrientation in terrain/heightfield.ts.
uniform bkFlipV: f32;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    // Which texel row a vUV.y lands on depends on a y-flip Babylon appends to every
    // vertex main, which is -1 for a render target. Guessing it wrong here mirrors
    // the whole field in Z, and mirrored noise is still noise — so it renders
    // perfectly, grounding still agrees with the drawn surface, and NOTHING looks
    // wrong until a pass that evaluates sbTerrainD analytically disagrees with the
    // clipmap about where a hill is. Hence the probe rather than a constant.
    let v = select(input.vUV.y, 1.0 - input.vUV.y, uniforms.bkFlipV > 0.5);
    let world = uniforms.bkOrigin + vec2f(input.vUV.x, v) * uniforms.bkExtent;

    let field = sbTerrainD(world, sbTerrainParams());

    fragmentOutputs.color = vec4f(field.x, sbPackDeriv(field.yz), 0.0, 1.0);
}
