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

varying vWorld: vec3f;
varying vDeriv: vec2f;
varying vLevel: f32;
varying vMorph: f32;

uniform fCameraPos: vec3f;
uniform fAlbedo: vec3f;
uniform fAlbedoSteep: vec3f;
uniform fParams: vec4f; // x: exposure, y: debug view, z: level count, w: unused

const SB_DEBUG_NORMALS: f32 = 1.0;
const SB_DEBUG_RINGS: f32 = 2.0;
const SB_DEBUG_MORPH: f32 = 3.0;
const SB_DEBUG_DEPTH: f32 = 4.0;
const SB_DEBUG_SLOPE: f32 = 5.0;
const SB_DEBUG_SKY_IRRADIANCE: f32 = 6.0;
const SB_DEBUG_AERIAL: f32 = 7.0;
const SB_DEBUG_CASCADES: f32 = 8.0;
const SB_DEBUG_SHADOW_MAP: f32 = 9.0;

fn sbHue(t: f32) -> vec3f {
    return 0.5 + 0.5 * cos(6.2831853 * (t + vec3f(0.0, 0.33, 0.67)));
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
    let n = normalize(vec3f(-input.vDeriv.x, 1.0, -input.vDeriv.y));

    let toEye = input.vWorld - uniforms.fCameraPos;
    let dist = length(toEye);
    let viewDir = toEye / max(dist, 1e-4);

    let debug = uniforms.fParams.y;
    let exposure = uniforms.fParams.x;

    let l = normalize(uniforms.sbSunDir);
    let rawNdl = dot(n, l);
    // Sun visibility. Computed once, outside the debug chain, so `cascades` and
    // `shadowMap` show exactly what the beauty path is using rather than a second
    // evaluation that could differ.
    let shadow = shVisibility(input.vWorld, n, rawNdl, dist);

    // Distances are metres here and kilometres in the atmosphere model.
    let transmittance = sbAerial(dist * 0.001);

    // Steep faces expose the hard material underneath. A stand-in for the Phase 4
    // triplanar blend, but driven by the same slope the real one will use.
    let slope = clamp(1.0 - n.y, 0.0, 1.0);
    let rock = smoothstep(0.16, 0.44, slope);

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
        rgb = pow(max(sbShIrradiance(n) * exp2(exposure), vec3f(0.0)), vec3f(1.0 / 2.2));
    } else if (debug == SB_DEBUG_SHADOW_MAP) {
        // Raw sun visibility. Acne reads as speckle on lit slopes, peter-panning as
        // a gap between a caster and its shadow, and a cascade seam as a hard line
        // across otherwise smooth ground.
        rgb = vec3f(shadow);
    } else if (debug == SB_DEBUG_CASCADES) {
        // Red, green, blue by cascade, grey past the shadow distance, darkened where
        // shadowed so the split boundaries can be checked against real shadow edges.
        rgb = shCascadeTint(dist) * (0.35 + 0.65 * shadow);
    } else if (debug == SB_DEBUG_AERIAL) {
        // How much of this pixel is air. Should reach roughly 1 at the clipmap edge
        // — anywhere it does not, the terrain's own silhouette is visible against
        // the sky and Phase 2's far range has work to do.
        rgb = vec3f(1.0) - transmittance;
    } else {
        let albedo = mix(uniforms.fAlbedo, uniforms.fAlbedoSteep, rock);

        // Snow does want a wrapped term — light does travel through it — but 0.35 at a
        // 12 degree sun flattened every dune face into the same value. Phase 4's real
        // subsurface earns back the softness; until then, definition matters more.
        let wrap = 0.18;
        let ndl = clamp((rawNdl + wrap) / (1.0 + wrap), 0.0, 1.0);

        // Both terms are already Lambertian reflected radiance per unit albedo, so
        // there is no stray 1/pi and no ambient constant to tune. The sky and the
        // bounce arrive together in the SH term, which is the whole point: a north
        // face under a low sun is lit by a hemisphere of snowfield, not by a number.
        // Only the direct term is occluded — the SH is sky, and the sky is not.
        var color = albedo * (sbSunDiffuse() * ndl * shadow + sbShIrradiance(n));

        // Aerial perspective. Extinction over the path, in-scatter the colour the air
        // in that direction actually is.
        color = color * transmittance + sbHazeColor(viewDir) * (vec3f(1.0) - transmittance);

        color = color * exp2(exposure);

        // Placeholder transfer. Phase 9 replaces this with AgX in the post chain.
        rgb = pow(max(color, vec3f(0.0)), vec3f(1.0 / 2.2));
    }

    fragmentOutputs.color = vec4f(rgb, 1.0);
}
