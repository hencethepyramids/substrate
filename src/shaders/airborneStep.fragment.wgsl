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

/// Wind speed, in m/s, at which material starts to move — the fluid threshold. Below it
/// nothing is picked up no matter how long you wait, which is why a still day leaves a
/// dune alone.
uniform abThreshold: f32;
/// How much of the settling a fully attached, fully sheared flow suppresses.
const AB_HOLD_MAX: f32 = 0.85;
/// Ceiling on suspended load, metres equivalent. Whiteout, not a singularity.
const AB_MAX_DENSITY: f32 = 4.0;

/// Distance over which flow divergence is measured, in metres. Large enough to be above
/// the bilinear heightfield's derivative discontinuities and below the scale the wind
/// actually varies on.
const SB_DIV_H: f32 = 1.0;

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

    // AND CARRY THE JACOBIAN, or the advection invents material.
    //
    // Plain semi-Lagrangian treats the field as intensive: the value follows the parcel
    // unchanged. Density is not intensive. Where the flow DIVERGES the backward map
    // contracts, so many target cells trace into one small source region and all read
    // the same value — the total grows out of nothing. Measured at +50% over ten seconds
    // by scripts/checkConserve.mjs, and this wind diverges wherever it accelerates over
    // a windward face, which is everywhere that matters.
    //
    // The backward map is x - v(x)dt, whose Jacobian determinant is 1 - div(v)dt to
    // first order. Multiplying by it is what makes a parcel thin out as it spreads and
    // concentrate as it piles up, which is the behaviour that was missing.
    // MEASURED OVER A METRE, NOT OVER A TEXEL. The terrain derivative comes from a
    // bilinear field, so it is only C0 — it jumps at every heightfield cell boundary.
    // Differencing the velocity across one 6 cm substrate texel therefore measures that
    // jump rather than the flow, and feeding that noise back as a multiplicative factor
    // compounds: it made the leak five times worse before it was measured. Divergence is
    // a property of the wind, and the wind varies over tens of metres.
    let dx = vec2f(SB_DIV_H, 0.0);
    let dz = vec2f(0.0, SB_DIV_H);
    let ax = sbAirAt(worldXZ + dx, sbSampleField(worldXZ + dx).yz);
    let az = sbAirAt(worldXZ + dz, sbSampleField(worldXZ + dz).yz);
    let bx = sbAirAt(worldXZ - dx, sbSampleField(worldXZ - dx).yz);
    let bz = sbAirAt(worldXZ - dz, sbSampleField(worldXZ - dz).yz);
    let div = ((ax.velocity.x - bx.velocity.x) + (az.velocity.z - bz.velocity.z)) / (2.0 * SB_DIV_H);
    density = density * clamp(1.0 - div * dt, 0.85, 1.15);

    // LIFT. Only the loose material above the element's threshold is available, and only
    // where the flow still has shear to give. This is the one place windSusceptibility
    // and liftThreshold are read, and between them they are why ash leaves the ground in
    // a breeze and packed snow does not.
    // AGAINST A SPEED, NOT A RATIO. `shear` is relative to the free stream and sits at
    // about 1 on flat ground whatever the weather is doing, so driving lift from it made
    // a gale and a breeze identical and let half the field never lift at all. Transport
    // goes as the excess over the fluid threshold times the speed itself — quadratic-ish,
    // which is why aeolian transport is so violently sensitive to wind speed.
    let thresh = max(uniforms.abThreshold, 0.1);
    let excess = max(air.speed - thresh, 0.0);
    let drive = (excess * air.speed) / (thresh * thresh) * (1.0 - air.separated);

    let ground = sbSubTexel(c);
    let loose = max(ground.g - uniforms.spLiftThreshold, 0.0);
    let lift = min(loose, loose * drive * uniforms.spWindSusceptibility * uniforms.abStep.z * dt);

    // SETTLE. Suspension survives where the air is moving and drops out where it has
    // slowed or detached. That asymmetry is the entire reason material accumulates on a
    // slip face rather than being carried onward forever.
    let hold = clamp(air.speed / thresh, 0.0, 1.0) * (1.0 - air.separated);
    let settle = min(density + lift, (density + lift) * uniforms.abStep.w * (1.0 - hold * AB_HOLD_MAX) * dt);

    density = clamp(density + lift - settle, 0.0, AB_MAX_DENSITY);

    // What the ground is owed. Positive is material coming back down.
    let exchange = settle - lift;

    var outColor = vec4f(density, exchange, 0.0, 0.0);
    outColor = select(outColor, vec4f(0.0), uniforms.abStep.y > 0.5);

    // Single exit point — Babylon appends its own return.
    fragmentOutputs.color = outColor;
}
