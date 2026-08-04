// The cloak.
//
// No skinning and no world matrix: the cloth solver works in world space already, so the
// vertex buffer holds finished positions and this only has to project them. That is also
// why the shadow cast can use the shared world-transform pass without an override — the
// world matrix it multiplies by is the identity, which is exactly right here.
//
// It writes the same three varyings figure.vertex.wgsl does, because it shares that
// shader's FRAGMENT. One reflectance model, one display transfer, one set of shadows for
// the figure and the cloth over it — a cape lit differently from the shoulders it hangs
// off is the tell that two paths exist.

attribute position: vec3f;
attribute normal: vec3f;

uniform viewProjection: mat4x4f;

varying vWorld: vec3f;
varying vNormal: vec3f;
varying vMaterial: f32;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    vertexOutputs.vWorld = vertexInputs.position;
    vertexOutputs.vNormal = vertexInputs.normal;
    // Always the clothed material. A cloak has no bare side.
    vertexOutputs.vMaterial = 0.0;
    vertexOutputs.position = uniforms.viewProjection * vec4f(vertexInputs.position, 1.0);
}
