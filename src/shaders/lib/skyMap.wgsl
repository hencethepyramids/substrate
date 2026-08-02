// SHARED INCLUDE — substrateSkyMap
//
// The sky-view LUT's parameterisation, and nothing else: no textures, no uniforms.
// The bake, the SH projection and every consumer all map directions to texels
// through these two functions, so there is exactly one place where a sign or a
// square root can be wrong.

const SB_SKY_HALF_PI: f32 = 1.57079632679;
const SB_SKY_TAU: f32 = 6.28318530718;

/// Direction for a LUT coordinate. u wraps the azimuth, v runs nadir to zenith.
///
/// Elevation is quadratic in v (`l * |l|`) rather than linear. Almost everything
/// interesting in an atmosphere happens within a few degrees of the horizon — the
/// gradient there is steeper than anywhere else in the dome, and a linear mapping
/// spends most of its rows on empty zenith.
fn sbSkyDirFromUv(uv: vec2f) -> vec3f {
    let az = (uv.x - 0.5) * SB_SKY_TAU;
    let l = uv.y * 2.0 - 1.0;
    let elev = l * abs(l) * SB_SKY_HALF_PI;
    let ce = cos(elev);
    return vec3f(ce * sin(az), sin(elev), ce * cos(az));
}

/// Exact inverse of sbSkyDirFromUv.
fn sbSkyUvFromDir(dir: vec3f) -> vec2f {
    let d = normalize(dir);
    let elev = asin(clamp(d.y, -1.0, 1.0));
    let l = sqrt(abs(elev) / SB_SKY_HALF_PI) * select(-1.0, 1.0, elev >= 0.0);
    let az = atan2(d.x, d.z);
    return vec2f(az / SB_SKY_TAU + 0.5, l * 0.5 + 0.5);
}
