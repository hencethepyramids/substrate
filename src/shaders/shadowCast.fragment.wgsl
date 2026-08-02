// Shadow cast target: light-space depth, linear in [0,1] because the projection is
// orthographic. R32F, sampled with nearest — PCSS reads real blocker depths and
// averages them itself, so there is nothing for hardware filtering to do.

varying vShadowDepth: f32;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    fragmentOutputs.color = vec4f(input.vShadowDepth, 0.0, 0.0, 1.0);
}
