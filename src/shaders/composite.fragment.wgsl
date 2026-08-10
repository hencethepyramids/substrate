// The end of the frame: scene-referred radiance in, a pixel out.
//
// THE TONEMAP LIVES HERE NOW, and that move is the whole of Phase 9 pass A. Through
// Phases 1 to 8 every material ran `sbDisplay` itself and wrote a finished pixel, which
// was correct while there was nothing after them. It stops being correct the moment
// anything wants to work on the image: bloom on display-referred values blooms a curve's
// output rather than light, and a highlight that AgX has already rolled off to 0.9 has
// lost exactly the information bloom needs — how much brighter than white it was.
//
// So the materials now write LINEAR RADIANCE into a half-float buffer, the effects work
// in that space, and the curve runs once, here, at the end.

#include<substrateTonemap>
// substrateBuffer, not substrateParams: sbFireAt needs the window fade, and the window
// lives with the buffer. Which means this pass now has to bind sbSubTex whether it wants
// it or not — an include that declares a texture obliges every shader including it to
// bind that texture, the oldest trap in this project.
#include<substrateBuffer>
#include<substrateFireBuffer>

varying vUV: vec2f;
var textureSamplerSampler: sampler;
var textureSampler: texture_2d<f32>;

/// The top of the bloom pyramid, at half resolution. Bound to the scene itself with a
/// weight of zero when bloom is off, so there is one shader rather than two variants.
var cpBloomSampler: sampler;
var cpBloom: texture_2d<f32>;

/// In-scattered sunlight along the view ray. Bound to the scene with a gain of zero when
/// shafts are off, for the same reason as the bloom above.
var cpShaftsSampler: sampler;
var cpShafts: texture_2d<f32>;

/// How much of the frame's light arrives scattered rather than focused.
uniform cpBloomWeight: f32;

/// Gain on the shaft buffer. Separate from the bloom weight because one redistributes
/// energy and the other brings in light that was not in the frame at all.
uniform cpShaftWeight: f32;

/// x: vignette amount, 0 off and 1 the physical falloff. y: tan of half the vertical
/// field of view. z: aspect ratio.
uniform cpVignette: vec3f;

/// The depth pass's buffer, in metres. Bound to the scene with the debug flag off.
var cpDepthSampler: sampler;
var cpDepth: texture_2d<f32>;

/// Non-zero shows the depth buffer instead of the frame.
uniform cpShowDepth: f32;

/// Screen-space reflections, at half resolution, with the Fresnel weight in alpha.
var cpSsrSampler: sampler;
var cpSsr: texture_2d<f32>;

/// Non-zero when the reflection pass is in the chain.
uniform cpSsr0: f32;

/// The defocused image at half resolution, with its circle of confusion in alpha.
var cpDofSampler: sampler;
var cpDof: texture_2d<f32>;

/// The widest circle of confusion the gather chased. Zero when depth of field is off.
uniform cpDofMax: f32;

/// Camera basis and position, for turning a pixel back into a world point. The ray is all
/// the depth buffer needs to become geometry: it stores distance ALONG this ray, so the
/// world point is simply the camera plus the direction times the number in the texture —
/// no inverse projection, no matrix per pixel.
uniform cpCamPos: vec3f;
uniform cpCamRight: vec3f;
uniform cpCamUp: vec3f;
uniform cpCamFwd: vec3f;

