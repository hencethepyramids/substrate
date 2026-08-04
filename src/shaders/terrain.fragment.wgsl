// Terrain shading. Phase 4 replaces the material with the uber-shader that reads the
// substrate channels; what is real here is the normal, which comes from the analytic
// derivative baked alongside the height, and the light, which now comes from the same
// atmosphere the sky behind it is drawn from.
//
// There is no ambient constant in this file and no fog colour uniform. Both were
// Phase 1 stand-ins for numbers that are now solved: sbShIrradiance is the sky and
// the ground bounce projected into SH, and sbHazeColor is the sky itself, sampled at
// the horizon of the view azimuth.

#include<substrateSkyMap>
#include<substrateSkyLut>
#include<substrateSh>
#include<substrateSkyData>
#include<substrateShadow>
#include<substrateBuffer>
// Above substrateBrdf: the glints draw their facets from sbHash2, the one hash.
#include<substrateNoise>
#include<substrateBrdf>
#include<substrateTonemap>
// Below substrateNoise: the gusts ride on sbNoiseD.
#include<substrateAir>
#include<substrateAirborne>
#include<substrateFireBuffer>

varying vWorld: vec3f;
varying vDeriv: vec2f;
varying vLevel: f32;
varying vMorph: f32;

uniform fCameraPos: vec3f;
uniform fAlbedo: vec3f;
uniform fAlbedoCompacted: vec3f;
uniform fAlbedoSteep: vec3f;
uniform fParams: vec4f; // x: exposure, y: debug view, z: level count, w: show substrate window
// x: relief strength, y: base roughness, z: subsurface strength, w: dual-lobe mix.
uniform fSurface: vec4f;
uniform fSubsurfaceTint: vec3f;
// x: glints per square metre, y: glint lattice basis, z: glint strength, w: emissive gain.
uniform fGrain: vec4f;
/// x: light-pool strength, y: its radius in metres.
uniform fPool: vec2f;

/// Packed material is smoother than the loose material it was made from, so a print in
/// snow catches a highlight the powder around it does not. One more thing the compaction
/// channel earns without a new parameter.
const SB_PACKED_SMOOTH: f32 = 0.6;

const SB_DEBUG_NORMALS: f32 = 1.0;
const SB_DEBUG_RINGS: f32 = 2.0;
const SB_DEBUG_MORPH: f32 = 3.0;
const SB_DEBUG_DEPTH: f32 = 4.0;
const SB_DEBUG_SLOPE: f32 = 5.0;
const SB_DEBUG_SKY_IRRADIANCE: f32 = 6.0;
const SB_DEBUG_AERIAL: f32 = 7.0;
const SB_DEBUG_CASCADES: f32 = 8.0;
const SB_DEBUG_SHADOW_MAP: f32 = 9.0;
const SB_DEBUG_SUB_DEPRESSION: f32 = 10.0;
const SB_DEBUG_SUB_MASS: f32 = 11.0;
const SB_DEBUG_SUB_COMPACTION: f32 = 12.0;
const SB_DEBUG_SUB_PHASE: f32 = 13.0;
const SB_DEBUG_SURF_SPECULAR: f32 = 14.0;
const SB_DEBUG_SURF_ROUGHNESS: f32 = 15.0;
const SB_DEBUG_SURF_SUBSURFACE: f32 = 16.0;
const SB_DEBUG_SURF_GLINTS: f32 = 17.0;
const SB_DEBUG_WIND: f32 = 18.0;
const SB_DEBUG_AIRBORNE: f32 = 19.0;
const SB_DEBUG_HEAT: f32 = 20.0;
const SB_DEBUG_FUEL: f32 = 21.0;

/// Full scale for the metric substrate channels, in metres. A 25 cm hollow saturates.
const SB_SUB_FULL_SCALE: f32 = 0.25;

fn sbHue(t: f32) -> vec3f {
    return 0.5 + 0.5 * cos(6.2831853 * (t + vec3f(0.0, 0.33, 0.67)));
}

/// Signed channels as red-below / blue-above against a dark neutral, so that zero is a
/// value you can see rather than black — which is also what an unbound buffer looks like.
fn sbSignedRamp(v: f32) -> vec3f {
    let t = clamp(v / SB_SUB_FULL_SCALE, -1.0, 1.0);
    return vec3f(0.06) + vec3f(max(t, 0.0), 0.0, max(-t, 0.0));
}

