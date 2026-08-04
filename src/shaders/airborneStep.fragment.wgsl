// The airborne material step. One draw per frame into the back buffer of a ping-pong
// pair, on the substrate's own window and texel grid.
//
// Three things happen here and they are the whole of aeolian transport:
//
//   LIFT   loose material past liftThreshold, where the surface shear is high enough,
//          leaves the ground at a rate set by windSusceptibility.
//   RIDE   what is airborne is carried by the velocity field, semi-Lagrangian, so the
//          step is stable no matter how fast the wind blows.
//   SETTLE it drops out where the air has slowed or separated -- which is the lee of a
//          crest, which is why a slip face grows and a dune moves.
//
// It does NOT edit the ground. It records what it owes in the exchange channel and the
// relaxation pass applies it, so the substrate stays the only thing that writes the
// substrate.

#include<substratePack>
#include<substrateTerrainField>
#include<substrateNoise>
#include<substrateAir>
#include<substrateParams>
#include<substrateBuffer>

varying vUV: vec2f;

var abPrevSampler: sampler;
var abPrev: texture_2d<f32>;

/// x: timestep, y: reset, z: lift rate, w: settle rate.
uniform abStep: vec4f;
/// Whole-texel scroll from this frame's window to last frame's, exactly as the substrate
/// computes it: old = new + shift.
uniform abShift: vec2f;

/// Shear below which nothing is held up any more. Above it, suspension survives.
const AB_HOLD_SHEAR: f32 = 1.0;
/// How much of the settling a fully attached, fully sheared flow suppresses.
const AB_HOLD_MAX: f32 = 0.85;
/// Ceiling on suspended load, metres equivalent. Whiteout, not a singularity.
const AB_MAX_DENSITY: f32 = 4.0;

/// Last frame's buffer at a fractional texel of THIS frame's window.
///
/// Bilinear, because advection lands between texels by definition — unlike the
/// substrate's own scroll, which is a whole number of texels and stays a pure copy.
fn abPrevAt(texel: vec2f) -> vec4f {
    let p = texel + uniforms.abShift;
    let i = floor(p);
    let f = p - i;
    let c = vec2i(i);
    let m = i32(uniforms.sbSubSize) - 1;

    let inside = all(c >= vec2i(-1, -1)) && all(c <= vec2i(m, m));
    let v00 = textureLoad(abPrev, clamp(c + vec2i(0, 0), vec2i(0, 0), vec2i(m, m)), 0);
    let v10 = textureLoad(abPrev, clamp(c + vec2i(1, 0), vec2i(0, 0), vec2i(m, m)), 0);
    let v01 = textureLoad(abPrev, clamp(c + vec2i(0, 1), vec2i(0, 0), vec2i(m, m)), 0);
    let v11 = textureLoad(abPrev, clamp(c + vec2i(1, 1), vec2i(0, 0), vec2i(m, m)), 0);
    let v = mix(mix(v00, v10, f.x), mix(v01, v11, f.x), f.y);
    return select(vec4f(0.0), v, inside);
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let size = uniforms.sbSubSize;
    let texelMetres = uniforms.sbSubExtent / size;

    let c = vec2i(floor(input.vUV * size));
    let worldXZ = uniforms.sbSubOrigin + (vec2f(c) + 0.5) * texelMetres;

    let dt = uniforms.abStep.x;
    let deriv = sbSampleField(worldXZ).yz;
    let air = sbAirAt(worldXZ, deriv);

    // RIDE. Trace backwards along the wind and read where this parcel came from.
    // Semi-Lagrangian, so a gale cannot outrun the step the way an explicit advection
    // would — the CFL limit stops being a limit.
    let backTexel = (vec2f(c) + 0.5) - air.velocity.xz * (dt / texelMetres);
    var density = abPrevAt(backTexel).r;

    // LIFT. Only the loose material above the element's threshold is available, and only
    // where the flow still has shear to give. This is the one place windSusceptibility
    // and liftThreshold are read, and between them they are why ash leaves the ground in
    // a breeze and packed snow does not.
    let ground = sbSubTexel(c);
    let loose = max(ground.g - uniforms.spLiftThreshold, 0.0);
    let drive = max(air.shear - 1.0, 0.0) * (1.0 - air.separated);
    let lift = min(loose, loose * drive * uniforms.spWindSusceptibility * uniforms.abStep.z * dt);

    // SETTLE. Suspension survives where the air is moving and drops out where it has
    // slowed or detached. That asymmetry is the entire reason material accumulates on a
    // slip face rather than being carried onward forever.
    let hold = clamp(air.shear / AB_HOLD_SHEAR, 0.0, 1.0) * (1.0 - air.separated);
    let settle = min(density + lift, (density + lift) * uniforms.abStep.w * (1.0 - hold * AB_HOLD_MAX) * dt);

    density = clamp(density + lift - settle, 0.0, AB_MAX_DENSITY);

    // What the ground is owed. Positive is material coming back down.
    let exchange = settle - lift;

    var outColor = vec4f(density, exchange, 0.0, 0.0);
    outColor = select(outColor, vec4f(0.0), uniforms.abStep.y > 0.5);

    // Single exit point — Babylon appends its own return.
    fragmentOutputs.color = outColor;
}
