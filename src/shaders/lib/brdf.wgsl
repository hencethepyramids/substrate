// SHARED INCLUDE — substrateBrdf
//
// The one surface reflectance model. Phase 4 gives it to the terrain; Phase 7's
// character and Phase 8's wake get the same lines, because a capsule lit by a different
// specular model than the ground it stands on is how you end up trusting the wrong one.
//
// Everything here returns a factor to multiply by light, never light itself — so the
// atmosphere stays the single source of how bright anything is, exactly as it has been
// since Phase 2. Pair the diffuse term with sbSunDiffuse() and the specular term with
// sbSunIrradiance(), which Phase 2 put in the data texture for this.

const SB_PI: f32 = 3.14159265359;

/// Fresnel at normal incidence for a dielectric. Snow, sand and ash are all dielectrics
/// and all sit within a couple of percent of 0.04 — there is no element that needs its
/// own, which is why this is a constant and not a registry field.
const SB_F0: f32 = 0.04;

/// How much sharper the second lobe is. Dual-lobe exists because a sand grain reflects
/// both off its own facet and off the wet-looking film of fines around it, and those are
/// nothing like the same width.
const SB_LOBE_SHARP: f32 = 0.32;

/// GGX specular, returned as the whole BRDF already multiplied by N·L.
///
/// Multiply by the light's perpendicular irradiance to get reflected radiance. `v` points
/// from the surface TOWARD the eye.
fn sbSpecular(n: vec3f, v: vec3f, l: vec3f, roughness: f32) -> f32 {
    let h = normalize(l + v);
    let ndl = max(dot(n, l), 0.0);
    let ndv = max(dot(n, v), 1e-4);
    let ndh = max(dot(n, h), 0.0);
    let vdh = max(dot(v, h), 1e-4);

    // Roughness is perceptual and alpha is the lobe width. Squaring is the usual mapping
    // and it is what makes the number in the registry behave linearly to the eye.
    let a = max(roughness * roughness, 1.0e-3);
    let a2 = a * a;

    let denom = ndh * ndh * (a2 - 1.0) + 1.0;
    let d = a2 / (SB_PI * denom * denom);

    // Height-correlated Smith. This form already carries the 1/(4 N·L N·V) of the
    // microfacet denominator, so there is no stray 4 anywhere below.
    let gv = ndl * sqrt(ndv * ndv * (1.0 - a2) + a2);
    let gl = ndv * sqrt(ndl * ndl * (1.0 - a2) + a2);
    let vis = 0.5 / max(gv + gl, 1.0e-5);

    let f = SB_F0 + (1.0 - SB_F0) * pow(1.0 - vdh, 5.0);

    return d * vis * f * ndl;
}

/// Two lobes blended by the element's own mix. 0 collapses to a single lobe exactly.
fn sbSpecularDual(n: vec3f, v: vec3f, l: vec3f, roughness: f32, lobeMix: f32) -> f32 {
    let broad = sbSpecular(n, v, l, roughness);
    let sharp = sbSpecular(n, v, l, roughness * SB_LOBE_SHARP);
    return mix(broad, sharp, lobeMix);
}

/// Diffuse plus subsurface back-scatter, per unit irradiance.
///
/// Light that enters the surface, scatters inside it and comes back out does not respect
/// the terminator — which is why a snow dune stays luminous well past where N·L says it
/// should be black. The wrap widens N·L, and THE EXTRA LIGHT THE WRAP ADDS is precisely
/// the part that travelled through the material, so that is the part, and only that
/// part, which gets the tint. Snow's is blue because ice absorbs red over a path length
/// of a few centimetres; sand's is warm for the same reason with different chemistry.
///
/// Phase 1 had a flat `wrap = 0.18` here with no tint at all. This replaces it with two
/// numbers that have been sitting in the registry since Phase 0.
fn sbDiffuseSss(albedo: vec3f, ndl: f32, tint: vec3f, strength: f32) -> vec3f {
    let wrap = 0.05 + 0.30 * strength;
    let wrapped = clamp((ndl + wrap) / (1.0 + wrap), 0.0, 1.0);
    let direct = max(ndl, 0.0);
    let scattered = max(wrapped - direct, 0.0);
    return albedo * direct + albedo * tint * (scattered * strength);
}
