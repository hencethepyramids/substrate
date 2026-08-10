// Temporal antialiasing — the frame's edges, resolved over time rather than over area.
//
// THIS IS THE PROJECT'S ONLY ANTIALIASING, and that was decided in Phase 0. core/engine.ts
// asks for `antialias: false` with a comment promising that Phase 9 would handle edges.
// This pass is that promise. MSAA would have cost a multisampled half-float target for the
// whole frame and would still have done nothing about the two things that actually shimmer
// here: the shadow dither and the depth-of-field spiral, neither of which is a geometric
// edge. Both are stochastic, both are hashed off POSITION, and a position hash is stable
// while the camera is still and crawls the instant it moves.
//
// HOW IT WORKS, IN ONE SENTENCE. Each frame the projection is nudged by less than a pixel,
// so consecutive frames sample the scene at different points inside the same pixel; this
// pass averages the current frame into an accumulated history, and that average IS the
// supersample.
//
// WHY IT NEEDS A DEPTH BUFFER. The average is only meaningful if the history pixel being
// blended in is the SAME PIECE OF WORLD as the current one. When the camera moves it is
// not, so the history has to be reprojected: find where this pixel's surface was on screen
// last frame, and read there. Babylon's own TAA does not do this — it gives up and turns
// itself off the moment the camera moves, which is honest for a screenshot tool and
// useless for a game. Doing better normally means a velocity buffer, which means an extra
// geometry pass and a material plugin on every shader in the project.
//
// This one gets it for free instead, because Phase 9 pass E already built a depth buffer
// storing LINEAR VIEW DISTANCE. `camera + direction * distance` is the world point — the
// same reconstruction pass G validated by rendering it as a metre grid — and pushing that
// world point through LAST frame's view-projection is exactly where it used to be. No
// velocity buffer, no extra pass, and it is correct for everything that does not move.
//
// WHAT MOVES IS THE EXCEPTION, AND IT IS HANDLED BY CLAMPING. The character walks, so its
// depth reprojects as though it had stood still and the history read lands on whatever was
// behind it. That is the classic ghost — a smeared trail behind anything in motion. The
// fix is the neighbourhood clamp below: the history colour is confined to the range of
// colours actually present around this pixel THIS frame, so a history sample that
// disagrees with everything nearby gets pulled back to something plausible. It trades a
// little accumulated detail for the absence of trails, which is the right trade.
//
// WHY IT RUNS AFTER THE TONEMAP. This pass sits between the composite and the finish, so
// the colour arriving here is display-referred and inside 0..1. That is deliberate and it
// is about the sun. Three separate filters this phase have been broken by the same fact:
// the sun disc is drawn as irradiance over its solid angle and lands near 59,000 against a
// sky of order ten. A min/max box over linear radiance containing that one sample is
// useless — the box spans five orders of magnitude and clamps nothing. After the curve the
// sun is 1.0 and the sky is 0.8, the box is meaningful, and the blend cannot be dominated
// by a single bright sample. The cost is that the average is of display values rather than
// of radiance, which is not energy-correct across an edge; every engine that ships TAA
// makes this same trade, and after AgX's shoulder the difference is well under a bit.

varying vUV: vec2f;

/// The composited frame, display-referred. Bound by the chain, not by hand: this is the
/// one pass in the whole chain where "the previous pass's output" is exactly what is
/// wanted, so it is the one pass that does not set `externalTextureSamplerBinding`.
var textureSamplerSampler: sampler;
var textureSampler: texture_2d<f32>;

/// Last frame's resolved output. Bilinear, because reprojection lands between texels.
var taaHistorySampler: sampler;
var taaHistory: texture_2d<f32>;

/// Linear view distance in metres, from the depth pass.
var taaDepthSampler: sampler;
var taaDepth: texture_2d<f32>;

/// Last frame's world-to-clip, jitter included — which is why `taaParams.zw` exists to
/// take it back out again. See the note at the reprojection below; this being the jittered
/// matrix is a fact about where it came from, not a choice.
uniform taaPrevViewProj: mat4x4f;

/// The camera basis, for turning a pixel and a distance back into a world point.
uniform taaCamPos: vec3f;
uniform taaCamRight: vec3f;
uniform taaCamUp: vec3f;
uniform taaCamFwd: vec3f;

/// x: tan of half the vertical field of view. y: aspect ratio.
uniform taaLens: vec2f;

/// x: how much of the CURRENT frame to keep, so 1 means no history at all. y: non-zero
/// shows the reprojection instead of the image. zw: LAST frame's jitter, in NDC.
uniform taaParams: vec4f;

