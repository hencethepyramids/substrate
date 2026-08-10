// The clipmap, from the camera, writing distance.
//
// THE SAME sbClipmapVertex THE BEAUTY PASS USES, for the same reason the shadow cast does:
// a depth buffer built from geometry a centimetre away from the shaded geometry describes
// a surface that is not on screen. Every consumer of this buffer — reprojection, circle of
// confusion — would then be answering questions about a world that was never drawn.

#include<substratePack>
#include<substrateTerrainField>
#include<substrateClipmap>

attribute position: vec3f;

uniform dpViewProj: mat4x4f;
uniform dpCameraPos: vec3f;

varying vViewDist: f32;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    let v = sbClipmapVertex(vertexInputs.position);
    vertexOutputs.vViewDist = length(v.world - uniforms.dpCameraPos);
    vertexOutputs.position = uniforms.dpViewProj * vec4f(v.world, 1.0);
}
