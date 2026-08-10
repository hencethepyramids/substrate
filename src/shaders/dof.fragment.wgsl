// Depth of field — a real lens, not a depth-keyed blur.
//
// THE CIRCLE OF CONFUSION IS THE WHOLE THING. A point at distance d images as a disc on
// the sensor unless d is exactly the focus distance, and the diameter of that disc is
// A*f/(F-f) * |d-F|/d, where A is the aperture diameter, f the focal length and F the
// focus distance. Every term in that is a property of the camera, and this project already
// has the field of view, so the only thing a person has to choose is the f-number. Which
// is exactly the choice a camera operator makes.
//
// A blur radius keyed off depth by hand would need retuning every time the field of view
// changed, and would be wrong in the specific way that reads as fake: the near field and
// the far field would fall off symmetrically. They do not. `|d-F|/d` saturates as d grows
// — everything past a few focus distances shares one blur, which is why a landscape goes
// uniformly soft — while the near side has no such limit and blows up fast as d falls
// toward the lens.
//
// SCATTER AS GATHER. Physically a bright out-of-focus point SCATTERS its light over a
// disc. A shader cannot scatter, so this gathers: for each output pixel, look at the taps
// around it and take a tap only if that tap's OWN circle of confusion is wide enough to
// have reached here. That test is what keeps a sharp foreground from smearing into a
// blurred background, which is the single artefact that gives cheap depth of field away.

varying vUV: vec2f;

/// The scene, at full resolution.
var textureSamplerSampler: sampler;
var textureSampler: texture_2d<f32>;

/// Linear view distance in metres, from the depth pass.
var dfDepthSampler: sampler;
var dfDepth: texture_2d<f32>;

/// x: focus distance in metres. y: aperture diameter over (focus - focal), the whole
/// constant in front of the circle-of-confusion formula, already converted to pixels.
/// z: the largest circle of confusion worth gathering, in pixels of THIS buffer.
/// w: focal length in metres, so a subject nearer than the lens cannot divide by zero.
uniform dfLens: vec4f;

/// This pass's own texel.
uniform dfTexel: vec2f;

/// Ceiling on a gathered tap, in scene-referred units. Third time this phase, same cause:
/// the sun disc is drawn as irradiance over its solid angle and lands near 59,000, and no
/// affordable number of taps can represent a delta function spread across a disc — 32 taps
/// of it come out as a visible flower of 32 overlapping discs. Soft-clipped rather than
/// hard, so the brightest bokeh in the frame is still the brightest bokeh in the frame.
uniform dfCeiling: f32;

/// Taps in the gather disc. 32 on a golden-angle spiral covers a disc about as evenly as
/// anything of this size and, unlike a grid, degrades into noise rather than into rings
/// when it is undersampled.
const DF_TAPS: i32 = 32;
const DF_GOLDEN: f32 = 2.39996323;

/// Diameter of the circle of confusion at a given distance, in pixels of this buffer.
fn dfCoc(dist: f32) -> f32 {
    let focus = uniforms.dfLens.x;
    // Sky and anything past it sit at the far limit rather than at some enormous number.
    let d = min(dist, 1.0e5);
    return uniforms.dfLens.y * abs(d - focus) / max(d, uniforms.dfLens.w * 1.001);
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let maxCoc = uniforms.dfLens.z;
    let centreCoc = min(dfCoc(textureSample(dfDepth, dfDepthSampler, input.vUV).r), maxCoc);

    // ROTATE THE SPIRAL PER PIXEL. Thirty-two taps over a sixteen-pixel disc is coarse, and
    // on a point source as bright as the sun it shows: every pixel samples the same
    // thirty-two angles, so the discs line up across the neighbourhood into a flower with
    // thirty-two petals. Giving each pixel its own rotation costs one hash and turns the
    // petals into noise, which is what the eye — and later a temporal pass — can actually
    // resolve. Integer hash, not fract(sin(x)*k), for the reason in lib/shadow.wgsl.
    let px = vec2i(floor(input.vUV / uniforms.dfTexel));
    var seed = (u32(px.x) * 0x9e3779b9u) ^ (u32(px.y) * 0x85ebca6bu);
    seed ^= seed >> 15u;
    seed *= 0x2c1b3c6du;
    seed ^= seed >> 12u;
    let spin = f32(seed & 0xffffffu) * (6.2831853 / 16777216.0);

    var colour = vec3f(0.0);
    var weight = 0.0;

    for (var i = 0; i < DF_TAPS; i = i + 1) {
        // Golden-angle spiral: radius grows as sqrt so the samples are area-uniform, which
        // matters because a disc's area is where its light is.
        let t = (f32(i) + 0.5) / f32(DF_TAPS);
        let r = sqrt(t);
        let a = f32(i) * DF_GOLDEN + spin;
        let offset = vec2f(cos(a), sin(a)) * r * maxCoc;
        let uv = input.vUV + offset * uniforms.dfTexel;

        let tapCoc = min(dfCoc(textureSample(dfDepth, dfDepthSampler, uv).r), maxCoc);
        let reach = length(offset);

        // THE TEST. A tap contributes only if its own circle of confusion is wide enough
        // to have scattered this far. `centreCoc` is in there too so that a blurred pixel
        // still collects from its sharp neighbours — without it, a blurred background
        // beside a sharp subject would collect nothing and go black at the seam.
        let spread = max(tapCoc, centreCoc);
        // Half a pixel of softness on the edge of the disc, so the boundary between
        // contributing and not does not become a visible ring.
        let w = smoothstep(reach + 0.5, reach - 0.5, spread * 0.5);

        let tap = textureSample(textureSampler, textureSamplerSampler, uv).rgb;
        colour = colour + (tap * uniforms.dfCeiling / (uniforms.dfCeiling + tap)) * w;
        weight = weight + w;
    }

    // The centre always contributes, so `weight` cannot reach zero.
    fragmentOutputs.color = vec4f(colour / max(weight, 1.0e-4), centreCoc);
}
