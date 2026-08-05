// A grain of thrown material.
//
// NOT ADDITIVE, unlike the embers. An ember is a light source and adds to whatever is
// behind it; a grain of snow is a tiny opaque thing that HIDES what is behind it and is
// lit by the same sun as the ground it came off. Additive spray reads as smoke or as
// magic, because the one thing it can never do is get darker than its background.
//
// Lit by the sky and the sun through the same includes the terrain uses, so a plume of
// snow against a golden-hour dune is the colour that dune is.

#include<substrateSkyMap>
#include<substrateSkyLut>
#include<substrateSh>
#include<substrateSkyData>
#include<substrateAtmosphere>

varying vCorner: vec2f;
varying vGlow: f32;
varying vDist: f32;
varying vView: vec3f;

uniform spAlbedo: vec3f;
uniform spExposure: f32;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    // Round, not square. The quad is a carrier.
    let r2 = dot(input.vCorner, input.vCorner);
    let disc = clamp(1.0 - r2, 0.0, 1.0);
    let alpha = disc * disc * input.vGlow;

    // A grain is small enough that it is lit from every side at once — there is no
    // meaningful normal on something a few millimetres across tumbling through the air.
    // Half the sun and the whole sky is the honest average.
    let lit = uniforms.spAlbedo * (sbSunDiffuse() * 0.5 + sbShIrradiance(vec3f(0.0, 1.0, 0.0)));

    // Aerial perspective, from the same model the ground uses. Distances are metres
    // here and kilometres in the atmosphere.
    let transmittance = sbAerial(input.vDist * 0.001);
    let hazed = lit * transmittance + sbHazeColor(input.vView) * (vec3f(1.0) - transmittance);

    fragmentOutputs.color = vec4f(hazed * exp2(uniforms.spExposure), alpha);
}
