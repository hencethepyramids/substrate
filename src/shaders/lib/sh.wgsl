// SHARED INCLUDE — substrateSh
//
// Real orthonormal spherical harmonics to l = 2, and the Lambert convolution
// factors. Pure maths — no textures, no uniforms — because the bake that PROJECTS
// into this basis and the shaders that EVALUATE it must use the same nine functions
// in the same order. Two copies that disagree by one sign produce lighting that is
// subtly wrong from one direction only, which reads as an art problem for weeks.
//
// The basis is written in world axes rather than the textbook's z-up. A rigid
// relabelling of the axes leaves an orthonormal basis orthonormal, and doing it here
// means no consumer ever has to swizzle a normal before evaluating.

/// Basis function i, 0..8, at a unit direction.
fn sbShBasis(i: i32, d: vec3f) -> f32 {
    var y = 0.5462742 * (d.x * d.x - d.y * d.y);
    if (i == 0) {
        y = 0.2820948;
    } else if (i == 1) {
        y = 0.4886025 * d.y;
    } else if (i == 2) {
        y = 0.4886025 * d.z;
    } else if (i == 3) {
        y = 0.4886025 * d.x;
    } else if (i == 4) {
        y = 1.0925484 * d.x * d.y;
    } else if (i == 5) {
        y = 1.0925484 * d.y * d.z;
    } else if (i == 6) {
        y = 0.3153916 * (3.0 * d.z * d.z - 1.0);
    } else if (i == 7) {
        y = 1.0925484 * d.x * d.z;
    }
    return y;
}

/// Lambert cosine-lobe convolution coefficient for band l(i): pi, 2pi/3, pi/4.
/// Ramamoorthi and Hanrahan's A-hat, which is what turns a radiance projection into
/// an irradiance one.
fn sbShConvolve(i: i32) -> f32 {
    var a = 0.7853982;
    if (i == 0) {
        a = 3.1415927;
    } else if (i < 4) {
        a = 2.0943951;
    }
    return a;
}
