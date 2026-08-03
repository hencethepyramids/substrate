// The sky, read out of the baked LUT, plus the sun disc and the ground beyond the
// clipmap's edge.
//
// Phase 2's second pass replaces the below-horizon half of this with the far-range
// terrain raymarch. Until then, everything past 870 m is a bounced ground plane
// hazed by the distance to it, which is at least the right colour to be wrong about.

#include<substrateSkyMap>
#include<substrateSkyLut>
#include<substrateSh>
#include<substrateSkyData>

varying vRay: vec3f;

// x: exposure EV, y: sun disc on, z: debug view, w: unused
uniform skParams: vec4f;

const SK_DEBUG_SKY_IRRADIANCE: f32 = 6.0;

/// cos of the solar half-angle, and of a slightly wider edge to soften it.
const SK_SUN_INNER: f32 = 0.99998942;
const SK_SUN_OUTER: f32 = 0.99996;
/// Solid angle of the disc, sr. Radiance is irradiance over this.
const SK_SUN_SOLID_ANGLE: f32 = 6.807e-5;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let dir = normalize(input.vRay);
    let raw = sbSkyRaw(dir);

    var rgb: vec3f;

    if (uniforms.skParams.z == SK_DEBUG_SKY_IRRADIANCE) {
        // The SH reconstruction against the sky it was projected from. Ringing,
        // clamping and any missing band all show up here as banding that the LUT
        // beside it does not have. Same exposure and same transfer as the terrain's
        // version of this view, so the dome and the ground can be read against each
        // other rather than against two different curves.
        rgb = pow(max(sbShIrradiance(dir) * exp2(uniforms.skParams.x), vec3f(0.0)), vec3f(1.0 / 2.2));
    } else {
        var color = raw.rgb;

        // Ground past the terrain, attenuated by the air between here and there.
        // a is 0 when the ray never reaches the surface, and full bounce at a = 0 is
        // exactly right for a ray pointing at the ground under our feet.
        if (raw.a > 0.0) {
            color = color + sbAerial(raw.a) * sbGroundLight();
        }

        // The disc. Real solar radiance is four orders of magnitude above the sky,
        // so with a gamma transfer and no highlight rolloff this clips to white with
        // a soft edge — which is what an unexposed photograph of the sun does too.
        // Phase 9's bloom and AgX are what earn it a shape.
        if (uniforms.skParams.y > 0.5 && raw.a <= 0.0) {
            let mu = dot(dir, uniforms.sbSunDir);
            let disc = smoothstep(SK_SUN_OUTER, SK_SUN_INNER, mu);
            // Limb darkening: the edge of the disc is a shallower line of sight into
            // the photosphere and reads about 40% dimmer than the centre.
            let limb = mix(0.6, 1.0, disc);
            color = color + sbSunIrradiance() * (disc * limb / SK_SUN_SOLID_ANGLE);
        }

        color = color * exp2(uniforms.skParams.x);

        // Placeholder transfer, matched to every other material. Phase 9 replaces it
        // with AgX in the post chain.
        rgb = pow(max(color, vec3f(0.0)), vec3f(1.0 / 2.2));
    }

    fragmentOutputs.color = vec4f(rgb, 1.0);
}
