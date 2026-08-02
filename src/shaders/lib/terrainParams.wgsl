// SHARED INCLUDE — substrateTerrainParams
//
// The terrain parameter block, as uniforms, and the one function that fills the
// struct from them. Requires <substrateHeightfield> for SbTerrainParams.
//
// Split out so the bake and the probe that CHECKS the bake fill the struct from
// the same twenty lines. Two copies of an assignment list is exactly the kind of
// thing that stays right for two phases and then quietly stops being right, and a
// verification pass that disagrees with the thing it verifies is worse than none.

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

fn sbTerrainParams() -> SbTerrainParams {
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
    return prm;
}
