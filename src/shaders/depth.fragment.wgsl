// Linear view distance, in metres, for everything the camera can see.
//
// METRES, NOT CLIP-SPACE Z. A depth buffer's own z is a hyperbolic function of distance
// chosen to give near geometry more precision, which is right for occlusion and wrong for
// everything Phase 9 wants to do with it. Depth of field needs a circle of confusion,
// which is a function of metres. Temporal reprojection needs a world position, which means
// undoing the projection anyway. Heat distortion needs to know how much air a ray crossed.
// Writing the metres directly means none of those has to invert a matrix per pixel, and it
// means the value can be read and checked in units a person can reason about.
//
// R32F, so 1000 m is exact rather than nearly exact. The whole point of this buffer is to
// be the thing other passes trust.

varying vViewDist: f32;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    fragmentOutputs.color = vec4f(input.vViewDist, 0.0, 0.0, 1.0);
}
