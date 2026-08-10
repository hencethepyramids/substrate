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
#include<substrateNoise>
#include<substrateHeightfield>
#include<substrateTerrainParams>
#include<substrateFarField>

varying vRay: vec3f;

// x: exposure EV, y: sun disc on, z: debug view, w: unused
uniform skParams: vec4f;
/// x: far range on, y: march steps, z: start distance m, w: far distance m
uniform skFar: vec4f;
uniform skCameraPos: vec3f;
uniform skAlbedo: vec3f;
uniform skAlbedoSteep: vec3f;

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
    // Hoisted, and it has to be. sbHazeColor is a textureSample, textureSample needs
    // uniform control flow, and whether a far-range ray meets terrain is per-pixel by
    // definition. Reading it here and using the value inside the branch costs one
    // fetch on rays that turn out not to need it, which is the price of the rule.
    let haze = sbHazeColor(dir);

    var rgb: vec3f;

    if (uniforms.skParams.z == SK_DEBUG_SKY_IRRADIANCE) {
        // The SH reconstruction against the sky it was projected from. Ringing,
        // clamping and any missing band all show up here as banding that the LUT
        // beside it does not have. Same exposure and same transfer as the terrain's
        // version of this view, so the dome and the ground can be read against each
        // other rather than against two different curves.
        rgb = sbShIrradiance(dir) * exp2(uniforms.skParams.x);
    } else {
        var color = raw.rgb;

        // What lies below the horizon. The far-range march replaces the flat bounced
        // plane with the actual landform, out of the same function the clipmap was
        // baked from; the plane stays as the fallback for rays that reach the
        // horizon without meeting ground, and for when the march is switched off.
        var groundLit = false;
        if (uniforms.skFar.x > 0.5) {
            let hit = sbFarMarch(uniforms.skCameraPos, dir, uniforms.skFar.z, uniforms.skFar.w, i32(uniforms.skFar.y), sbTerrainParams());
            if (hit.hit) {
                let n = normalize(vec3f(-hit.deriv.x, 1.0, -hit.deriv.y));
                let rock = smoothstep(0.16, 0.44, clamp(1.0 - n.y, 0.0, 1.0));
                let albedo = mix(uniforms.skAlbedo, uniforms.skAlbedoSteep, rock);

                let wrap = 0.18;
                let ndl = clamp((dot(n, uniforms.sbSunDir) + wrap) / (1.0 + wrap), 0.0, 1.0);
                // No cascades out here — the shadow distance is a few hundred metres
                // and this starts at 870. Aerial perspective is doing all the work by
                // this range anyway.
                let lit = albedo * (sbSunDiffuse() * ndl + sbShIrradiance(n));

                let transmittance = sbAerial(hit.dist * 0.001);
                color = lit * transmittance + haze * (vec3f(1.0) - transmittance);
                groundLit = true;
            }
        }
        if (!groundLit && raw.a > 0.0) {
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

        // Radiance, unmapped — the composite is now the only thing that owns the
        // curve, which is a stronger version of the guarantee this comment used to make.
        // A dome and the ground under it are read against each other, and there is no
        // longer any way for them to end up on two different transfers.
        rgb = color;
    }

    // ALPHA IS A MATERIAL CLASS, not just the display-transform weight it started as.
    // 0 is a raw quantity, 1 is surface radiance, and 2 — here — is sky: light arriving
    // with nothing between it and the camera. The composite still reads it as a weight,
    // because saturate() maps both 1 and 2 to one, and the light shafts read the 2 as the
    // thing they need and cannot get any other way: which pixels the sun can actually be
    // seen through. The alternative was a depth pre-pass over the whole clipmap for one
    // bit of information.
    fragmentOutputs.color = vec4f(rgb, 2.0);
}
