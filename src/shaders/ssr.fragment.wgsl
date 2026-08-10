// Screen-space reflections — and what they are actually FOR in this scene.
//
// SSR is usually sold as puddles and polished floors, neither of which is here. A snowfield
// is rough, and a rough surface scatters its reflection so widely that there is nothing
// mirror-like to see. So the honest question was whether this pass is worth writing at all,
// and the answer came from terrain.fragment.wgsl:
//
//     let roughness = clamp(fSurface.y * mix(1.0, SB_PACKED_SMOOTH, sub.compaction), ...)
//
// COMPACTION POLISHES SNOW. Packed snow is smoother than the loose snow it came from —
// that is already in the renderer, driving the highlight that makes a fresh footprint
// catch light its surroundings do not. Which means this scene does have a smooth surface,
// and it is the one the player makes by walking. That is what this pass is for: the trail
// behind you reflects, and the untouched field beside it does not.
//
// AND IT IS COMPLETING A TERM, NOT ADDING AN EFFECT. Look at what the terrain sums:
//
//     color += (specular + glint) * sbSunIrradiance() * shadow
//
// The only specular in the whole renderer is the SUN's. There is no environment specular
// anywhere — no reflection of the sky, no reflection of anything else. So this is not a
// decorative layer on top of a finished lighting model; it is the missing half of the
// specular BRDF, which is exactly why it ADDS rather than replaces, and why it cannot
// double-count. Nothing was there before.
//
// WHICH IS ALSO WHY THE MISS CASE IS NOT A FALLBACK. When the marched ray leaves the
// screen, a lot of implementations fade to black and call it a limitation. Here the sky is
// genuinely what is in that direction, and Phase 2 already baked it into a LUT that can be
// read in any direction for the cost of one tap. A ray that escapes is not a failure — it
// is a ray that hit the sky. Black would be the wrong answer, not a cheaper one.
//
// ONE RAY PER PIXEL, AND PASS H IS WHY THAT IS ENOUGH. A rough surface needs the
// environment integrated over a wide lobe, which normally means many rays or a prefiltered
// cubemap. Instead the single ray is scattered inside the lobe by a per-pixel, per-frame
// hash, so the result is correct on average and noisy per frame — and TAA, which landed one
// pass ago, averages exactly that kind of noise over eight jittered frames. The order these
// two passes were built in was not arbitrary.

#include<substrateNoise>
#include<substrateBrdf>
#include<substrateSkyMap>
#include<substrateSkyLut>
// For compaction, which is what decides where this pass does anything at all. Brings the
// obligation to bind sbSubTex with it — the oldest trap in this project, noted again here
// because an include that declares a texture obliges every shader including it.
#include<substrateBuffer>

varying vUV: vec2f;

/// The scene in LINEAR radiance, full resolution. Reflections are radiance, so this has to
/// be read before the tonemap — a reflected highlight that has already been through AgX
/// would come back grey and the packed trail would reflect a flat sky.
var textureSamplerSampler: sampler;
var textureSampler: texture_2d<f32>;

/// Linear view distance in metres.
var srDepthSampler: sampler;
var srDepth: texture_2d<f32>;

uniform srCamPos: vec3f;
uniform srCamRight: vec3f;
uniform srCamUp: vec3f;
uniform srCamFwd: vec3f;

/// Last frame's... no: THIS frame's world-to-clip, for projecting a marched world point
/// back to a pixel. The march happens in world space and is projected per step, rather
/// than being interpolated in screen space, because a screen-space march has to special
/// case the horizon and this does not.
uniform srViewProj: mat4x4f;

/// x: tan of half the vertical field of view. y: aspect ratio.
uniform srLens: vec2f;

/// This pass's own texel.
uniform srTexel: vec2f;

/// x: base roughness, the element's own. y: overall gain. z: frame index, to decorrelate
/// the jitter over time. w: unused.
uniform srParams: vec4f;

/// Steps along the ray, and how far it reaches. Thirty-two steps over twelve metres puts a
/// sample every 37 cm before refinement, which is finer than the depth buffer can resolve
/// at the distances where this pass contributes anything.
const SR_STEPS: i32 = 32;
const SR_REFINE: i32 = 5;
const SR_RANGE: f32 = 12.0;

/// Reflectance at normal incidence. Ice and water sit near 0.02-0.04; snow is ice with air
/// in it. This being SMALL is the whole reason the effect stays subtle away from grazing
/// angles, and it is a material constant rather than a dial for that reason.
const SR_F0: f32 = 0.03;

/// Past this roughness the lobe is so wide that a single traced ray says nothing the sky
/// LUT does not already say, so the march is skipped entirely and the pixel takes the sky.
const SR_ROUGH_MAX: f32 = 0.45;

