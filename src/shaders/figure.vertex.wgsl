// The character, skinned.
//
// There is no world matrix here on purpose. The bone palette already carries the root
// transform, so a second one would be a second place the figure could be positioned
// from — and the day those two disagree is the day the shadow walks somewhere else.

#include<substrateSkin>

/// Rest pose, character space: feet at the origin, +Y up, +Z forward.
attribute position: vec3f;
attribute normal: vec3f;
/// (boneA, boneB, weight of B, material id).
attribute skin: vec4f;

uniform viewProjection: mat4x4f;

varying vWorld: vec3f;
varying vNormal: vec3f;
varying vMaterial: f32;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    let world = skSkinPoint(vertexInputs.skin, vertexInputs.position);
    vertexOutputs.vWorld = world;
    vertexOutputs.vNormal = skSkinAxis(vertexInputs.skin, vertexInputs.normal);
    // Constant across a face, so the interpolator carries it exactly.
    vertexOutputs.vMaterial = vertexInputs.skin.w;
    vertexOutputs.position = uniforms.viewProjection * vec4f(world, 1.0);
}
