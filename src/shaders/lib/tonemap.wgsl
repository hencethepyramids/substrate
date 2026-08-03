// SHARED INCLUDE — substrateTonemap
//
// The display transfer. One curve for every material, because a dome and the ground
// under it read against each other and cannot be on two different curves.
//
// PULLED FORWARD FROM PHASE 9, and for a specific reason. Phase 4's specular is
// physically correct and therefore enormous: at a low sun the glitter path on snow
// lands near 17 in scene-referred units against a diffuse peak of 0.85. That is what a
// real highlight is. A bare `pow(color, 1/2.2)` clips everything above 1 to flat white,
// so the highlight is not merely ugly, it is undisplayable — and tuning roughness to
// stop it blowing out would be tuning the BRDF to compensate for a broken transfer,
// which is the exact class of self-consistent-and-wrong this project keeps catching.
//
// So the curve lands now and the rest of the post chain still belongs to Phase 9.
// `post.tonemap` has been in the schema since Phase 0 with nothing behind it.
//
// Everything here returns LINEAR display-referred colour. The caller applies the gamma,
// so all three modes encode identically and only the curve differs.

/// 0 agx, 1 aces, 2 none. Matches TONEMAPS in core/settings.ts.
uniform sbTonemapMode: f32;

/// Sixth-order fit of the AgX sigmoid, on log-encoded input in 0..1.
fn sbAgxContrast(x: vec3f) -> vec3f {
    let x2 = x * x;
    let x4 = x2 * x2;
    return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}

/// AgX. Log-encode into a bounded range, apply a sigmoid there, decode.
///
/// Working in log space is the whole point: it is what keeps a bright highlight from
/// dragging its own hue toward the primaries as it clips, which is why a blown snow
/// specular stays white instead of turning cyan. The inset matrix desaturates before
/// the curve and the outset puts the saturation back, so the rolloff happens to
/// luminance rather than to each channel independently.
fn sbAgx(colorIn: vec3f) -> vec3f {
    let srgbToRec2020 = mat3x3f(vec3f(0.627402, 0.069095, 0.016394), vec3f(0.329292, 0.919544, 0.088028), vec3f(0.043306, 0.011360, 0.895578));
    let rec2020ToSrgb = mat3x3f(vec3f(1.660491, -0.124550, -0.018151), vec3f(-0.587641, 1.132900, -0.100579), vec3f(-0.072850, -0.008349, 1.118730));
    let inset = mat3x3f(vec3f(0.856627153315983, 0.137318972929847, 0.11189821299995), vec3f(0.0951212405381588, 0.761241990602591, 0.0767994186031903), vec3f(0.0482516061458583, 0.101439036467562, 0.811302368396859));
    let outset = mat3x3f(vec3f(1.1271005818144368, -0.1413297634984383, -0.14132976349843826), vec3f(-0.11060664309660323, 1.157823702216272, -0.11060664309660294), vec3f(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));

    // The exposure range the curve spans, in stops either side of mid grey.
    let minEv = -12.47393;
    let maxEv = 4.026069;

    var c = inset * (srgbToRec2020 * max(colorIn, vec3f(0.0)));
    c = log2(max(c, vec3f(1.0e-10)));
    c = clamp((c - minEv) / (maxEv - minEv), vec3f(0.0), vec3f(1.0));
    c = sbAgxContrast(c);
    c = outset * c;
    // The fit is built against a 2.2 encode, so undo it to hand back linear.
    c = pow(max(c, vec3f(0.0)), vec3f(2.2));
    return clamp(rec2020ToSrgb * c, vec3f(0.0), vec3f(1.0));
}

/// Narkowicz's ACES fit. Punchier and more saturated than AgX; kept because it is the
/// reference most people's eyes are calibrated to.
fn sbAces(x: vec3f) -> vec3f {
    let a = 2.51;
    let b = 0.03;
    let c = 2.43;
    let d = 0.59;
    let e = 0.14;
    return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3f(0.0), vec3f(1.0));
}

/// Scene-referred radiance in, linear display-referred colour out.
fn sbTonemap(color: vec3f) -> vec3f {
    let lit = max(color, vec3f(0.0));
    var mapped = lit;
    if (uniforms.sbTonemapMode < 0.5) {
        mapped = sbAgx(lit);
    } else if (uniforms.sbTonemapMode < 1.5) {
        mapped = sbAces(lit);
    } else {
        // No curve at all — everything above 1 clips flat. This is what every phase
        // before 4 shipped, kept so the difference can be seen rather than argued about.
        mapped = clamp(lit, vec3f(0.0), vec3f(1.0));
    }
    return mapped;
}

/// Tonemap and encode. The one place a material turns radiance into a pixel.
fn sbDisplay(color: vec3f) -> vec3f {
    return pow(sbTonemap(color), vec3f(1.0 / 2.2));
}
