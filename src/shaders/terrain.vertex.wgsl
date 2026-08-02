// Nested-ring geometry clipmap. One static mesh, one draw call, ~324k triangles.
//
// The vertex buffer carries (gridIndex, ringLevel) and nothing else — no world
// positions, no normals, no UVs. Everything is computed in substrateClipmap, which
// the shadow cascades include too so the two passes cannot disagree about where a
// vertex is.

#include<substratePack>
#include<substrateTerrainField>
#include<substrateClipmap>

// position is a carrier, not a position: (gridX, ringLevel, gridZ).
attribute position: vec3f;

uniform viewProjection: mat4x4f;

varying vWorld: vec3f;
varying vDeriv: vec2f;
varying vLevel: f32;
varying vMorph: f32;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    let v = sbClipmapVertex(vertexInputs.position);

    vertexOutputs.vWorld = v.world;
    vertexOutputs.vDeriv = v.deriv;
    vertexOutputs.vLevel = v.level;
    vertexOutputs.vMorph = v.morph;

    var clip = uniforms.viewProjection * vec4f(v.world, 1.0);

    // Each ring's hole is built one cell small, so consecutive levels overlap by a
    // cell or two rather than ever leaving a gap — see clipmapMesh.ts. In that band
    // the two levels are coincident and coplanar, so bias finer levels toward the
    // camera to give the depth test something to decide on.
    clip.z = clip.z - (uniforms.tLevels - v.level) * 2.0e-6 * clip.w;

    vertexOutputs.position = clip;
}
