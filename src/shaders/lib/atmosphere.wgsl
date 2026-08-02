// SHARED INCLUDE — substrateAtmosphere
//
// Nishita single scattering with a multiple-scattering approximation. This is the
// single definition of "what does the air do to light" — the sky-view LUT bake and
// the SH irradiance bake both include this file, and Phase 2's far-range raymarch
// will include it too. Nothing else is allowed to reinvent an extinction curve.
//
// EVERYTHING HERE IS IN KILOMETRES. A planet radius of 6.36e6 metres has about half
// a metre of f32 resolution, which is fine for the radius itself and hopeless for a
// ray-sphere discriminant near a tangent. In kilometres the same intersection has
// millimetre-scale headroom.
//
// The observer is treated as standing at sea level. Terrain relief here is ±40 m
// against an 8 km Rayleigh scale height, so altitude changes the sky by less than
// the LUT's own quantisation and is not worth a second LUT axis.

const SB_PI: f32 = 3.14159265359;

/// Planet radius and atmosphere top, km.
const SB_RG: f32 = 6360.0;
const SB_RT: f32 = 6460.0;
/// Scale heights, km.
const SB_HR: f32 = 8.0;
const SB_HM: f32 = 1.2;

/// Rayleigh scattering at sea level, per km. Bruneton/Hillaire's fit at 680/550/440 nm.
const SB_BETA_R: vec3f = vec3f(5.802e-3, 13.558e-3, 33.100e-3);
/// Mie scattering at sea level, per km, for a clean atmosphere (turbidity 2.2).
const SB_BETA_M: f32 = 3.996e-3;
/// Aerosols absorb as well as scatter, so extinction is slightly above scattering.
const SB_MIE_EXT_RATIO: f32 = 1.11;
/// Ozone absorption, per km, over the tent profile in sbDensities.
const SB_BETA_O: vec3f = vec3f(0.650e-3, 1.881e-3, 0.085e-3);

/// Direction TOWARD the sun.
uniform saSunDir: vec3f;
/// Solar irradiance perpendicular to the sun at the top of the atmosphere.
/// The overall scale is a unit choice, not a measurement — see SUN_IRRADIANCE in
/// render/sky.ts for why it is where it is.
uniform saSunIrradiance: vec3f;
uniform saRayleighScale: f32;
/// Aerosol loading. 2.2 is the clean-air reference the Mie coefficient is quoted at.
uniform saTurbidity: f32;
/// Mie asymmetry. Higher pushes more energy forward, which is what makes a hazy sun
/// wear a halo rather than sit on a flat gradient.
uniform saMieG: f32;
/// Per-order gain of the multiple-scattering series. 0 disables it entirely.
uniform saMultiScatter: f32;
uniform saGroundAlbedo: vec3f;
uniform saGroundBounce: f32;
uniform saEmissive: vec3f;
/// Fraction of the hemisphere an average ground point can see. Drives the bounce solve.
uniform saSkyVisibility: f32;
/// Raymarch steps along the view ray in the LUT bake.
uniform saSteps: f32;
/// Extra near-ground aerosol extinction, per km, from the element's haze density.
uniform saHaze: f32;
/// Multiplies the aerial-perspective extinction only. Does not touch the sky itself.
uniform saAerialScale: f32;
/// Observer altitude above sea level, km.
uniform saViewHeight: f32;

fn sbBetaR() -> vec3f {
    return SB_BETA_R * uniforms.saRayleighScale;
}

fn sbBetaMs() -> f32 {
    return SB_BETA_M * (uniforms.saTurbidity / 2.2);
}

fn sbBetaMe() -> f32 {
    return sbBetaMs() * SB_MIE_EXT_RATIO;
}

/// Optical depth from an integrated (rayleigh, mie, ozone) density triple — or the
/// extinction coefficient, if the triple is an instantaneous density.
fn sbSigma(d: vec3f) -> vec3f {
    return sbBetaR() * d.x + vec3f(sbBetaMe()) * d.y + SB_BETA_O * d.z;
}

