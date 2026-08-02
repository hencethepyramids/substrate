// SHARED INCLUDE — substrateHeightfield
//
// ONE terrain function. Snowfield, desert and volcanic are the same construction
// with different numbers — no branches on biome, no second generator. The bake pass
// calls it, and Phase 2's far-range raymarch will call the identical function so
// near and far terrain cannot disagree about what the world is shaped like.
//
// Returns vec3f(height in metres, dh/dx, dh/dz).

struct SbTerrainParams {
    /// Prevailing wind direction, normalised. Everything anisotropic aligns to this.
    wind: vec2f,
    seed: f32,

    /// One long low swell — the large-scale shape everything else sits on.
    swellAmp: f32,
    swellFreq: f32,

    /// Broad transverse dune ridges, stretched across the wind.
    duneAmp: f32,
    duneFreq: f32,
    duneStretch: f32,
    duneOctaves: f32,

    /// Domain shear along the wind. This is what produces lee-face asymmetry.
    shearAmp: f32,
    shearFreq: f32,

    /// Medium drifts riding on the sheared domain.
    detailAmp: f32,
    detailFreq: f32,
    /// Slope damping for both fBm layers. Higher = smoother hollows, crisper crests.
    damping: f32,

    /// Ridged multifractal: volcanic flow levees and fracture lines. Zero elsewhere.
    ridgeAmp: f32,
    ridgeFreq: f32,

    /// Sparse hard outcrops pushing through the loose material.
    outcropAmp: f32,
    outcropFreq: f32,
    outcropThreshold: f32,

    /// Carved channels that Phase 6 fills with lava. Zero elsewhere.
    channelDepth: f32,
    channelFreq: f32,
};

fn sbTerrainD(world: vec2f, prm: SbTerrainParams) -> vec3f {
    let wind = normalize(prm.wind + vec2f(1e-6, 0.0));
    let seed = vec2f(prm.seed * 13.7, prm.seed * -7.3);

    var h = 0.0;
    var g = vec2f(0.0);

    // 1. The long swell. Single octave on purpose: this is the horizon silhouette,
    //    and anything with detail in it fights the layers above.
    let sw = sbNoiseD(world * prm.swellFreq + seed);
    h = h + prm.swellAmp * sw.x;
    g = g + prm.swellAmp * prm.swellFreq * sw.yz;

    // 2. Shear the domain downwind. Everything sampled in this frame inherits the
    //    asymmetry, which is why drifts and dunes agree about which way the wind blows.
    let sh = sbShearDomain(world, wind, prm.shearFreq, prm.shearAmp);

    // 3. Transverse dune ridges. Stretched across the wind, then unstretched and
    //    unsheared on the way back out so the gradient is in world space.
    let q = sbAniso(sh.p, wind, prm.duneStretch);
    let dn = sbFbmD(q * prm.duneFreq + seed * 1.7, i32(prm.duneOctaves), 2.03, 0.5, prm.damping);
    h = h + prm.duneAmp * dn.x;
    var dg = prm.duneAmp * prm.duneFreq * dn.yz;
    dg = sbAnisoGrad(dg, wind, prm.duneStretch);
    g = g + sbShearGrad(dg, wind, sh);

    // 4. Medium drifts. Isotropic in the sheared frame, so the shear alone gives them
    //    their lee-face bias.
    let dt = sbFbmD(sh.p * prm.detailFreq + seed * 3.1, 5, 2.01, 0.5, prm.damping);
    h = h + prm.detailAmp * dt.x;
    g = g + sbShearGrad(prm.detailAmp * prm.detailFreq * dt.yz, wind, sh);

    // 5. Ridged levees.
    if (prm.ridgeAmp > 0.0) {
        let rg = sbRidgedD(world * prm.ridgeFreq + seed * 5.9, 5, 2.07, 0.5);
        h = h + prm.ridgeAmp * rg.x;
        g = g + prm.ridgeAmp * prm.ridgeFreq * rg.yz;
    }

    // 6. Sparse outcrops. Thresholded through a smoothstep so the normal stays
    //    continuous where the rock emerges instead of showing a hard rim.
    if (prm.outcropAmp > 0.0) {
        let oc = sbNoiseD(world * prm.outcropFreq + seed * 8.3);
        let s = sbSmoothstepD(prm.outcropThreshold, prm.outcropThreshold + 0.28, oc.x);
        h = h + prm.outcropAmp * s.x;
        g = g + prm.outcropAmp * s.y * prm.outcropFreq * oc.yz;
    }

    // 7. Channels. Subtracted, so they cut through everything above.
    if (prm.channelDepth > 0.0) {
        let ch = sbRidgedD(world * prm.channelFreq + seed * 2.3, 3, 2.11, 0.55);
        // ch is near 1 along the ridge lines; invert so the lines become the floor.
        h = h - prm.channelDepth * ch.x;
        g = g - prm.channelDepth * prm.channelFreq * ch.yz;
    }

    return vec3f(h, g);
}
