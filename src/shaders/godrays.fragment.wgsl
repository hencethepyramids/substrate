// Light shafts — sunlight scattered toward the camera by the air, cut into beams by
// whatever is standing between the camera and the sun.
//
// WHY THIS IS ADDITIVE AND BLOOM IS NOT. They look like cousins and they are opposites.
// Bloom is veiling glare: light that was already in the frame, landing somewhere it
// should not have, so it moves energy and gets mixed. A shaft is light that was NEVER in
// the frame — photons travelling from the sun to a point on the view ray, scattering off
// air, and only then coming to the camera. It is genuinely new radiance along that ray,
// so it adds.
//
// THE MASK, AND WHAT IT COSTS. A shaft exists where the sun is directly visible from the
// air along the view ray. Screen space cannot answer that, so this uses the standard
// stand-in: march from the pixel toward the sun's screen position and accumulate only the
// samples where the sun is unobstructed AT THAT PIXEL. The scene buffer's alpha says
// which pixels those are — 2 means sky, see sky.fragment.wgsl — and a ridge in the way
// reads as zero and carves the beam.
//
// The honest limits of that: a shaft cannot exist where its source is off-screen, and an
// occluder outside the frame does not carve anything. Both are inherent to doing this in
// screen space rather than by marching the shadow cascades in world space, which is the
// version that would cost a great deal more than this does.

varying vUV: vec2f;

/// The full-resolution scene, bound explicitly — this pass reads the frame as rendered,
/// not whatever the chain handed it.
var textureSamplerSampler: sampler;
var textureSampler: texture_2d<f32>;

/// Where the sun is on screen, in UV. Off-screen is legal and useful: the taps march
/// toward it whether or not it is inside the frame.
uniform gsSunUV: vec2f;

/// x: how far along the ray to the sun the taps span, as a fraction of the distance.
/// y: per-step attenuation. z: the tap ceiling, see below. w: 0 when the sun is behind
/// the camera or far enough outside the frame that there is nothing to be seen.
uniform gsParams: vec4f;

/// Taps along the ray. Sixty is more than the usual thirty because this project's sun is
/// physically bright — the disc is four orders of magnitude over the sky around it — and
/// too few taps turn a smooth beam into a ladder of discrete copies of the disc.
const GS_SAMPLES: i32 = 60;

/// Alpha at or above this means the pixel is sky. Halfway between the surface class (1)
/// and the sky class (2), so blending that lands somewhere between them has to travel
/// most of the way before it changes the answer.
const GS_SKY_CLASS: f32 = 1.5;

/// This pass's own texel, for the jitter hash below.
uniform gsTexel: vec2f;

/// Integer hash on the pixel index. Deliberately not `fract(sin(x) * k)` — Phase 9 pass A
/// spent an afternoon proving that idiom makes a filter's output a property of the
/// compiler rather than of the scene. See lib/shadow.wgsl for the full story.
fn gsHash(p: vec2f) -> f32 {
    let q = vec2i(floor(p));
    var h = (u32(q.x) * 0x9e3779b9u) ^ (u32(q.y) * 0x85ebca6bu);
    h ^= h >> 15u;
    h *= 0x2c1b3c6du;
    h ^= h >> 12u;
    return f32(h & 0xffffffu) * (1.0 / 16777216.0);
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let density = uniforms.gsParams.x;
    let decay = uniforms.gsParams.y;
    let ceiling = uniforms.gsParams.z;
    let facing = uniforms.gsParams.w;

    // The step, walking from this pixel toward the sun.
    let delta = (input.vUV - uniforms.gsSunUV) * (density / f32(GS_SAMPLES));

    // JITTER THE START, or the beams come out as staircases. Sixty taps of a hard-edged
    // source lay down sixty discrete copies of the horizon along every ray, and because
    // neighbouring pixels step in lockstep those copies line up into terraces you can
    // count. Offsetting each pixel's sequence by a random fraction of one step breaks the
    // lockstep: the same sixty samples, but no two adjacent pixels take them at the same
    // phase, so the terracing becomes fine noise instead. The banding was severe enough to
    // be the first thing visible in the raw buffer.
    var uv = input.vUV - delta * gsHash(input.vUV / uniforms.gsTexel);
    var illumination = 1.0;
    var accum = vec3f(0.0);

    for (var i = 0; i < GS_SAMPLES; i = i + 1) {
        uv = uv - delta;
        let s = textureSample(textureSampler, textureSamplerSampler, uv);
        // Sky only. A surface here is an occluder, and an occluder contributes nothing —
        // which is the entire mechanism by which a ridge becomes a shadow in the air.
        let sky = step(GS_SKY_CLASS, s.a);
        // THE CEILING, WITHOUT WHICH THE SUN IS A SQUARE. The disc is drawn as irradiance
        // over its solid angle — about 59,000 against a sky of order ten — which is
        // physically right and numerically a delta function. Sixty taps cannot integrate
        // a delta function: the few taps that land on the disc dominate everything, the
        // result is a spike thousands of times its surroundings, and magnifying that from
        // a half-resolution buffer gives hard bilinear blocks. Clipping the tap says the
        // air along one ray can only scatter so much, which is also true — and it hands
        // the beam back to the bright sky AROUND the sun, which is what actually makes
        // crepuscular rays.
        // Soft, not `min`. A hard clip gives the region around the sun a plateau with a
        // visible edge where the clip starts biting; this rolls off asymptotically toward
        // the ceiling instead, so the brightest part of the sky stays the brightest part
        // of the beam without ever running away.
        accum = accum + (s.rgb * ceiling / (ceiling + s.rgb)) * sky * illumination;
        // Light falls off along the ray. Geometric in the tap index rather than physical,
        // because the real quantity — optical depth to the sun — is exactly what screen
        // space cannot see.
        illumination = illumination * decay;
    }

    // Averaged over the taps so the tap count is a quality setting and not a brightness
    // one. Change GS_SAMPLES and the beam gets smoother, not stronger.
    fragmentOutputs.color = vec4f(accum * (facing / f32(GS_SAMPLES)), 1.0);
}
