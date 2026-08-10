// The figure, from the camera, writing distance. Skinned from the same palette the
// beauty pass uses — a depth buffer of a pose the character is not in is worse than none.

#include<substrateSkin>

attribute position: vec3f;
attribute skin: vec4f;

uniform dpViewProj: mat4x4f;
uniform dpCameraPos: vec3f;

varying vViewDist: f32;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    let world = skSkinPoint(vertexInputs.skin, vertexInputs.position);
    vertexOutputs.vViewDist = length(world - uniforms.dpCameraPos);
    vertexOutputs.position = uniforms.dpViewProj * vec4f(world, 1.0);
}
