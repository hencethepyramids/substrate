// The thrown load itself: a disc shaded as though it were a sphere.
//
// THE NORMAL IS RECOVERED, NOT SUPPLIED. On a camera-facing quad the disc coordinate IS the
// sphere's normal in view space — x and y across the face, and z from x^2 + y^2 + z^2 = 1.
// So a hundred-triangle ball is replaced by one square root, and the lighting is a real
// hemisphere rather than a flat sprite with a gradient painted on it. The terminator moves
// correctly as the sun moves, which a painted gradient cannot do.
//
// LIT LIKE THE GROUND IT CAME FROM, because it IS the ground it came from — a scoop of the
// same material, in the air. Same wrapped diffuse, same SH sky term, same sun irradiance
// out of the Phase 2 data texture. Any other lighting model here would make a thrown
// shovelful a different colour from the hole it left, which is the one comparison a player
// gets to make directly.

#include<substrateSkyMap>
#include<substrateSkyLut>
#include<substrateSh>
#include<substrateSkyData>
#include<substrateNoise>
#include<substrateBrdf>

/// The sun's direction, shared by every lit material. A uniform, not a function.

varying vDisc: vec2f;

uniform tpCamRight: vec3f;
uniform tpCamUp: vec3f;
uniform tpCamFwd: vec3f;
/// x: unused. y: exposure in stops. z: subsurface strength, the element's own.
uniform tpParams: vec3f;
/// Taken from the element, so a snowball is snow-coloured and a sand one is not — and, more
/// to the point, is the SAME colour as the hole it came out of.
uniform tpAlbedo: vec3f;
/// What the light picks up on its way through the material. Only the wrapped term is
/// tinted, because only the wrapped term went through anything.
uniform tpTint: vec3f;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let r2 = dot(input.vDisc, input.vDisc);
    // Outside the inscribed circle there is no ball, and a square snowball is worse than no
    // snowball. Discarded rather than blended to zero so it never writes depth either.
    if (r2 > 1.0) {
        discard;
    }

    // The hemisphere facing the camera, rebuilt in world space from the camera's own basis.
    let z = sqrt(max(1.0 - r2, 0.0));
    let n = normalize(uniforms.tpCamRight * input.vDisc.x + uniforms.tpCamUp * input.vDisc.y - uniforms.tpCamFwd * z);

    let ndl = dot(n, uniforms.sbSunDir);
    // The same wrapped term the terrain uses. Snow is deeply translucent at this scale — a
    // handful of it glows on the shadow side rather than going black — so the wrap is not a
    // softening trick here, it is the material.
    let lit = sbDiffuseSss(uniforms.tpAlbedo, ndl, uniforms.tpTint, uniforms.tpParams.z);
    var rgb = lit * sbSunDiffuse() + uniforms.tpAlbedo * sbShIrradiance(n);

    // A SHEEN OFF THE SKY, and it is the same three percent pass I settled on. Snow is ice
    // with air in it and reflects about 0.03 at normal incidence, rising toward one at the
    // edge of a curved surface — which on a ball is a bright rim exactly where the surface
    // turns away. That rim is most of what separates a sphere from a flat disc with a
    // gradient on it, and it costs one sky tap.
    //
    // It is also why this shader can include substrateSkyData honestly: that include drags
    // the sky LUT in with it, and the shader check refuses a binding nothing reads. The
    // choice was to drop the sky term or to use it, and the sky is genuinely what a ball in
    // the air reflects.
    let view = -uniforms.tpCamFwd;
    let fresnel = 0.03 + 0.97 * pow(1.0 - max(dot(n, view), 0.0), 5.0);
    rgb = rgb + sbSkyRaw(reflect(-view, n)).rgb * fresnel;

    rgb = rgb * exp2(uniforms.tpParams.y);

    // Alpha 1: this emits radiance, so the composite gives it the display transform. See
    // the long note on the material class in composite.fragment.wgsl.
    fragmentOutputs.color = vec4f(rgb, 1.0);
}
