// Bakes the heightfield into a 4096x4096 RG32F target: R = height in metres,
// G = packed analytic derivative. Runs once at load, and again on a biome switch
// or a terrain parameter change. One fullscreen pass.

#include<substrateNoise>
#include<substrateHeightfield>
#include<substratePack>

varying vUV: vec2f;

uniform bkOrigin: vec2f;
uniform bkExtent: f32;

uniform bkWind: vec2f;
uniform bkSeed: f32;
uniform bkSwellAmp: f32;
uniform bkSwellFreq: f32;
uniform bkDuneAmp: f32;
uniform bkDuneFreq: f32;
uniform bkDuneStretch: f32;
uniform bkDuneOctaves: f32;
uniform bkShearAmp: f32;
uniform bkShearFreq: f32;
uniform bkDetailAmp: f32;
uniform bkDetailFreq: f32;
uniform bkDamping: f32;
uniform bkRidgeAmp: f32;
uniform bkRidgeFreq: f32;
uniform bkOutcropAmp: f32;
uniform bkOutcropFreq: f32;
uniform bkOutcropThreshold: f32;
uniform bkChannelDepth: f32;
uniform bkChannelFreq: f32;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    var prm: SbTerrainParams;
    prm.wind = uniforms.bkWind;
    prm.seed = uniforms.bkSeed;
    prm.swellAmp = uniforms.bkSwellAmp;
    prm.swellFreq = uniforms.bkSwellFreq;
    prm.duneAmp = uniforms.bkDuneAmp;
    prm.duneFreq = uniforms.bkDuneFreq;
    prm.duneStretch = uniforms.bkDuneStretch;
    prm.duneOctaves = uniforms.bkDuneOctaves;
    prm.shearAmp = uniforms.bkShearAmp;
    prm.shearFreq = uniforms.bkShearFreq;
    prm.detailAmp = uniforms.bkDetailAmp;
    prm.detailFreq = uniforms.bkDetailFreq;
    prm.damping = uniforms.bkDamping;
    prm.ridgeAmp = uniforms.bkRidgeAmp;
    prm.ridgeFreq = uniforms.bkRidgeFreq;
    prm.outcropAmp = uniforms.bkOutcropAmp;
    prm.outcropFreq = uniforms.bkOutcropFreq;
    prm.outcropThreshold = uniforms.bkOutcropThreshold;
    prm.channelDepth = uniforms.bkChannelDepth;
    prm.channelFreq = uniforms.bkChannelFreq;

    // Texel row 0 is the TOP of the target, which is NDC +y, which is vUV.y = 1.
    // sbSampleField indexes rows by increasing world Z, so Z has to be flipped here
    // or the sampled field comes out mirrored against the one that was baked.
    let uv = vec2f(input.vUV.x, 1.0 - input.vUV.y);
    let world = uniforms.bkOrigin + uv * uniforms.bkExtent;
    let field = sbTerrainD(world, prm);

    fragmentOutputs.color = vec4f(field.x, sbPackDeriv(field.yz), 0.0, 1.0);
}