/// This pass's own texel, for the neighbourhood.
uniform taaTexel: vec2f;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    // THE NEIGHBOURHOOD, GATHERED ONCE. Nine taps that serve two purposes: the centre one
    // is this frame's colour, and the extremes bound what the history is allowed to be.
    var lo = vec3f(1.0e9);
    var hi = vec3f(-1.0e9);
    var cur = vec3f(0.0);
    for (var y = -1; y <= 1; y = y + 1) {
        for (var x = -1; x <= 1; x = x + 1) {
            let tap = textureSample(textureSampler, textureSamplerSampler, input.vUV + vec2f(f32(x), f32(y)) * uniforms.taaTexel).rgb;
            lo = min(lo, tap);
            hi = max(hi, tap);
            if (x == 0 && y == 0) {
                cur = tap;
            }
        }
    }

    // WHERE THIS PIXEL WAS. Reconstructed from the PIXEL CENTRE, jitter deliberately
    // ignored — and the reprojection below takes the previous frame's jitter back off for
    // the same reason. Both of those are the same decision, and it is worth being precise
    // about, because the first version of this pass got it backwards and the probe caught
    // it: with a frozen world and a still camera, every pixel reported an identical
    // 0.299 px of motion. A displacement that is the same everywhere is not a
    // reconstruction error, it is a constant, and the constant was the jitter.
    //
    // The strictly literal answer is that this pixel's depth was sampled at (centre +
    // jitter), so its surface's home in the history is a fraction of a pixel off centre,
    // and a truly faithful reprojection would go and read there. That answer is worse. The
    // history is an ACCUMULATION stored at pixel centres, so reading it anywhere else
    // resamples it bilinearly — and doing that every frame, forever, on a camera that is
    // not even moving, blurs the very detail the accumulation exists to build up. Softness
    // with no cause, which is exactly what TAA is unfairly blamed for.
    //
    // So both jitters come off and a still camera reprojects to exactly itself: history is
    // read at pixel centres, untouched, and converges crisply. What is given up is a
    // subpixel error in the world position, which only bites where depth changes steeply
    // across one pixel, and the neighbourhood clamp already governs those.
    let ndc = input.vUV * 2.0 - vec2f(1.0);
    let dir = normalize(uniforms.taaCamFwd + uniforms.taaCamRight * (ndc.x * uniforms.taaLens.x * uniforms.taaLens.y) + uniforms.taaCamUp * (ndc.y * uniforms.taaLens.x));
    let world = uniforms.taaCamPos + dir * textureSample(taaDepth, taaDepthSampler, input.vUV).r;
    let clip = uniforms.taaPrevViewProj * vec4f(world, 1.0);
    let behind = clip.w <= 1.0e-6;

    // The previous jitter comes off here — the other half of the decision argued above.
    // `taaPrevViewProj` is the matrix the previous frame was actually rendered with, so it
    // reports where this surface was DRAWN; subtracting the offset it was drawn with turns
    // that back into the pixel centre the history is stored at.
    let prevUV = select((clip.xy / clip.w - uniforms.taaParams.zw) * 0.5 + vec2f(0.5), vec2f(-1.0), behind);

    // THE INSTRUMENT. Reprojection is the one part of this pass that fails silently: a
    // flipped V or a transposed matrix still produces a plausible, slightly soft image,
    // and it would be blamed on the blend factor for a week. So the motion vectors are a
    // debug view. With the camera still the whole frame must be flat grey — the surface
    // was exactly where it is — and any deviation is a bug in the reconstruction rather
    // than in the antialiasing. With the camera turning it becomes a flow field, and the
    // flow has to run OPPOSITE the turn, at a rate that grows toward the edges.
    if (uniforms.taaParams.y > 0.5) {
        let motion = (prevUV - input.vUV) / uniforms.taaTexel;
        fragmentOutputs.color = vec4f(0.5 + motion.x * 0.05, 0.5 + motion.y * 0.05, select(0.5, 1.0, behind), 1.0);
        return fragmentOutputs;
    }

    // Off the edge of last frame means there IS no history: the surface has just come into
    // view. Taking the current frame whole is the only correct answer, and it is why a
    // fast pan looks aliased at the leading edge in every engine that does this.
    let missing = behind || any(prevUV < vec2f(0.0)) || any(prevUV > vec2f(1.0));

    // The clamp. Cheap, and the entire difference between antialiasing and smearing.
    let history = clamp(textureSample(taaHistory, taaHistorySampler, prevUV).rgb, lo, hi);

    let keep = select(uniforms.taaParams.x, 1.0, missing);
    fragmentOutputs.color = vec4f(mix(history, cur, keep), 1.0);
}
