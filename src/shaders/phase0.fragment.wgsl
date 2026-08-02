// Phase 0 placeholder surface — deleted when the Phase 1 clipmap lands.
//
// Everything here is procedural and biome-parameterised, so the biome selector has a
// visible effect from day one. It is deliberately NOT a preview of the Phase 4 material:
// no subsurface, no glints, no substrate channels. Just enough to see where you are.

varying vWorld: vec3f;
varying vNormal: vec3f;

uniform baseColor: vec3f;
uniform lineColor: vec3f;
uniform sunDir: vec3f;
uniform sunColor: vec3f;
uniform ambient: vec3f;
uniform fogColor: vec3f;
uniform cameraPos: vec3f;
// x: solid (0 = grid, 1 = flat), y: fog density, z: exposure, w: unused
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
    let l = normalize(uniforms.sunDir);

    // Wrapped diffuse. The real one arrives in Phase 4 with the subsurface term.
    let wrap = 0.35;
    let ndl = clamp((dot(n, l) + wrap) / (1.0 + wrap), 0.0, 1.0);

    var albedo = uniforms.baseColor;
    if (uniforms.params.x < 0.5) {
        let fine = gridLine(input.vWorld.xz, 1.0, 1.2) * 0.35;
        let coarse = gridLine(input.vWorld.xz, 10.0, 1.6);
        albedo = mix(albedo, uniforms.lineColor, clamp(fine + coarse, 0.0, 1.0));
    }

    var color = albedo * (uniforms.sunColor * ndl + uniforms.ambient);

    // Distance haze — the same exponential Phase 2 will drive from the atmosphere block.
    let dist = length(input.vWorld - uniforms.cameraPos);
    let fog = 1.0 - exp(-dist * uniforms.params.y);
    color = mix(color, uniforms.fogColor, clamp(fog, 0.0, 1.0));

    color = color * exp2(uniforms.params.z);

    // Placeholder transfer only. Phase 9 replaces this with AgX in the post chain.
    fragmentOutputs.color = vec4f(pow(max(color, vec3f(0.0)), vec3f(1.0 / 2.2)), 1.0);
}
