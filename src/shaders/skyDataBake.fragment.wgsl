// Bakes the 16x1 sky data texture: SH irradiance, direct sun, ground bounce and the
// aerial extinction. See shaders/lib/skyData.wgsl for the texel layout.
//
// Sixteen pixels of work. The loops below run 2048 sphere samples twice, which is
// 65k iterations for the whole pass — less than a single row of the height bake.

#include<substrateAtmosphere>
#include<substrateSkyMap>
#include<substrateSkyLut>
#include<substrateSh>

varying vUV: vec2f;

uniform sdTexels: f32;
uniform sdLutSize: vec2f;
/// Element tint on the solar spectrum: what ash and dust do to sunlight beyond what
/// the Rayleigh/Mie model already accounts for.
uniform sdSunTint: vec3f;

/// Uniform-solid-angle quadrature over the sphere. 64 x 32 puts 2048 samples down
/// with an equal weight each, which keeps the SH projection unbiased without any
/// jacobian bookkeeping.
const SD_PHI: i32 = 64;
const SD_THETA: i32 = 32;

/// Two directions used to score the LUT against a direct evaluation of the same
/// model — the orientation check. Both well above the horizon and at unrelated
/// azimuths, so neither a vertical nor a horizontal flip can pass by luck: the
/// mirrored row of an upward ray is a downward one, which terminates on the ground
/// within metres and carries essentially no in-scatter.
const SD_PROBE_A: vec3f = vec3f(0.5417, 0.6428, 0.5417); // 40 deg up, azimuth 45
const SD_PROBE_B: vec3f = vec3f(-0.3407, 0.0872, -0.9360); // 5 deg up, azimuth 200

fn sdDir(ix: i32, iy: i32) -> vec3f {
    let cosT = 1.0 - 2.0 * (f32(iy) + 0.5) / f32(SD_THETA);
    let sinT = sqrt(max(0.0, 1.0 - cosT * cosT));
    let phi = SB_SKY_TAU * (f32(ix) + 0.5) / f32(SD_PHI);
    return vec3f(sinT * cos(phi), cosT, sinT * sin(phi));
}

/// Nearest-texel read of the sky LUT. Nearest, not filtered: the quadrature is
/// already averaging thousands of samples and a filtered tap would only cost time.
fn sdLut(dir: vec3f) -> vec3f {
    let uv = sbSkyUvFromDir(dir);
    let limit = uniforms.sdLutSize - vec2f(1.0);
    let c = vec2i(clamp(uv * uniforms.sdLutSize, vec2f(0.0), limit));
    return textureLoad(sbSkyLut, c, 0).rgb;
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let idx = i32(floor(input.vUV.x * uniforms.sdTexels));
    let w = 4.0 * SB_PI / f32(SD_PHI * SD_THETA);

    // Hoisted out of the branch on purpose. sbSkyRaw is a textureSample and idx comes
    // from a varying, so reading it inside the if-chain would be non-uniform control
    // flow and the shader would not compile. textureLoad has no such requirement,
    // which is why sdLut can live down there.
    let lutA = sbSkyRaw(SD_PROBE_A).rgb;
    let lutB = sbSkyRaw(SD_PROBE_B).rgb;

    // -- sky irradiance on an up-facing surface ------------------------------
    var skyUp = vec3f(0.0);
    for (var iy = 0; iy < SD_THETA; iy = iy + 1) {
        for (var ix = 0; ix < SD_PHI; ix = ix + 1) {
            let d = sdDir(ix, iy);
            if (d.y > 0.0) {
                skyUp = skyUp + sdLut(d) * d.y * w;
            }
        }
    }

    // -- direct sun at the ground --------------------------------------------
    let sunLight = uniforms.saSunIrradiance * sbTransmittance(sbViewOrigin(), uniforms.saSunDir) * uniforms.sdSunTint;
    let sunOnGround = sunLight * max(uniforms.saSunDir.y, 0.0);

    // -- ground bounce, solved iteratively -----------------------------------
    //
    // A ground point sees sky over `vis` of its hemisphere and other ground over the
    // rest, so its own bounce feeds back into its own illumination. Six terms of the
    // series is far past convergence even at snow's 0.9 albedo, and it is cheaper
    // than the closed form is to read.
    //
    // This term is the whole reason snow reads as white rather than grey. Under a
    // low sun a north face receives almost nothing directly; what fills it is a
    // hemisphere of lit snowfield, and an engine without this term has to fake it
    // with an ambient constant that is wrong for every other biome.
    let vis = clamp(uniforms.saSkyVisibility, 0.05, 1.0);
    let rho = uniforms.saGroundAlbedo * uniforms.saGroundBounce;
    var bounce = vec3f(0.0);
    for (var k = 0; k < 6; k = k + 1) {
        let onGround = vis * (skyUp + sunOnGround) + (1.0 - vis) * bounce * SB_PI;
        bounce = rho * onGround / SB_PI;
    }
    // Volcanic gets most of its ambient from emission, and emission belongs to the
    // ground, so it enters through the lower hemisphere and lights faces from below.
    bounce = bounce + uniforms.saEmissive;

    var value = vec3f(0.0);
    if (idx < 9) {
        var acc = vec3f(0.0);
        for (var iy = 0; iy < SD_THETA; iy = iy + 1) {
            for (var ix = 0; ix < SD_PHI; ix = ix + 1) {
                let d = sdDir(ix, iy);
                var radiance = bounce;
                if (d.y > 0.0) {
                    radiance = sdLut(d);
                }
                acc = acc + radiance * sbShBasis(idx, d) * w;
            }
        }
        // Fold the Lambert convolution and the 1/pi in here, so every consumer is
        // one dot product and a multiply by albedo.
        value = acc * (sbShConvolve(idx) / SB_PI);
    } else if (idx == 9) {
        value = sunLight / SB_PI;
    } else if (idx == 10) {
        value = bounce;
    } else if (idx == 11) {
        value = sbAerialExtinction();
    } else if (idx == 12) {
        value = skyUp;
    } else if (idx == 13) {
        value = lutA;
    } else if (idx == 14) {
        value = sbSkyRadiance(SD_PROBE_A).radiance;
    } else if (idx == 15) {
        value = lutB;
    } else if (idx == 16) {
        value = sbSkyRadiance(SD_PROBE_B).radiance;
    }

    fragmentOutputs.color = vec4f(value, 1.0);
}