/// Ray against a sphere centred on the origin. Returns (near, far) along the ray;
/// far below zero means the sphere is behind or missed.
///
/// Only ever used against the atmosphere TOP. `dot(ro,ro) - radius*radius` there is a
/// difference of two numbers near 4e7 that lands near -1.3e6, so the f32 cancellation
/// costs a few parts per million. Against the ground it would land near zero and the
/// cancellation would swamp the answer outright — that case has its own function.
fn sbRaySphere(ro: vec3f, rd: vec3f, radius: f32) -> vec2f {
    let b = dot(ro, rd);
    let c = dot(ro, ro) - radius * radius;
    let disc = b * b - c;
    var hit = vec2f(-1.0, -1.0);
    if (disc >= 0.0) {
        let s = sqrt(disc);
        hit = vec2f(-b - s, -b + s);
    }
    return hit;
}

/// Distance from an observer h km up to the ground along rd, or -1 for a miss.
///
/// The quadratic's constant term is `(RG+h)^2 - RG^2`, which is `h(2RG+h)` — the same
/// number, written so it never subtracts two forty-million-ish floats. Written the
/// obvious way it comes out as 25.4 plus or minus 8 for a two-metre eye height, and a
/// sign flip there means the ground below the horizon stops existing.
fn sbGroundHit(h: f32, rd: vec3f) -> f32 {
    var t = -1.0;
    if (rd.y < 0.0) {
        let b = (SB_RG + h) * rd.y;
        let c = h * (2.0 * SB_RG + h);
        let disc = b * b - c;
        if (disc >= 0.0) {
            t = -b - sqrt(disc);
        }
    }
    return t;
}

/// Relative (rayleigh, mie, ozone) density at altitude h km.
///
/// Ozone is the tent that gives a clear evening sky its blue upper band — without it
/// the whole dome reddens together and twilight reads as orange soup.
fn sbDensities(h: f32) -> vec3f {
    return vec3f(exp(-h / SB_HR), exp(-h / SB_HM), max(0.0, 1.0 - abs(h - 25.0) / 15.0));
}

/// Transmittance from p to the top of the atmosphere along dir.
///
/// Altitude is clamped at zero, so a ray that passes through the planet accumulates
/// sea-level density over thousands of kilometres and comes out at zero. That is the
/// planetary shadow, and it costs no branch.
///
/// Steps are QUADRATICALLY spaced, and that is not a refinement. A sun ray at low
/// elevation runs 700 km to the top of the atmosphere while the air that matters is
/// in the first few; eight evenly-spaced samples put the nearest one 44 km up, miss
/// the atmosphere almost entirely, and report a sunset as bright and white as noon.
/// Squared spacing lands this within about 1.5% of the analytic Chapman value for a
/// tangent ray, in eight taps.
fn sbTransmittance(p: vec3f, dir: vec3f) -> vec3f {
    let tMax = max(sbRaySphere(p, dir, SB_RT).y, 0.0);
    var od = vec3f(0.0);
    for (var i = 0; i < 8; i = i + 1) {
        let f0 = f32(i) / 8.0;
        let f1 = f32(i + 1) / 8.0;
        let t0 = tMax * f0 * f0;
        let t1 = tMax * f1 * f1;
        let h = max(length(p + dir * (0.5 * (t0 + t1))) - SB_RG, 0.0);
        od = od + sbDensities(h) * (t1 - t0);
    }
    return exp(-sbSigma(od));
}

fn sbPhaseRayleigh(mu: f32) -> f32 {
    return (3.0 / (16.0 * SB_PI)) * (1.0 + mu * mu);
}

/// Cornette-Shanks. Better behaved than Henyey-Greenstein at g near 0.9, which
/// volcanic ash sits at.
fn sbPhaseMie(mu: f32, g: f32) -> f32 {
    let g2 = g * g;
    let denom = max(1.0 + g2 - 2.0 * g * mu, 1e-4);
    return (3.0 / (8.0 * SB_PI)) * ((1.0 - g2) * (1.0 + mu * mu)) / ((2.0 + g2) * denom * sqrt(denom));
}

