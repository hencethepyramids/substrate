// The clipmap, from the sun. Same displacement as the beauty pass — literally the
// same function, out of substrateClipmap — because a shadow map built from geometry
// that sits even a centimetre away from the shaded geometry produces thin crawling
// stripes of self-shadowing that no amount of bias tuning removes.
//
// All three cascades share one atlas texture and one draw per cascade. Rather than
// ask for a viewport per pass, each cascade squeezes its clip-space x into its own
// third of the target: scale 1/3, offset -2/3, 0, +2/3. The depth buffer is shared,
// which is harmless because the thirds are disjoint in x, so no pixel belongs to
// two cascades.

#include<substratePack>
#include<substrateTerrainField>
#include<substrateClipmap>

attribute position: vec3f;

/// Light view-projection for the cascade being rendered.
uniform shViewProj: mat4x4f;
/// x: clip-space x scale, y: clip-space x offset. The atlas tiling.
uniform shTile: vec2f;

varying vShadowDepth: f32;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    let v = sbClipmapVertex(vertexInputs.position);

    var clip = uniforms.shViewProj * vec4f(v.world, 1.0);

    // Orthographic, so w is 1 and z is already linear in [0,1]. Carry it as a
    // varying rather than reading it back off the depth buffer: PCSS needs real
    // blocker depths, not a comparison result.
    vertexOutputs.vShadowDepth = clip.z / clip.w;

    clip.x = clip.x * uniforms.shTile.x + uniforms.shTile.y * clip.w;
    vertexOutputs.position = clip;
}
