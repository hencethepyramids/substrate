// Phase 0 placeholder surface — deleted when the Phase 7 character lands.
//
// Deliberately NOT a preview of the Phase 4 material: no subsurface, no glints, no
// substrate channels. But it is lit by exactly the same sky the terrain is, through
// the same include, because a capsule shaded by a different ambient than the ground
// it stands on is how you end up trusting the wrong one.

#include<substrateSkyMap>
#include<substrateSkyLut>
#include<substrateSh>
#include<substrateSkyData>

varying vWorld: vec3f;
varying vNormal: vec3f;

uniform baseColor: vec3f;
uniform lineColor: vec3f;
uniform cameraPos: vec3f;
// x: solid (0 = grid, 1 = flat), y: exposure, z: unused, w: unused
uniform params: vec4f;

/// Screen-space-antialiased grid, one line every `spacing` metres.
fn gridLine(p: vec2f, spacing: f32, width: f32) -> f32 {
    let c = p / spacing;
    let d = max(fwidth(c), vec2f(1e-5));
    let g = abs(fract(c - 0.5) - 0.5) / d;
    let line = 1.0 - smoothstep(0.0, width, min(g.x, g.y));
    // Fade the grid out once a cell covers less than a few pixels. Without this the
    // lines merge into a flat wash at grazing angles and the ground reads as solid.
    let fade = 1.0 - smoothstep(0.5, 2.0, max(d.x, d.y));
    return line * fade;
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let n = normalize(input.vNormal);
    let l = normalize(uniforms.sbSunDir);

    // Wrapped diffuse. The real one arrives in Phase 4 with the subsurface term.
    let wrap = 0.35;
    let ndl = clamp((dot(n, l) + wrap) / (1.0 + wrap), 0.0, 1.0);

    var albedo = uniforms.baseColor;
    if (uniforms.params.x < 0.5) {
        let fine = gridLine(input.vWorld.xz, 1.0, 1.2) * 0.35;
        let coarse = gridLine(input.vWorld.xz, 10.0, 1.6);
        albedo = mix(albedo, uniforms.lineColor, clamp(fine + coarse, 0.0, 1.0));
    }

    var color = albedo * (sbSunDiffuse() * ndl + sbShIrradiance(n));

    let toEye = input.vWorld - uniforms.cameraPos;
    let dist = length(toEye);
    let viewDir = toEye / max(dist, 1e-4);
    let transmittance = sbAerial(dist * 0.001);
    color = color * transmittance + sbHazeColor(viewDir) * (vec3f(1.0) - transmittance);

    color = color * exp2(uniforms.params.y);

    // Placeholder transfer only. Phase 9 replaces this with AgX in the post chain.
    fragmentOutputs.color = vec4f(pow(max(color, vec3f(0.0)), vec3f(1.0 / 2.2)), 1.0);
}
