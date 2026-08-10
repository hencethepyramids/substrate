// Anything with an ordinary world matrix — the cloak, whose Verlet solver already works
// in world space, so the matrix is identity and this is the cheapest of the three.

attribute position: vec3f;

uniform world: mat4x4f;
uniform dpViewProj: mat4x4f;
uniform dpCameraPos: vec3f;

varying vViewDist: f32;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    let world = uniforms.world * vec4f(vertexInputs.position, 1.0);
    vertexOutputs.vViewDist = length(world.xyz - uniforms.dpCameraPos);
    vertexOutputs.position = uniforms.dpViewProj * world;
}
