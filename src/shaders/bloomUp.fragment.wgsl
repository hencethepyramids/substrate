// One step back up the bloom pyramid.
//
// A 3x3 tent, again from the Advanced Warfare talk. The temptation is a bilinear
// upsample, and it is a trap: bilinear reconstruction of a pyramid leaves box-shaped
// structure at every level, and those boxes stack into visible square banding around
// bright objects. The tent is the smallest filter that does not.
//
// Each level adds itself to what came from below, so the final halo is the sum of every
// octave — a tight core from the top levels and a broad wash from the bottom ones. That
// sum is what makes bloom read as scatter rather than as blur.

varying vUV: vec2f;

/// The level below this one, already upsampled. Auto-bound by the chain.
var textureSamplerSampler: sampler;
var textureSampler: texture_2d<f32>;

/// This level's own downsample, bound explicitly.
var bmLowerSampler: sampler;
var bmLower: texture_2d<f32>;

/// One texel of the lower-resolution SOURCE, which sets the tent's radius.
uniform bmTexel: vec2f;

fn tap(uv: vec2f, dx: f32, dy: f32) -> vec3f {
    return textureSample(textureSampler, textureSamplerSampler, uv + vec2f(dx, dy) * uniforms.bmTexel).rgb;
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let uv = input.vUV;

    // 1 2 1
    // 2 4 2  / 16
    // 1 2 1
    var sum = tap(uv, -1.0, 1.0);
    sum = sum + tap(uv, 0.0, 1.0) * 2.0;
    sum = sum + tap(uv, 1.0, 1.0);
    sum = sum + tap(uv, -1.0, 0.0) * 2.0;
    sum = sum + tap(uv, 0.0, 0.0) * 4.0;
    sum = sum + tap(uv, 1.0, 0.0) * 2.0;
    sum = sum + tap(uv, -1.0, -1.0);
    sum = sum + tap(uv, 0.0, -1.0) * 2.0;
    sum = sum + tap(uv, 1.0, -1.0);
    let lower = sum * (1.0 / 16.0);

    let here = textureSample(bmLower, bmLowerSampler, uv).rgb;

    // Averaged rather than added. Adding doubles the pyramid's energy at every level, and
    // the total then depends on how many levels the window happened to be big enough for
    // — a bloom that changes strength when you resize the window is a bloom nobody can
    // tune. Averaging keeps the sum at one octave's worth however deep the pyramid goes.
    fragmentOutputs.color = vec4f((here + lower) * 0.5, 1.0);
}