// SINGLE EXIT POINT, DELIBERATELY.
//
// Babylon's WGSL processor keeps the `-> FragmentOutputs` signature and appends
// `return fragmentOutputs;` to the end of main. A bare `return;` anywhere inside is
// therefore invalid WGSL — a function with a return type cannot return nothing — and
// the whole shader fails to compile. Debug views branch into a variable, never out
// of the function.
@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let toEye = input.vWorld - uniforms.fCameraPos;
    let dist = length(toEye);
    let viewDir = toEye / max(dist, 1e-4);

    // ONE substrate read, feeding the normal, the albedo and every debug view. Nothing
    // downstream can disagree about what the ground remembers at this pixel.
    let sub = sbSubstrateAt(input.vWorld.xz);

    // The geometry normal — the surface the clipmap actually drew, and the only one the
    // shadow cascades know anything about.
    let nGeom = normalize(vec3f(-input.vDeriv.x, 1.0, -input.vDeriv.y));

    // The buffer lowers the surface, so its slope SUBTRACTS from the terrain's. This is
    // the whole of Phase 4 pass A: the geometry is untouched — a 24 cm print is three
    // clipmap vertices at best — but the surface it describes is not, and light does not
    // care which of the two it was told about.
    let relief = uniforms.fSurface.x * sbReliefFade(dist);
    let deriv = input.vDeriv - sub.slope * relief;
    let n = normalize(vec3f(-deriv.x, 1.0, -deriv.y));

    let debug = uniforms.fParams.y;
    let exposure = uniforms.fParams.x;

    let l = normalize(uniforms.sbSunDir);
    // Sun visibility. Computed once, outside the debug chain, so `cascades` and
    // `shadowMap` show exactly what the beauty path is using rather than a second
    // evaluation that could differ.
    //
    // THE GEOMETRY NORMAL, NOT THE BENT ONE. shVisibility offsets its lookup along the
    // normal by a couple of shadow texels — that is what keeps steep slopes free of
    // acne. The cascades render undisplaced ground and have never heard of a footprint,
    // so feeding them a normal that swings 30 degrees over 12 cm just scatters the
    // lookup position and comes back as blocks in the shadowed area. The offset has to
    // be computed against the surface that was actually rasterised.
    let shadow = shVisibility(input.vWorld, nGeom, dot(nGeom, l), dist);
    let rawNdl = dot(n, l);

    // Distances are metres here and kilometres in the atmosphere model.
    let transmittance = sbAerial(dist * 0.001);

    // Steep faces expose the hard material underneath. A stand-in for the triplanar
    // blend, but driven by the same slope the real one will use.
    //
    // Off the TERRAIN's own normal, not the one the substrate has bent. The rock blend
    // is about landform — where a hillside is steep enough to shed loose material — and
    // the wall of a 20 cm footprint is not a cliff. Reading it off `n` would paint
    // outcrop around every deep carve.
    let rock = smoothstep(0.16, 0.44, clamp(1.0 - nGeom.y, 0.0, 1.0));

    // Packed material is smoother than the loose material it came from. Compaction is
    // already driving albedo; this is the same channel doing the other half of the job,
    // and it is why a fresh print in snow catches a highlight its surroundings do not.
    let roughness = clamp(uniforms.fSurface.y * mix(1.0, SB_PACKED_SMOOTH, sub.compaction), 0.03, 1.0);
    // `viewDir` runs camera -> surface, so the eye vector is its negation.
    let specular = sbSpecularDual(n, -viewDir, l, roughness, uniforms.fSurface.w);
    let half = normalize(l - viewDir);
    let glint = sbGlints(input.vWorld.xz, n, half, uniforms.fGrain.x, uniforms.fGrain.y, dist) * uniforms.fGrain.z;

    var rgb: vec3f;

    if (debug == SB_DEBUG_NORMALS) {
        rgb = n * 0.5 + 0.5;
    } else if (debug == SB_DEBUG_RINGS) {
        // Ring level as hue. If a band jumps in steps as you walk rather than sliding,
        // the per-level snap is wrong.
        rgb = sbHue(input.vLevel / uniforms.fParams.z);
    } else if (debug == SB_DEBUG_MORPH) {
        // Should ramp 0 -> 1 smoothly inside each ring's outer band and be flat
        // elsewhere. Any hard edge here is a popping seam.
        rgb = vec3f(input.vMorph);
    } else if (debug == SB_DEBUG_DEPTH) {
        rgb = vec3f(1.0 - exp(-dist * 0.0016));
    } else if (debug == SB_DEBUG_SLOPE) {
        rgb = vec3f(rock);
    } else if (debug == SB_DEBUG_SKY_IRRADIANCE) {
        // The SH term alone, no albedo and no sun. Hollows and north faces should
        // still be lit; if they are black, the ground bounce is not reaching them.
        rgb = sbDisplay(sbShIrradiance(n) * exp2(exposure));
    } else if (debug == SB_DEBUG_SHADOW_MAP) {
        // Raw sun visibility. Acne reads as speckle on lit slopes, peter-panning as
        // a gap between a caster and its shadow, and a cascade seam as a hard line
        // across otherwise smooth ground.
        rgb = vec3f(shadow);
    } else if (debug == SB_DEBUG_CASCADES) {
        // Red, green, blue by cascade, grey past the shadow distance, darkened where
        // shadowed so the split boundaries can be checked against real shadow edges.
        rgb = shCascadeTint(dist) * (0.35 + 0.65 * shadow);
    } else if (debug == SB_DEBUG_SUB_DEPRESSION) {
        // Red is a hollow, blue is a heap. Stamp a pit and watch this: in snow it holds
        // its shape and fades over two minutes; in sand the red fills as the blue rim
        // collapses into it and both are gone in seconds; in ash it collapses and then
        // stays exactly as it is.
        rgb = sbSignedRamp(sub.depression);
    } else if (debug == SB_DEBUG_SUB_MASS) {
        // Loose material. Only what is lit up here is allowed to slump, which is why
        // undisturbed ground on a steep face does not drain downhill.
        rgb = vec3f(0.06) + vec3f(0.2, 0.9, 0.4) * clamp(sub.mass / SB_SUB_FULL_SCALE, 0.0, 1.0);
    } else if (debug == SB_DEBUG_SUB_COMPACTION) {
        rgb = vec3f(0.06) + vec3f(0.9, 0.8, 0.35) * sub.compaction;
    } else if (debug == SB_DEBUG_SUB_PHASE) {
        // Zero everywhere until Phase 6 drives it. The view exists now so that phase is
        // never the channel nobody looked at.
        rgb = vec3f(0.06) + vec3f(1.0, 0.35, 0.1) * sub.phase;
    } else if (debug == SB_DEBUG_SURF_SPECULAR) {
        // The specular lobe alone, no albedo. Sand should show a tight second lobe
        // riding inside the broad one; snow should not, because its lobe mix is zero.
        rgb = sbDisplay(specular * sbSunIrradiance() * shadow * exp2(exposure));
    } else if (debug == SB_DEBUG_SURF_ROUGHNESS) {
        // Black is mirror, white is fully rough. Footprints should read DARKER than the
        // ground around them — packed material is smoother.
        rgb = vec3f(roughness);
    } else if (debug == SB_DEBUG_SURF_SUBSURFACE) {
        // The light that went through the material and came back out, on its own. It
        // lives entirely past the terminator, so this should be black in full sun and
        // brightest on the faces turning away from it.
        let lit = sbDiffuseSss(vec3f(1.0), rawNdl, uniforms.fSubsurfaceTint, uniforms.fSurface.z);
        rgb = max(lit - vec3f(max(rawNdl, 0.0)), vec3f(0.0)) * 4.0;
    } else if (debug == SB_DEBUG_SURF_GLINTS) {
        // The facets alone. Should be scattered sparks near the camera, thinning to
        // nothing by 26 m — if it reads as a shimmering sheet the sparsity is too low,
        // and if it crawls as you walk the lattice is not world-locked.
        rgb = vec3f(clamp(glint, 0.0, 1.0));
    } else if (debug == SB_DEBUG_WIND) {
        // Surface shear as brightness, separation as red. The picture to look for is a
        // dune lit along its windward face and going dark-red just past the crest: that
        // dark band is the recirculating bubble, it is where material lands and stays,
        // and it is the whole reason a dune moves.
        let air = sbAirAt(input.vWorld.xz, input.vDeriv);
        let flow = clamp(air.shear * 0.5, 0.0, 1.0);
        rgb = vec3f(0.04) + vec3f(0.25, 0.7, 1.0) * flow * (1.0 - air.separated) + vec3f(0.9, 0.15, 0.1) * air.separated;
    } else if (debug == SB_DEBUG_AIRBORNE) {
        // What is in the air over each cell. Carve a pit in the desert with a strong
        // wind and this should stream off the rim and pool in the lee of the nearest
        // crest — if it sits still, nothing is being advected.
        let load = sbAirborneAt(input.vWorld.xz);
        rgb = vec3f(0.04) + vec3f(0.85, 0.75, 0.55) * clamp(load.density * 6.0, 0.0, 1.0);
    } else if (debug == SB_DEBUG_HEAT) {
        // Heat as a blackbody walk, so it reads the way the emissive term will: dull red,
        // orange, white. Ignite and watch it conduct outward and cool. Volcanic holds it
        // for a very long time; snow sheds it almost at once.
        let h = sbFireAt(input.vWorld.xz).heat;
        rgb = vec3f(0.04) + vec3f(1.0, 0.08 + 0.35 * h, 0.02 + 0.25 * h * h) * clamp(h * 1.4, 0.0, 1.0);
    } else if (debug == SB_DEBUG_FUEL) {
        // Phase, which is what heat is FOR. Compare it against heat above: the gap
        // between them is latent heat plus the element's phase lag, and in volcanic that
        // gap is the crust — surface set, rock beneath still molten.
        rgb = vec3f(0.04) + vec3f(0.35, 0.55, 1.0) * sbFireAt(input.vWorld.xz).phase;
    } else if (debug == SB_DEBUG_AERIAL) {
        // How much of this pixel is air. Should reach roughly 1 at the clipmap edge
        // — anywhere it does not, the terrain's own silhouette is visible against
        // the sky and Phase 2's far range has work to do.
        rgb = vec3f(1.0) - transmittance;
    } else {
        // Compaction is a DIFFERENT MATERIAL, not a darker one. Packed snow, wet sand
        // and crushed ash each carry their own albedo in the registry, and this is where
        // that number finally earns its place: walk over fresh snow and the print you
        // leave is a different colour, not just a different shape.
        let ground = mix(uniforms.fAlbedo, uniforms.fAlbedoCompacted, sub.compaction);
        let albedo = mix(ground, uniforms.fAlbedoSteep, rock);

        // The wrapped term is no longer a flat 0.18 with no tint. sbDiffuseSss widens
        // N·L by the element's own subsurface strength and tints ONLY the light the wrap
        // adds, because that is the light that actually went through the material.
        // Both terms are reflected radiance per unit irradiance, so there is still no
        // stray 1/pi and no ambient constant anywhere. Only the direct term is occluded
        // — the SH is sky, and the sky is not.
        var color = sbDiffuseSss(albedo, rawNdl, uniforms.fSubsurfaceTint, uniforms.fSurface.z) * sbSunDiffuse() * shadow + albedo * sbShIrradiance(n);

        // Specular, from the same sun. sbSunIrradiance is the perpendicular irradiance
        // Phase 2 put in the data texture for exactly this, so the highlight cannot
        // drift from the sky it is a reflection of.
        color = color + (specular + glint) * sbSunIrradiance() * shadow;

        // Emission, and the light it casts on everything near it.
        //
        // The pool is gated on the element's own emissive gain, which is a UNIFORM — so
        // snow and desert, whose gain is zero, never take the seven taps at all. Molten
        // rock lighting the ground around it is the difference between hot material and
        // a glowing decal, and the pool is what the fire debug view cannot show you.
        color = color + sbEmissive(sub.phase, uniforms.fGrain.w);
        if (uniforms.fGrain.w > 0.0 && uniforms.fPool.x > 0.0) {
            let pool = sbHeatPool(input.vWorld.xz, uniforms.fPool.y) * uniforms.fPool.x;
            // Tinted by what fully molten material glows, so the pool and the thing
            // casting it are the same colour by construction rather than by agreement.
            color = color + albedo * sbEmissive(1.0, uniforms.fGrain.w) * pool;
        }

        // Aerial perspective. Extinction over the path, in-scatter the colour the air
        // in that direction actually is.
        color = color * transmittance + sbHazeColor(viewDir) * (vec3f(1.0) - transmittance);

        // AgX by default. Phase 4's specular is physically correct and therefore
        // enormous — a glitter path at a low sun runs about twenty times over white —
        // so a curve with a shoulder is not a finishing touch here, it is the only way
        // the highlight is displayable at all.
        rgb = sbDisplay(color * exp2(exposure));
    }

    // Where the buffer reaches. Its edge ramps to zero by design so that geometry never
    // steps at the boundary — which also means the boundary is invisible, and a window
    // that has stopped following the camera looks exactly like one that is working.
    // Drawn over every view, including the debug ones, because that is when it matters.
    let wt = (input.vWorld.xz - uniforms.sbSubOrigin) / uniforms.sbSubExtent;
    let wEdge = min(min(wt.x, wt.y), min(1.0 - wt.x, 1.0 - wt.y));
    let wInside = step(0.0, wEdge) * uniforms.fParams.w;
    rgb = mix(rgb, rgb * 0.6 + vec3f(0.0, 0.18, 0.09), wInside * 0.25);
    rgb = mix(rgb, vec3f(0.1, 1.0, 0.5), smoothstep(0.015, 0.0, wEdge) * wInside * 0.8);

    fragmentOutputs.color = vec4f(rgb, 1.0);
}
