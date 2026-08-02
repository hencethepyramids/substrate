// SHARED INCLUDE — substrateSkyData
//
// Everything a lit surface needs to know about the sky, as a 16x1 texture.
// Requires <substrateSh> for the basis, and <substrateSkyLut> + <substrateSkyMap>
// for sbHazeColor.
//
//   0..8   SH coefficients of the full-sphere radiance, already convolved with the
//          Lambert lobe and divided by pi. Multiply the evaluation by albedo and
//          that is the diffuse term — no further constants anywhere.
//   9      Direct sun, in the same units: perpendicular irradiance over pi.
//   10     Ground bounce radiance, uniform over the lower hemisphere.
//   11     Aerial-perspective extinction per km.
//   12     Sky irradiance on an up-facing surface. Diagnostics only.
//   13,14  LUT sample vs direct evaluation at probe direction A — the orientation
//   15,16  check. Same for direction B. Read back once at boot; see sky.ts.
//   17..19 Reserved.
//
// Twenty texels of RGBA32F, read with textureLoad. Nine SH coefficients could have
// been nine uniforms instead, but then the bake would have to come back through a
// readback to reach the CPU, and grounding already taught this project what a
// round trip through readPixels costs.

var sbSkyDataSampler: sampler;
var sbSkyData: texture_2d<f32>;

/// Direction TOWARD the sun. Every lit surface needs it, so it rides with the sky.
uniform sbSunDir: vec3f;

fn sbSkyDataAt(i: i32) -> vec3f {
    return textureLoad(sbSkyData, vec2i(i, 0), 0).rgb;
}

/// Sky and bounce contribution to Lambertian reflected radiance, per unit albedo.
///
/// Clamped at zero because an L2 projection of a sky with a bright horizon rings,
/// and ringing that goes negative shows up as black patches on downward faces. The
/// honest fix is a windowed projection; this is the cheap one, and Phase 4's real
/// surface model is where it becomes worth paying for.
fn sbShIrradiance(n: vec3f) -> vec3f {
    var acc = vec3f(0.0);
    for (var i = 0; i < 9; i = i + 1) {
        acc = acc + sbSkyDataAt(i) * sbShBasis(i, n);
    }
    return max(acc, vec3f(0.0));
}

/// Sun contribution to Lambertian reflected radiance, per unit albedo, before N.L.
fn sbSunDiffuse() -> vec3f {
    return sbSkyDataAt(9);
}

/// True perpendicular irradiance of the sun at the ground. For the sun disc and,
/// from Phase 4, the specular lobes.
fn sbSunIrradiance() -> vec3f {
    return sbSkyDataAt(9) * 3.1415927;
}

/// Radiance of the bounced ground, uniform over the lower hemisphere.
fn sbGroundLight() -> vec3f {
    return sbSkyDataAt(10);
}

/// Sky irradiance on an up-facing surface.
fn sbSkyUpIrradiance() -> vec3f {
    return sbSkyDataAt(12);
}

/// Transmittance across `km` of near-ground atmosphere.
fn sbAerial(km: f32) -> vec3f {
    return exp(-sbSkyDataAt(11) * max(km, 0.0));
}

/// The colour distant haze takes in a view direction.
///
/// Sampled at the horizon of the view azimuth rather than along the view ray itself.
/// Looking down at terrain 800 m away, the LUT's own downward entry describes a path
/// that runs to the planet's surface tens of kilometres out; the haze between here
/// and that hillside is horizontal air, and horizontal air is what the horizon row
/// holds.
fn sbHazeColor(viewDir: vec3f) -> vec3f {
    let flat = vec3f(viewDir.x, max(viewDir.y, 0.0), viewDir.z);
    let len = length(flat);
    var d = vec3f(0.0, 1.0, 0.0);
    if (len > 1e-5) {
        d = flat / len;
    }
    return sbSkyRaw(d).rgb;
}