/// How much thicker than the depth buffer says a surface is allowed to be before a crossing
/// counts as passing BEHIND it rather than hitting it. Without this every ray that dips
/// below a foreground object reports a hit on its back face.
const SR_THICKNESS: f32 = 0.65;

/// Integer hash. Not fract(sin(x)*k) — see lib/shadow.wgsl for the afternoon that cost.
fn srHash(x: u32, y: u32, z: u32) -> vec2f {
    var h = (x * 0x9e3779b9u) ^ (y * 0x85ebca6bu) ^ (z * 0xc2b2ae35u);
    h ^= h >> 15u;
    h *= 0x2c1b3c6du;
    h ^= h >> 12u;
    let a = f32(h & 0xffffu) * (1.0 / 65536.0);
    h ^= h >> 16u;
    h *= 0x9e3779b9u;
    let b = f32((h >> 8u) & 0xffffu) * (1.0 / 65536.0);
    return vec2f(a, b);
}

/// The view ray through a pixel centre.
fn srRay(uv: vec2f) -> vec3f {
    let ndc = uv * 2.0 - vec2f(1.0);
    return normalize(uniforms.srCamFwd + uniforms.srCamRight * (ndc.x * uniforms.srLens.x * uniforms.srLens.y) + uniforms.srCamUp * (ndc.y * uniforms.srLens.x));
}

