// Phase 1 terrain shading. Deliberately thin: Phase 2 replaces the lighting with the
// analytic sky and cascaded shadows, and Phase 4 replaces the material with the
// uber-shader that reads the substrate channels. What is real here is the normal,
// which comes from the analytic derivative baked alongside the height.

varying vWorld: vec3f;
varying vDeriv: vec2f;
varying vLevel: f32;
varying vMorph: f32;

uniform fCameraPos: vec3f;
uniform fSunDir: vec3f;
uniform fSunColor: vec3f;
uniform fAmbient: vec3f;
uniform fFogColor: vec3f;
uniform fAlbedo: vec3f;
uniform fAlbedoSteep: vec3f;
uniform fParams: vec4f; // x: fog density, y: exposure, z: debug view, w: level count

const SB_DEBUG_OFF: f32 = 0.0;
const SB_DEBUG_NORMALS: f32 = 1.0;
const SB_DEBUG_RINGS: f32 = 2.0;
const SB_DEBUG_MORPH: f32 = 3.0;
const SB_DEBUG_DEPTH: f32 = 4.0;
const SB_DEBUG_SLOPE: f32 = 5.0;

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
    let dist = length(input.vWorld - uniforms.fCameraPos);
    let debug = uniforms.fParams.z;

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
        rgb = sbHue(input.vLevel / uniforms.fParams.w);
    } else if (debug == SB_DEBUG_MORPH) {
        // Should ramp 0 -> 1 smoothly inside each ring's outer band and be flat
        // elsewhere. Any hard edge here is a popping seam.
        rgb = vec3f(input.vMorph);
    } else if (debug == SB_DEBUG_DEPTH) {
        rgb = vec3f(1.0 - exp(-dist * 0.0016));
    } else if (debug == SB_DEBUG_SLOPE) {
        rgb = vec3f(rock);
    } else {
        let albedo = mix(uniforms.fAlbedo, uniforms.fAlbedoSteep, rock);

        let l = normalize(uniforms.fSunDir);
        let wrap = 0.35;
        let ndl = clamp((dot(n, l) + wrap) / (1.0 + wrap), 0.0, 1.0);

        // A cheap sky-occlusion stand-in: hollows see less sky than crests. Phase 2
        // replaces it with real SH irradiance and the ground-bounce term.
        let openness = 0.55 + 0.45 * n.y;

        var color = albedo * (uniforms.fSunColor * ndl + uniforms.fAmbient * openness);

        let fog = 1.0 - exp(-dist * uniforms.fParams.x);
        color = mix(color, uniforms.fFogColor, clamp(fog, 0.0, 1.0));
        color = color * exp2(uniforms.fParams.y);

        // Placeholder transfer. Phase 9 replaces this with AgX in the post chain.
        rgb = pow(max(color, vec3f(0.0)), vec3f(1.0 / 2.2));
    }

    fragmentOutputs.color = vec4f(rgb, 1.0);
}
