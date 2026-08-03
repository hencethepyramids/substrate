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

/// How far a glint facet tilts off the surface normal, and how tight its flash is.
const SB_GLINT_SPREAD: f32 = 0.38;
const SB_GLINT_POWER: f32 = 420.0;
/// Keep only the tail of the distribution. This is what makes glints read as scattered
/// sparks rather than as a shimmering sheet.
const SB_GLINT_SPARSITY: f32 = 0.82;
/// Radius of one spark as a fraction of its cell. A crystal is much smaller than the
/// patch of ground it is drawn from, and this is that ratio.
const SB_GLINT_SIZE: f32 = 0.13;
const SB_GLINT_NEAR: f32 = 9.0;
const SB_GLINT_FAR: f32 = 26.0;

/// Specular glints from individual facets.
///
/// A snowfield does not have one microfacet distribution, it has a few million ice
/// crystals, and at any instant a handful of them happen to bisect the eye and the sun
/// exactly. That is a different phenomenon from roughness — it does not smear out with
/// the lobe, it flashes — and averaging it into the BRDF is precisely what loses it.
///
/// One facet per lattice cell, cell size set by the element's glints per square metre.
/// `glintBasis` offsets the lattice so the three elements never sparkle in the same
/// pattern, which is why it is a separate number from the density.
///
/// A SPARK SITS INSIDE ITS CELL — it is not the cell. The first version gave each cell
/// one facet with a constant normal, so the whole cell flashed at once, and a flashing
/// cell is a square in world space, which is a diamond on screen. It drew a lattice of
/// tiles. The lattice sets where a crystal MIGHT be; the crystal is much smaller than
/// the patch of ground it was drawn from.
///
/// Fragment-only: this takes screen-space derivatives, so no vertex shader may include
/// it. Requires <substrateNoise> for sbHash2 — the one hash in the project.
fn sbGlints(worldXZ: vec2f, n: vec3f, h: vec3f, density: f32, basis: f32, dist: f32) -> f32 {
    let cellSize = inverseSqrt(max(density, 1.0e-3));
    let p = worldXZ / cellSize;

    // The pixel's footprint in cell units, taken FIRST and unconditionally: derivatives
    // are only legal in uniform control flow, and everything below diverges per pixel.
    let footprint = max(max(fwidth(p.x), fwidth(p.y)), 1.0e-4);

    let cell = vec2i(floor(p)) + vec2i(i32(basis) * 131, i32(basis) * 977);

    // Three independent draws: which way this facet leans, how far, and where in the
    // cell it sits. Where a crystal lies has nothing to do with which way it faces, and
    // reusing one draw for both would tie the sparkle pattern to the view angle.
    let dir = sbHash2(cell);
    let draw = sbHash2(cell + vec2i(19, 47));
    let place = sbHash2(cell + vec2i(73, 11));
    let alive = step(SB_GLINT_SPARSITY, draw.y * 0.5 + 0.5);

    // Never let a spark be narrower than a pixel, or it turns into static as it
    // recedes. Widening it would brighten the field, so the normalisation takes back
    // exactly what the widening added and a distant glint field dims instead.
    let radius = max(SB_GLINT_SIZE, footprint);
    let norm = (SB_GLINT_SIZE * SB_GLINT_SIZE) / (radius * radius);

    // Kept clear of its own cell walls, so a spark is never sliced in half by the
    // lattice — half a Gaussian with a straight edge is just the tile bug again.
    let centre = vec2f(0.5) + place * max(0.5 - radius, 0.0);
    let offset = fract(p) - centre;
    let spark = exp(-dot(offset, offset) / (radius * radius));

    // Tangent frame. The branch dodges a degenerate cross product on level ground.
    var up = vec3f(0.0, 1.0, 0.0);
    if (abs(n.y) > 0.9) {
        up = vec3f(0.0, 0.0, 1.0);
    }
    let t = normalize(cross(up, n));
    let b = cross(n, t);

    let micro = normalize(n + (t * dir.x + b * dir.y) * (SB_GLINT_SPREAD * (draw.x * 0.5 + 0.5)));
    let align = pow(max(dot(micro, h), 0.0), SB_GLINT_POWER);

    // Sub-pixel sparkle is not detail, it is noise. Same argument as the substrate
    // relief fade and the same shape of answer.
    let fade = clamp(1.0 - (dist - SB_GLINT_NEAR) / (SB_GLINT_FAR - SB_GLINT_NEAR), 0.0, 1.0);
    return align * alive * spark * norm * fade;
}

/// Emission from the phase channel, as radiance.
///
/// Phase 6 is what drives phase with heat. Until then this is identically zero
/// everywhere and costs three instructions — wired now for the same reason
/// spThermalCoupling was, so Phase 6 only has to WRITE the channel and cannot introduce
/// a second opinion about what hot material looks like.
fn sbEmissive(phase: f32, gain: f32) -> vec3f {
    let t = clamp(phase, 0.0, 1.0);
    // A crude blackbody walk: dull red, through orange, toward white-hot. Quadratic in
    // t so that merely warm material does not glow.
    let hue = vec3f(1.0, 0.08 + 0.35 * t, 0.02 + 0.25 * t * t);
    return hue * (gain * t * t * 4.0);
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