/// x: heat distortion strength, 0 off. y: simulation seconds.
uniform cpHeat: vec2f;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    // HEAT SHIMMER, AND IT IS A REFRACTION, NOT AN OVERLAY. Hot air is less dense and so
    // has a lower refractive index; a ray crossing it bends. Nothing is drawn — the frame
    // is simply READ from slightly the wrong place, which is exactly what the eye does
    // when it looks over a fire. That is why this happens before every other sample below
    // rather than being blended on top: the bloom and the shafts should be displaced with
    // the image, because they are part of the image the bent ray arrives from.
    //
    // The world point comes from the depth buffer for free. It stores distance ALONG the
    // view ray, so `camera + direction * distance` is the hit point — no inverse
    // projection anywhere. Sampling the heat field THERE rather than at the pixel is what
    // makes the shimmer sit on the fire instead of floating in screen space.
    var uv = input.vUV;
    if (uniforms.cpHeat.x > 0.0) {
        let ndc = input.vUV * 2.0 - vec2f(1.0);
        let dir = normalize(uniforms.cpCamFwd + uniforms.cpCamRight * (ndc.x * uniforms.cpVignette.y * uniforms.cpVignette.z) + uniforms.cpCamUp * (ndc.y * uniforms.cpVignette.y));
        let dist = min(textureSample(cpDepth, cpDepthSampler, input.vUV).r, 400.0);
        let world = uniforms.cpCamPos + dir * dist;
        let fire = sbFireAt(world.xz);
        if (fire.heat > 0.0) {
            // Two scrolling waves at different rates, so the pattern never repeats
            // visibly. Rising, because hot air does: the vertical term scrolls upward and
            // the horizontal one only wanders.
            let t = uniforms.cpHeat.y;
            let w1 = sin(world.x * 5.3 + world.z * 3.1 - t * 3.7);
            let w2 = sin(world.z * 6.7 - world.x * 2.3 - t * 5.1);
            // Falls off with distance in SCREEN terms: the same bend in the air subtends a
            // smaller angle the further away the air is.
            let shrink = 1.0 / (1.0 + dist * 0.05);
            uv = uv + vec2f(w1, w2 + 0.6) * (fire.heat * uniforms.cpHeat.x * 0.02 * shrink);
        }
    }

    var scene = textureSample(textureSampler, textureSamplerSampler, uv);

    // THE DEPTH BUFFER, SHOWN THROUGH THE SAME RAMP THE TERRAIN USES FOR ITS OWN
    // linearDepth VIEW. That is the entire point of this branch: the terrain computes
    // distance in its fragment shader from its own interpolated world position, and this
    // pass computes it in a separate geometry pass and stores it in a separate target.
    // Two independent paths to one number, displayed identically — so a pixel diff between
    // the two views answers both "is the depth right" and, far more sharply, "do the two
    // buffers even line up", which a vertical flip somewhere in the render-target
    // plumbing would otherwise hide until it silently ruined a reprojection.
    if (uniforms.cpShowDepth > 0.5) {
        let metres = textureSample(cpDepth, cpDepthSampler, input.vUV).r;
        let ramp = 1.0 - exp(-metres * 0.0016);
        fragmentOutputs.color = vec4f(vec3f(ramp), 1.0);
        return fragmentOutputs;
    }

    // MIXED, NOT ADDED, and the distinction is the whole physical claim. Bloom here is
    // veiling glare: light that should have landed on one point of the sensor and instead
    // scattered across it, in the atmosphere between the lens elements, in the eye's own
    // vitreous humour. Scattering MOVES energy, it does not make any, so the scattered
    // fraction has to come out of the focused image. Adding a blurred copy on top would
    // brighten the whole frame, which is why an added bloom always needs a threshold to
    // stop it washing everything out — and a threshold is a lie, because real glare has
    // no cutoff. A snow field glares. This one is thresholdless and energy conserving.
    //
    // GATED BY THE SAME WEIGHT AS THE TONEMAP, for the same reason. A debug view showing
    // roughness is not emitting light, so nothing about it scatters; smearing a blurred
    // copy of it across itself would soften exactly the per-texel structure those views
    // exist to show. The weight is the frame's own answer to "is this light", so both the
    // curve and the glare ask it.
    let bloom = textureSample(cpBloom, cpBloomSampler, uv).rgb;
    let glare = uniforms.cpBloomWeight * saturate(scene.a);
    scene = vec4f(mix(scene.rgb, bloom, glare), scene.a);

    // ADDED, because a shaft is light that was never in the frame: photons from the sun
    // scattering off air somewhere along this view ray. It is new radiance, not
    // redistributed radiance, and it arrives BEFORE the tonemap so a bright shaft rolls
    // off on the same curve as a bright anything else. Gated by the same class weight —
    // a debug view is not air and nothing scatters through it.
    let shafts = textureSample(cpShafts, cpShaftsSampler, uv).rgb;
    scene = vec4f(scene.rgb + shafts * (uniforms.cpShaftWeight * saturate(scene.a)), scene.a);

    // REFLECTIONS, ADDED, AND ADDING IS THE CORRECT OPERATION HERE FOR ONCE. Everywhere
    // else in this file the question "add or mix" has a real answer that took thought —
    // bloom mixes because scattering moves energy, shafts add because they bring light that
    // was not in the frame. This adds for a blunter reason: the renderer has no environment
    // specular at all. The terrain's only specular is the sun's, so there is nothing here
    // to double-count, and this is the missing half of the BRDF rather than a layer on top
    // of a finished one.
    //
    // The weight in alpha is Fresnel times the roughness gate, computed where the surface
    // normal was known. Gated by the class weight like everything else: a debug view is not
    // a mirror.
    if (uniforms.cpSsr0 > 0.0) {
        let refl = textureSample(cpSsr, cpSsrSampler, uv);
        scene = vec4f(scene.rgb + refl.rgb * (refl.a * saturate(scene.a)), scene.a);
    }

    // VIGNETTE, BEFORE THE CURVE, BECAUSE IT IS A LENS AND NOT A LOOK. Less light reaches
    // the corner of a sensor than the centre, and the falloff is not an arbitrary radial
    // gradient — it is cos^4 of the angle off the optical axis, which for a pinhole is
    // exactly 1/(1+tan^2)^2. Deriving it from the actual field of view rather than from a
    // radius in UV means it does the right thing on its own: widen the lens and the
    // corners darken more, because they are further off-axis. A UV-radius vignette would
    // look identical at every focal length, which no lens does.
    //
    // Being before the tonemap is what makes it behave: darkening radiance pulls a corner
    // back down the curve, so a blown highlight in the corner rolls off into colour
    // instead of staying flat white and getting greyer. Applied after the transform it
    // would just be a grey wash.
    //
    // GATED BY THE CLASS WEIGHT, like the bloom and the shafts above — and this one was
    // missed when it was written. Pass E caught it by displaying the depth buffer through
    // the same ramp the terrain uses for its own linearDepth view and diffing the two: the
    // numbers disagreed by a steady 24%, which is not what a wrong depth buffer looks like
    // and is exactly what a lens falloff quietly multiplying an instrument looks like. A
    // debug view is a measurement, and no light reached a sensor to fall off.
    if (uniforms.cpVignette.x > 0.0) {
        let ndc = input.vUV * 2.0 - vec2f(1.0);
        // Position on the sensor in units of focal length.
        let sensor = vec2f(ndc.x * uniforms.cpVignette.y * uniforms.cpVignette.z, ndc.y * uniforms.cpVignette.y);
        let cos2 = 1.0 / (1.0 + dot(sensor, sensor));
        let falloff = mix(1.0, cos2 * cos2, uniforms.cpVignette.x * saturate(scene.a));
        scene = vec4f(scene.rgb * falloff, scene.a);
    }

    // ALPHA IS THE TRANSFORM WEIGHT, and it exists for the debug views. Most of them do
    // not emit light — `vec3f(roughness)` is a number between 0 and 1 that means "how
    // rough", and running a film curve over it turns a linear ramp into a curved one. The
    // instrument stops reading in the units it is labelled in, which is the exact failure
    // this project keeps writing probes to catch.
    //
    // So anything that emits radiance writes 1 here and gets the curve; a debug view
    // showing a raw quantity writes 0 and arrives at the backbuffer untouched. Saturated
    // because additive blending pushes alpha past 1 and an unclamped mix would then
    // extrapolate past the tonemapped colour instead of landing on it.
    // DEPTH OF FIELD, blended by how defocused this pixel actually is. The gather pass
    // carries its circle of confusion in alpha, so a pixel at the focus distance takes
    // none of it and one well outside takes all of it — no depth comparison here, because
    // the lens already answered that question in units of pixels.
    //
    // Before the tonemap, like everything else that is optical: a defocused highlight
    // spreads its RADIANCE over a disc, and averaging display values instead would make
    // bokeh from a bright specular come out grey rather than bright.
    if (uniforms.cpDofMax > 0.0) {
        let defocused = textureSample(cpDof, cpDofSampler, uv);
        // Two pixels of circle of confusion is where a blur becomes visible at all; the
        // ramp to four keeps the transition out of the focus plane from being a hard ring.
        let blend = smoothstep(2.0, 4.0, defocused.a);
        scene = vec4f(mix(scene.rgb, defocused.rgb, blend * saturate(scene.a)), scene.a);
    }

    let mapped = sbDisplay(scene.rgb);
    fragmentOutputs.color = vec4f(mix(scene.rgb, mapped, saturate(scene.a)), 1.0);
}
