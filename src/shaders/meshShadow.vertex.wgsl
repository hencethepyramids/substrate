// Shadow cast for an ordinary world-transformed mesh — the placeholder capsule
// today, the Phase 7 character and anything else that is not the clipmap later.
// Shares shadowCast.fragment.wgsl with the terrain, so both write depth the same way.

attribute position: vec3f;

uniform world: mat4x4f;
uniform shViewProj: mat4x4f;
uniform shTile: vec2f;

varying vShadowDepth: f32;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    let world = uniforms.world * vec4f(vertexInputs.position, 1.0);
    var clip = uniforms.shViewProj * world;

    vertexOutputs.vShadowDepth = clip.z / clip.w;

    clip.x = clip.x * uniforms.shTile.x + uniforms.shTile.y * clip.w;
    vertexOutputs.position = clip;
}