/// World position behind a pixel, from the depth buffer. Pass E's buffer stores distance
/// ALONG the ray, so this is a multiply rather than an inverse projection.
fn srWorld(uv: vec2f) -> vec3f {
    return uniforms.srCamPos + srRay(uv) * textureSampleLevel(srDepth, srDepthSampler, uv, 0.0).r;
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let dist = textureSampleLevel(srDepth, srDepthSampler, input.vUV, 0.0).r;
    // The sky reflects nothing. The depth pass clears to 1e6, so anything out there is
    // either sky or far enough that a twelve-metre ray is pointless.
    if (dist > 4.0e3) {
        fragmentOutputs.color = vec4f(0.0);
        return fragmentOutputs;
    }

    let world = uniforms.srCamPos + srRay(input.vUV) * dist;

    // THE NORMAL, FROM DEPTH, AND THE TAP CHOICE IS THE WHOLE TRICK. A plain central
    // difference straddles silhouettes: at the edge of the character it takes one tap on
    // the figure and one on the snow four metres behind, and reports a normal facing
    // nowhere real. So both sides are computed and the NEARER one wins — the side whose
    // depth agrees with this pixel is the side still on the same surface. Costs four taps
    // and removes the halo that gives depth-derived normals away.
    let dxr = srWorld(input.vUV + vec2f(uniforms.srTexel.x, 0.0)) - world;
    let dxl = world - srWorld(input.vUV - vec2f(uniforms.srTexel.x, 0.0));
    let dyu = srWorld(input.vUV + vec2f(0.0, uniforms.srTexel.y)) - world;
    let dyd = world - srWorld(input.vUV - vec2f(0.0, uniforms.srTexel.y));
    let ddx = select(dxl, dxr, dot(dxr, dxr) < dot(dxl, dxl));
    let ddy = select(dyd, dyu, dot(dyu, dyu) < dot(dyd, dyd));
    var n = normalize(cross(ddy, ddx));
    // The depth buffer's sign convention is not worth deriving in the abstract: the ground
    // is below the camera, so a normal pointing away from the eye is inverted.
    let eye = normalize(uniforms.srCamPos - world);
    if (dot(n, eye) < 0.0) {
        n = -n;
    }

    // ROUGHNESS, RECONSTRUCTED THE SAME WAY THE TERRAIN COMPUTES IT. Not read from a
    // G-buffer, because there is no G-buffer: the substrate is a world-space field, so this
    // pass can sample compaction at the reconstructed world position and reach the same
    // number the terrain reached from its own interpolated position. The two must agree —
    // if they ever drift, the trail will reflect in a slightly different place than it
    // catches its highlight.
    let sub = sbSubstrateAt(world.xz);
    let roughness = clamp(uniforms.srParams.x * mix(1.0, SB_PACKED_SMOOTH, sub.compaction), 0.03, 1.0);

    // FRESNEL, AND IT IS DOING MOST OF THE WORK. At normal incidence snow reflects three
    // percent of what hits it, so a camera looking down at the ground sees almost nothing —
    // which is correct, and is why this pass is honest about being subtle. At grazing
    // angles it approaches one, which is both where reflections are physically strongest
    // and where a screen-space march has the most screen left to march through.
    let ndv = max(dot(n, eye), 0.0);
    let fresnel = SR_F0 + (1.0 - SR_F0) * pow(1.0 - ndv, 5.0);
    // Rough ground fades out rather than cutting off, so the edge of the packed trail is a
    // gradient and not a visible boundary.
    let weight = fresnel * uniforms.srParams.y * smoothstep(SR_ROUGH_MAX, SR_ROUGH_MAX * 0.4, roughness);
    if (weight < 0.002) {
        fragmentOutputs.color = vec4f(0.0);
        return fragmentOutputs;
    }

    // THE LOBE, SAMPLED WITH ONE RAY. The mirror direction is perturbed within a cone whose
    // width follows roughness, so across the frame and across TAA's eight jittered frames
    // the set of rays covers the lobe. Squaring roughness is the usual GGX convention and
    // it matters here: it keeps a slightly-packed surface tight instead of immediately
    // scattering into mush.
    let px = vec2u(vec2i(floor(input.vUV / uniforms.srTexel)));
    let rnd = srHash(px.x, px.y, u32(uniforms.srParams.z));
    let mirror = reflect(-eye, n);
    let spread = roughness * roughness;
    // A tangent frame around the mirror direction. Any vector not parallel to it will do.
    let up = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(mirror.y) > 0.9);
    let t = normalize(cross(up, mirror));
    let b = cross(mirror, t);
    let phi = rnd.x * 6.2831853;
    // sqrt keeps the samples area-uniform inside the cone rather than clumped at its axis.
    let r = spread * sqrt(rnd.y);
    var dir = normalize(mirror + (t * cos(phi) + b * sin(phi)) * r);
    // A ray that has been scattered below the surface would march straight into the ground.
    if (dot(dir, n) < 0.02) {
        dir = mirror;
    }

    // THE MARCH, IN WORLD SPACE. Each step is projected to a pixel and compared against the
    // depth buffer there: if the ray is further than the recorded surface, it has gone
    // behind something. Marching in world space rather than interpolating in screen space
    // costs a matrix multiply per step and buys not having to special-case a ray that
    // approaches the horizon, where screen-space steps stop corresponding to distance at
    // all. The start is offset by a hashed fraction of a step so the sampling pattern does
    // not band — the same trick, and the same reason, as the shaft pass.
    let step = SR_RANGE / f32(SR_STEPS);
    let origin = world + n * 0.05;
    var hitUv = vec2f(0.0);
    var found = false;
    var tPrev = step * rnd.x;
    for (var i = 1; i <= SR_STEPS; i = i + 1) {
        let tCur = step * (f32(i) + rnd.x);
        let p = origin + dir * tCur;
        let clip = uniforms.srViewProj * vec4f(p, 1.0);
        if (clip.w <= 1.0e-4) {
            break;
        }
        let uv = (clip.xy / clip.w) * 0.5 + vec2f(0.5);
        if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
            break;
        }
        let scene = textureSampleLevel(srDepth, srDepthSampler, uv, 0.0).r;
        let along = length(p - uniforms.srCamPos);
        // Crossed: the ray is now behind the surface drawn at this pixel.
        if (along > scene && along - scene < SR_THICKNESS + step) {
            // BINARY REFINEMENT. Without it the hit lands on a step boundary and every
            // reflection is drawn in 37 cm stripes. Five halvings take the error to about
            // a centimetre, which is below what the reflection can show.
            var lo = tPrev;
            var hi = tCur;
            for (var k = 0; k < SR_REFINE; k = k + 1) {
                let mid = (lo + hi) * 0.5;
                let q = uniforms.srViewProj * vec4f(origin + dir * mid, 1.0);
                let quv = (q.xy / q.w) * 0.5 + vec2f(0.5);
                let qs = textureSampleLevel(srDepth, srDepthSampler, quv, 0.0).r;
                if (length(origin + dir * mid - uniforms.srCamPos) > qs) {
                    hi = mid;
                } else {
                    lo = mid;
                }
            }
            let q = uniforms.srViewProj * vec4f(origin + dir * hi, 1.0);
            hitUv = (q.xy / q.w) * 0.5 + vec2f(0.5);
            found = true;
            break;
        }
        tPrev = tCur;
    }

    var radiance: vec3f;
    if (found) {
        radiance = textureSampleLevel(textureSampler, textureSamplerSampler, hitUv, 0.0).rgb;
        // FADE AT THE EDGE OF THE SCREEN, because that is where the information runs out
        // rather than where the world does. A reflection that ends in a hard line along the
        // frame border is the single artefact that identifies screen-space reflection at a
        // glance; a ray that leaves the frame is treated as a ray that hit the sky, and the
        // crossfade between the two is what keeps the boundary invisible.
        let edge = min(min(hitUv.x, 1.0 - hitUv.x), min(hitUv.y, 1.0 - hitUv.y));
        radiance = mix(sbSkyRaw(dir).rgb, radiance, smoothstep(0.0, 0.06, edge));
    } else {
        // Not a failure. The sky is what is in that direction, and Phase 2 baked it.
        radiance = sbSkyRaw(dir).rgb;
    }

    fragmentOutputs.color = vec4f(radiance, weight);
}