/// The observer, in planet-centred coordinates.
fn sbViewOrigin() -> vec3f {
    // Lifted a couple of metres so a straight-down ray has a positive ground hit
    // instead of a degenerate one at t = 0.
    return vec3f(0.0, SB_RG + max(uniforms.saViewHeight, 0.002), 0.0);
}

/// Extinction per km through the air the terrain actually sits in. Used for aerial
/// perspective, where a full raymarch per pixel is not affordable and the first few
/// hundred metres are all at essentially sea-level density anyway.
fn sbAerialExtinction() -> vec3f {
    let sea = sbSigma(sbDensities(0.0)) + vec3f(uniforms.saHaze);
    return sea * uniforms.saAerialScale;
}

struct SbSky {
    /// In-scattered radiance along the ray.
    radiance: vec3f,
    /// Distance in km to the ground hit, or 0 when the ray leaves the atmosphere.
    groundDist: f32,
};

/// Single-scattered radiance along a view ray from the observer, plus an isotropic
/// multiple-scattering term.
///
/// The MS term is an approximation, deliberately: each further scattering order is
/// close to isotropic and carries roughly a fixed fraction of the previous order's
/// energy, so the infinite series collapses to one geometric factor over the
/// phase-free single-scattering integral. It is what stops the sky reading as a
/// flat navy card, and it is the single largest error in this model. A bright ground
/// feeds that series — over snow the sky is visibly milkier than over basalt — which
/// is why groundAlbedo appears here and not only in the surface shading.
fn sbSkyRadiance(rd: vec3f) -> SbSky {
    let viewHeight = max(uniforms.saViewHeight, 0.002);
    let ro = sbViewOrigin();
    let sun = uniforms.saSunDir;

    let tTop = max(sbRaySphere(ro, rd, SB_RT).y, 0.0);
    let tGround = sbGroundHit(viewHeight, rd);

    var tMax = tTop;
    var groundDist = 0.0;
    if (tGround > 0.0) {
        tMax = min(tGround, tTop);
        groundDist = tMax;
    }

    let steps = i32(clamp(uniforms.saSteps, 4.0, 64.0));
    let inv = 1.0 / f32(steps);

    let mu = dot(rd, sun);
    let phaseR = sbPhaseRayleigh(mu);
    let phaseM = sbPhaseMie(mu, uniforms.saMieG);

    var od = vec3f(0.0);
    var accR = vec3f(0.0);
    var accM = vec3f(0.0);

    // Quadratic spacing, for the reason spelled out on sbTransmittance: uniform steps
    // over a 100 km zenith ray put the first sample two kilometres up, which is above
    // most of the Mie layer the horizon is made of.
    for (var i = 0; i < steps; i = i + 1) {
        let f0 = f32(i) * inv;
        let f1 = f32(i + 1) * inv;
        let t0 = tMax * f0 * f0;
        let t1 = tMax * f1 * f1;
        let dt = t1 - t0;

        let p = ro + rd * (0.5 * (t0 + t1));
        let h = max(length(p) - SB_RG, 0.0);
        let d = sbDensities(h);

        od = od + d * dt;
        let w = exp(-sbSigma(od)) * sbTransmittance(p, sun) * dt;

        accR = accR + d.x * w;
        accM = accM + d.y * w;
    }

    let scatterR = sbBetaR() * accR;
    let scatterM = vec3f(sbBetaMs()) * accM;

    var radiance = uniforms.saSunIrradiance * (scatterR * phaseR + scatterM * phaseM);

    let ms = clamp(uniforms.saMultiScatter, 0.0, 0.95);
    let series = ms / max(1.0 - ms, 1e-3);
    let lift = vec3f(1.0) + uniforms.saGroundAlbedo * uniforms.saGroundBounce * 0.6;
    radiance = radiance + uniforms.saSunIrradiance * (scatterR + scatterM) * (1.0 / (4.0 * SB_PI)) * series * lift;

    var out: SbSky;
    out.radiance = radiance;
    out.groundDist = groundDist;
    return out;
}
