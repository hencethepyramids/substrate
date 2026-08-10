// A thrown load, drawn as a camera-facing quad.
//
// WHY A BILLBOARD AND NOT A SPHERE. A snowball leaving the hand is about 30 cm across and
// spends most of its flight far enough away to cover a handful of pixels. A real sphere
// would be a few hundred triangles to describe a shape the fragment shader can imply for
// nothing — the normal of a sphere seen head on is recoverable from the disc coordinate
// alone, which is what the fragment stage does. Zero assets, and the geometry cost is four
// vertices per projectile whether one is in the air or none are.
//
// PER-PROJECTILE DATA COMES THROUGH THE VERTEX BUFFER rather than through a uniform array.
// Both work; this one avoids depending on how a WGSL uniform array is laid out and packed,
// which is exactly the class of thing that compiles, runs, and quietly puts the second
// projectile somewhere wrong. The CPU writes each projectile's world position into all four
// of its vertices every frame, so the buffer is the transform and there is nothing to get
// out of step.

attribute position: vec3f;
/// x: which corner of the quad, 0 to 3. y: radius in metres, and zero means "not in the
/// air" — a degenerate quad, which costs nothing and needs no branch anywhere.
attribute uv: vec2f;

uniform viewProjection: mat4x4f;
uniform tpCamRight: vec3f;
uniform tpCamUp: vec3f;

varying vDisc: vec2f;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    // Corner index to a signed offset: 0,1,2,3 -> (-1,-1), (1,-1), (-1,1), (1,1).
    let c = vertexInputs.uv.x;
    let offset = vec2f(select(-1.0, 1.0, c == 1.0 || c == 3.0), select(-1.0, 1.0, c >= 2.0));
    vertexOutputs.vDisc = offset;

    let radius = vertexInputs.uv.y;
    let world = vertexInputs.position + (uniforms.tpCamRight * offset.x + uniforms.tpCamUp * offset.y) * radius;
    vertexOutputs.position = uniforms.viewProjection * vec4f(world, 1.0);
}
