// Phase 0 placeholder surface — deleted when the Phase 1 clipmap lands.
// Its job is to prove the hand-written WGSL path end to end on the WebGPU engine:
// custom uniforms, varyings, isReady() gating and pipeline warm-up.

attribute position: vec3f;
attribute normal: vec3f;

uniform world: mat4x4f;
uniform viewProjection: mat4x4f;

varying vWorld: vec3f;
varying vNormal: vec3f;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    let worldPos = uniforms.world * vec4f(vertexInputs.position, 1.0);
    vertexOutputs.vWorld = worldPos.xyz;
    vertexOutputs.vNormal = (uniforms.world * vec4f(vertexInputs.normal, 0.0)).xyz;
    vertexOutputs.position = uniforms.viewProjection * worldPos;
}
