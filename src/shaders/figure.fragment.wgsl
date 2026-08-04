// The character's surface.
//
// Lit through the same sky, the same shadow cascades, the same reflectance model and the
// same display transfer as the ground it stands on. Not a similar one — the same include
// files. A figure shaded by its own opinion of what a highlight or an ambient looks like
// is how you end up trusting the wrong one, and it is the single most common way a
// character ends up looking pasted onto a world rather than standing in it.
//
// Two materials, chosen per vertex: the clothed parts and the bare ones. They differ in
// albedo, in roughness and in how much light comes back out from under the surface, which
// is the whole of the difference that matters at the distance a third-person camera sees.

#include<substrateSkyMap>
#include<substrateSkyLut>
#include<substrateSh>
#include<substrateSkyData>
#include<substrateShadow>
#include<substrateNoise>
#include<substrateBrdf>
#include<substrateTonemap>

varying vWorld: vec3f;
varying vNormal: vec3f;
varying vMaterial: f32;

uniform fgCloth: vec3f;
uniform fgSkin: vec3f;
/// Light that entered the surface and came back out. Warm, because flesh is.
uniform fgTint: vec3f;
/// x: exposure, y: cloth roughness, z: skin roughness, w: subsurface strength.
uniform fgParams: vec4f;
uniform fgCameraPos: vec3f;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let l = normalize(uniforms.sbSunDir);

    let toEye = uniforms.fgCameraPos - input.vWorld;
    let dist = length(toEye);
    let v = toEye / max(dist, 1e-4);

    // TURNED TO FACE THE VIEWER. The figure is a closed surface with back faces culled, so
    // this never fires for it — but the cloak shares this shader and a sheet of cloth has
    // two sides, both of which get looked at. Without it the underside of a cape lights
    // from a normal pointing away from the eye and reads as a black hole in the middle of
    // a lit garment.
    let raw = normalize(input.vNormal);
    let n = select(-raw, raw, dot(raw, v) >= 0.0);

    let isSkin = step(0.5, input.vMaterial);
    let albedo = mix(uniforms.fgCloth, uniforms.fgSkin, isSkin);
    let roughness = mix(uniforms.fgParams.y, uniforms.fgParams.z, isSkin);

    let rawNdl = dot(n, l);
    let shadow = shVisibility(input.vWorld, n, rawNdl, dist);

    // Both terms are reflected radiance per unit irradiance, exactly as the ground's are,
    // so there is no stray 1/pi here either and no ambient constant. Only the direct term
    // is occluded — the SH is sky, and the sky is not.
    var color = sbDiffuseSss(albedo, rawNdl, uniforms.fgTint, uniforms.fgParams.w) * sbSunDiffuse() * shadow + albedo * sbShIrradiance(n);

    // Single lobe. Cloth and skin both have one, unlike sand, whose second lobe exists
    // because of the film of fines around each grain.
    color = color + sbSpecular(n, v, l, roughness) * sbSunIrradiance() * shadow;

    // Aerial perspective, from the same model. A character forty metres out has forty
    // metres of air in front of it whatever it is made of.
    let transmittance = sbAerial(dist * 0.001);
    color = color * transmittance + sbHazeColor(-v) * (vec3f(1.0) - transmittance);

    fragmentOutputs.color = vec4f(sbDisplay(color * exp2(uniforms.fgParams.x)), 1.0);
}
