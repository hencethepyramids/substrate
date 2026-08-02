// Fullscreen triangle for the sky. Three vertices, drawn before anything else with
// the depth test forced to pass and depth writes off, so terrain simply paints over
// it. That avoids every far-plane and infinite-distance question a skybox mesh
// raises, and it costs one screen of overdraw.
//
// `position` is already in NDC and goes straight out. The ray basis comes from the
// camera's own yaw, pitch and field of view rather than from an inverted
// view-projection matrix: Babylon does not compute the view matrix until inside
// scene.render(), so an inverse taken at uniform-push time would be one frame stale
// and the sky would visibly lag a fast turn.
//
// PHASE 9, READ THIS. Babylon appends `vertexOutputs.position.y *= yFactor_` to every
// vertex main, and yFactor_ is 1 for the canvas and -1 for a render target. vRay is
// derived from the INPUT position, so it does not follow that flip: the moment the
// scene renders into an offscreen target for the post chain, the sky arrives upside
// down relative to its geometry. Fix it there by flipping vRay's up component with
// the same factor, not by rotating the triangle.

attribute position: vec3f;

/// Camera basis, pre-scaled by the half-extents of the near plane.
uniform skRight: vec3f;
uniform skUp: vec3f;
uniform skForward: vec3f;

varying vRay: vec3f;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    let ndc = vertexInputs.position.xy;

    vertexOutputs.vRay = uniforms.skForward + ndc.x * uniforms.skRight + ndc.y * uniforms.skUp;
    vertexOutputs.position = vec4f(ndc, 1.0, 1.0);
}
