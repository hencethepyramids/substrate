// The character's shadow cast.
//
// SKINNED FROM THE SAME INCLUDE THE BEAUTY PASS USES. The cast cannot go through
// meshShadow.vertex.wgsl, which transforms by a world matrix: the figure has no world
// matrix, its pose lives entirely in the bone palette, and a cast that ignored the
// palette would draw the shadow of a T-pose standing at the origin while the character
// walked away from it.
//
// Shares shadowCast.fragment.wgsl with the terrain, so all three write depth the same way.

#include<substrateSkin>

attribute position: vec3f;
attribute skin: vec4f;

uniform shViewProj: mat4x4f;
uniform shTile: vec2f;

varying vShadowDepth: f32;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    let world = skSkinPoint(vertexInputs.skin, vertexInputs.position);
    var clip = uniforms.shViewProj * vec4f(world, 1.0);

    vertexOutputs.vShadowDepth = clip.z / clip.w;

    clip.x = clip.x * uniforms.shTile.x + uniforms.shTile.y * clip.w;
    vertexOutputs.position = clip;
}
