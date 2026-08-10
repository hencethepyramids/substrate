// The substrate relaxation pass. One draw per frame into the back buffer of a
// ping-pong pair, reading the front.
//
// Slump toward the angle of repose, isotropic diffusion, and half-life recovery — in
// that order, all from the six element numbers in substrateParams and nothing else.
// The architectural test for this file is that snow, sand and ash differ by those
// numbers and by no line of code, so there is no branch on biome anywhere below.
//
// It does not include substrateBuffer. That file declares the texture this pass
// WRITES, and a pass cannot bind its own render target as a sampler.

#include<substratePack>
#include<substrateTerrainField>
#include<substrateParams>

varying vUV: vec2f;

var srPrevSampler: sampler;
var srPrev: texture_2d<f32>;

/// Last frame's airborne buffer. Only its G channel is read: what the air owes the
/// ground. The airborne pass never edits the substrate itself — it records the debt and
/// this pass pays it, so the ground stays the only thing that writes the ground.
var srAirborneSampler: sampler;
var srAirborne: texture_2d<f32>;

/// Last frame's heat buffer. Only its G channel is read: phase. The heat pass owns that
/// value; this mirrors it into the A channel so everything already reading the ground
/// through substrateBuffer sees it without a second binding.
var srFireSampler: sampler;
var srFire: texture_2d<f32>;

/// Texels across the window.
uniform srSize: f32;
/// Metres per texel.
uniform srTexel: f32;
/// World XZ of the window's minimum corner, this frame.
uniform srOrigin: vec2f;
/// Whole-texel offset from this frame's window to last frame's: old = new + shift.
uniform srShift: vec2f;
/// x: timestep in seconds, y: reset, z: relaxation rate, w: unused.
uniform srStep: vec4f;
/// xy: world centre, z: radius in metres, w: depth in metres. Zero depth is no stamp.
uniform srStamp: vec4f;

/// Which kernel the queued stamp uses. 1 = the volume-neutral bowl above, 0 = the pure
/// Gaussian below, which moves material into or out of the world instead of around it.
uniform srStampKind: f32;

/// Most of its loose mass a texel may hand to any ONE neighbour in a step. The eight
/// neighbours are weighted 1 (axial) and 1/sqrt2 (diagonal) and sum to 6.83, so 0.14
/// caps total outflow just under the mass actually present. That cap is what stops a
/// steep edge mining material out of nothing.
const SR_MAX_SHARE: f32 = 0.14;

/// Explicit diffusion on a normalised Laplacian goes unstable above about 1/4.
const SR_MAX_DIFF: f32 = 0.24;

/// diffusionRate is quoted against this cell size, so changing the window resolution
/// resamples the same physical spreading instead of changing its rate.
const SR_DIFF_TEXEL: f32 = 0.0625;

/// SIZED SO THE CEILING ABOVE IS NEVER THE OPERATING POINT.
///
/// alpha is proportional to dt, so the pass is frame-rate independent — but only while
/// it is under SR_MAX_DIFF. The moment it clamps, alpha stops tracking dt and two
/// things break at once: the spreading rate becomes frame-rate dependent, and every
/// element fast enough to clamp diffuses identically, so diffusionRate quietly stops
/// telling desert apart from volcanic. That is the exact failure this project is built
/// to avoid, and it is invisible on a fast machine — at 238 fps only ash clamps, at
/// 60 fps both ash and sand do.
///
/// So this is solved rather than dialled: the FASTEST element (ash, 0.46, cohesion
/// 0.008) at the DEFAULT rate (4) must stay under the ceiling at the LONGEST step the
/// simulation will take (MAX_STEP, 1/30 s, in substrate/substrate.ts):
///
///     0.46 * 0.992 * 4 * (1/30) * gain <= 0.20   ->   gain <= 3.29
///
/// The relaxRate slider can still push past the ceiling at its extreme, which is fine —
/// that is a deliberate "go faster" control. The default must never sit there.
const SR_DIFF_GAIN: f32 = 3.2;

/// Depth at which a raised lip counts as fully berm rather than floor, for the
/// slumpAnisotropy split.
const SR_BERM_REF: f32 = 0.05;

/// Compaction gained per metre of stamped depth in fully cohesive material.
const SR_PACK_GAIN: f32 = 6.0;

/// Compaction outlives the hollow that made it — packed snow is still packed after the
/// print has filled in — so it decays over four half-lives rather than one.
const SR_PACK_PERSIST: f32 = 4.0;

/// Nothing this system does is allowed to move the ground by more than this.
const SR_MAX_OFFSET: f32 = 2.0;

/// Last frame's state at a texel of THIS frame's window.
///
/// The window is snapped to its own texel grid, so a frame's scroll is always a whole
/// number of texels and the resample is an exact copy rather than a filter — walking
/// cannot smear the buffer. Texels the window has newly uncovered read as undisturbed.
fn srPrevAt(c: vec2i) -> vec4f {
    let p = c + vec2i(round(uniforms.srShift));
    let m = i32(uniforms.srSize) - 1;
    let inside = all(p >= vec2i(0, 0)) && all(p <= vec2i(m, m));
    return select(vec4f(0.0), textureLoad(srPrev, clamp(p, vec2i(0, 0), vec2i(m, m)), 0), inside);
}

/// What the air owes this texel, from last frame's airborne step.
///
/// Shifted exactly as srPrevAt is: that buffer was written in LAST frame's window, so
/// the same whole-texel scroll applies. Reading it unshifted would drag every deposit
/// backwards across the ground at walking pace.
fn srOwedAt(c: vec2i) -> f32 {
    let p = c + vec2i(round(uniforms.srShift));
    let m = i32(uniforms.srSize) - 1;
    let inside = all(p >= vec2i(0, 0)) && all(p <= vec2i(m, m));
    let v = textureLoad(srAirborne, clamp(p, vec2i(0, 0), vec2i(m, m)), 0).g;
    return select(0.0, v, inside);
}

/// Phase at this texel, from last frame's heat step. Shifted exactly as srPrevAt is.
fn srPhaseAt(c: vec2i) -> f32 {
    let p = c + vec2i(round(uniforms.srShift));
    let m = i32(uniforms.srSize) - 1;
    let inside = all(p >= vec2i(0, 0)) && all(p <= vec2i(m, m));
    return select(0.0, textureLoad(srFire, clamp(p, vec2i(0, 0), vec2i(m, m)), 0).g, inside);
}

fn srWorldOf(c: vec2i) -> vec2f {
    return uniforms.srOrigin + (vec2f(c) + 0.5) * uniforms.srTexel;
}

/// Volume-neutral radial kernel: a pit inside `radius` and its own rim outside it.
///
/// f(u) = (1 - u^2) e^(-u^2), whose integral over the plane is
/// 2*pi * INT[0,inf] (u - u^3) e^(-u^2) du = 2*pi * (1/2 - 1/2) = 0, exactly. So the
/// material a stamp pushes down is precisely the material it heaps up and nothing
/// downstream has to trust a fudge factor to keep the volume books straight. Its
/// steepest face is 0.736 * depth / radius, which is the number to compare against
/// tan(repose) when asking whether a given pit should collapse.
fn srStampKernel(worldXZ: vec2f) -> f32 {
    let d = worldXZ - uniforms.srStamp.xy;
    let u2 = dot(d, d) / max(uniforms.srStamp.z * uniforms.srStamp.z, 1e-6);
    return (1.0 - u2) * exp(-u2);
}

/// Press the current stamp into a state.
///
/// Applied on every read, including all eight neighbours, so the whole stencil sees the
/// same world — rather than the centre texel seeing a pit its neighbours have not heard
/// about, which would make the first frame of any carve non-conservative.
/// NOT volume-neutral, and that is the entire point.
///
/// g(u) = e^(-u^2), whose integral over the plane is exactly pi * radius^2. Where the bowl
/// above conserves material by construction — everything it pushes down it heaps up — this
/// one has a known, non-zero volume, which is what makes it usable as a TRANSFER. Material
/// leaves the ground here and has to go somewhere; the caller is trusted to be holding it.
///
/// Stating the integral in closed form is what lets substrate.ts take a VOLUME in cubic
/// metres and solve for the amplitude, rather than exposing an amplitude and hoping the
/// bookkeeping downstream matches. Conservation then holds by construction instead of by
/// measurement: what a scoop removes is the number the caller asked to be given.
fn srScoopKernel(worldXZ: vec2f) -> f32 {
    let d = worldXZ - uniforms.srStamp.xy;
    let u2 = dot(d, d) / max(uniforms.srStamp.z * uniforms.srStamp.z, 1e-6);
    return exp(-u2);
}

fn srStamped(state: vec4f, worldXZ: vec2f) -> vec4f {
    let amount = uniforms.srStamp.w;

    // A TRANSFER, NOT A DISPLACEMENT. Positive lifts material out and leaves a hollow with
    // no rim, because the material is not beside the hole — it is in the player's hands.
    // Negative puts it back as loose mass sitting proud of the surface, which is what a
    // dropped shovelful is: heaped, uncompacted, and free to slump at the angle of repose
    // the very next relaxation step.
    if (uniforms.srStampKind < 0.5) {
        let g = srScoopKernel(worldXZ) * amount;
        var t = state;
        // SIGNED INTO DEPRESSION, which is the same convention the bowl above uses for its
        // pit and its rim: positive is a hollow, negative stands proud. The first version
        // wrote only max(g, 0) here and put the deposit into mass alone — the books
        // balanced perfectly and the ground never rose, because nothing had told the
        // surface it was higher. The depression debug view showed it immediately: a red
        // hollow where the material was dug and nothing at all where it was dropped.
        t.x = t.x + g;
        // Material that has been carried and dropped is LOOSE. Only the deposit adds mass,
        // because only the deposit is placing something on top of the surface, and that is
        // what lets it slump at the angle of repose on the next relaxation step instead of
        // standing as a permanent cone.
        t.y = t.y + max(-g, 0.0);
        return t;
    }

    let k = srStampKernel(worldXZ);
    let pit = max(k, 0.0);
    let rim = max(-k, 0.0);
    // Cohesive material packs instead of displacing, so the fraction that packs never
    // becomes a rim. This is the difference between a clean print in snow and a
    // collapsing crater in dry sand, and it comes out of cohesion alone.
    let pack = uniforms.spCohesion;
    var s = state;
    s.x = s.x + amount * (pit - rim * (1.0 - pack));
    s.y = s.y + amount * rim * (1.0 - pack);
    s.z = s.z + amount * pit * pack * SR_PACK_GAIN;
    return s;
}

fn srState(c: vec2i) -> vec4f {
    return srStamped(srPrevAt(c), srWorldOf(c));
}

/// Loose material arriving at `me` from `other`, in metres of surface height. Negative
/// when it leaves instead.
///
/// ANTISYMMETRIC BY CONSTRUCTION, which is the whole trick. A fragment shader cannot
/// scatter, so each texel computes both its own outflow and every neighbour's inflow to
/// it. Both ends of a pair pick the same source (the higher one) and read the same two
/// states, so they compute the same number with opposite signs — the gather conserves
/// exactly rather than approximately, and material cannot leak into the gaps between
/// texels over a few thousand frames.
fn srSlumpFlow(me: vec4f, other: vec4f, rise: f32, dist: f32, dt: f32, rate: f32) -> f32 {
    let meHigher = rise > 0.0;
    let src = select(other, me, meHigher);

    // The slope the SOURCE holds, not the destination's: material at the top of a
    // slope is what decides whether the slope stands up.
    let excess = max(abs(rise) - spTanRepose(src.z, src.w) * dist, 0.0);

    // A heaped lip is unsupported on one side; a pit floor is buttressed on three.
    // slumpAnisotropy is that ratio, and it is why snow's berms round off while its
    // walls stay standing.
    let berm = clamp(-src.x / SR_BERM_REF, 0.0, 1.0);
    let speed = rate * mix(1.0, uniforms.spSlumpAnisotropy, berm);

    // Half the excess levels the pair exactly. Past that the slope overshoots and
    // rings instead of settling.
    var q = min(excess * speed * dt, excess * 0.5);
    // Only loose material moves. Undisturbed ground on a 30 degree dune face has no
    // mass to give, which is why the whole landscape does not drain downhill on the
    // first frame the simulation runs.
    q = min(q, src.y * SR_MAX_SHARE);
    return select(q, -q, meHigher);
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let size = uniforms.srSize;
    let texel = uniforms.srTexel;

    // vUV.y grows with the texel row in a render target — Babylon appends a y-flip to
    // every vertex main and yFactor is -1 for any target, measured in Phase 2 — so this
    // is the row textureLoad will read back and no correction belongs here. The boot
    // probe in substrate/substrate.ts checks that against a stamp at a known world
    // position rather than leaving it as an assertion; this project has shipped a
    // silent mirror twice.
    let c = vec2i(floor(input.vUV * size));
    let worldXZ = srWorldOf(c);

    var s = srState(c);

    // One field sample, and the neighbours come off its analytic derivative. Over a
    // 6 cm texel that is more faithful than resampling a 50 cm field, and it costs
    // three instructions instead of thirty-two texture loads.
    let deriv = sbSampleField(worldXZ).yz;

    let dt = uniforms.srStep.x;
    let rate = uniforms.srStep.z;

    var inflow = 0.0;
    var lapD = 0.0;
    var lapM = 0.0;
    var lapC = 0.0;
    var wSum = 0.0;

    for (var j = -1; j <= 1; j++) {
        for (var i = -1; i <= 1; i++) {
            if (i == 0 && j == 0) {
                continue;
            }
            let off = vec2f(f32(i), f32(j));
            let len = length(off);
            let w = 1.0 / len;
            let dist = len * texel;
            let n = srState(c + vec2i(i, j));

            // Surface height is terrain minus depression, so how much higher I stand
            // than this neighbour is the depression difference less the terrain's own
            // rise across the offset. Slump has to see the TOTAL surface: a pit dug
            // into a dune face is steeper on its downhill side, and that is exactly
            // the side that should give way first.
            let rise = (n.x - s.x) - dot(deriv, off * texel);

            inflow += w * srSlumpFlow(s, n, rise, dist, dt, rate);
            lapD += w * (n.x - s.x);
            lapM += w * (n.y - s.y);
            lapC += w * (n.z - s.z);
            wSum += w;
        }
    }

    // Arriving material fills the hollow, and it is loose when it lands.
    s.x = s.x - inflow;
    s.y = s.y + inflow;

    // SETTLE THE DEBT WITH THE AIR. Positive is material coming back down, which raises
    // the surface and therefore reduces the depression, and it lands loose. Negative is
    // material that left.
    //
    // THE EXCHANGE ITSELF IS EXACT — the airborne pass moves precisely this much the
    // other way, so lift and settle cannot invent or destroy anything between them.
    // Ground plus air is nonetheless NOT conserved overall, and it is worth knowing why
    // rather than assuming otherwise: material blows out through the window's open
    // boundary, and the advection is semi-Lagrangian on a divergent 2D field, which only
    // approximates the vertical flux it is standing in for. Measured by
    // scripts/checkConserve.mjs. Losing to the wind is a tuning matter; the version that
    // CREATED material at 50% per ten seconds was not, and that one is fixed.
    let owed = srOwedAt(c);
    s.x = s.x - owed;
    s.y = s.y + owed;

    // Isotropic creep. Cohesion resists it exactly as it resists slump, so one number
    // per element governs both rather than two that can be tuned into disagreement.
    let cohesion = spCohesionAt(s.z, s.w);
    let spread = uniforms.spDiffusionRate * (1.0 - cohesion) * rate * dt * SR_DIFF_GAIN;
    let alpha = min(spread * (SR_DIFF_TEXEL * SR_DIFF_TEXEL) / (texel * texel), SR_MAX_DIFF);
    let inv = alpha / max(wSum, 1e-6);
    s.x = s.x + lapD * inv;
    s.y = s.y + lapM * inv;
    s.z = s.z + lapC * inv;

    // Recovery. 2^(-dt/T) halves every T seconds by construction, so decayHalfLife is
    // read exactly as the registry writes it, with no stray ln 2 to get backwards. Ash
    // quotes 1e9 seconds and therefore never comes back, which is the point of it.
    let half = max(uniforms.spDecayHalfLife, 1e-3);
    let decay = exp2(-dt / half);
    s.x = s.x * decay;
    s.y = s.y * decay;
    s.z = s.z * exp2(-dt / (half * SR_PACK_PERSIST));

    // Mirror phase across from the heat pass, at the very end, so everything above ran on
    // ONE consistent frame of it — the centre texel and its eight neighbours all carrying
    // the same vintage. A quantity that already lags by the element's own phaseLag can
    // afford another frame; a stencil disagreeing with itself cannot.
    s.w = srPhaseAt(c);

    var outColor = vec4f(clamp(s.x, -SR_MAX_OFFSET, SR_MAX_OFFSET), clamp(s.y, 0.0, SR_MAX_OFFSET), clamp(s.z, 0.0, 1.0), clamp(s.w, 0.0, 1.0));

    // Reset clears both buffers: on boot, on a window resize, and when the system is
    // switched off — so turning it off puts the ground back rather than freezing
    // whatever happened to be carved into it.
    outColor = select(outColor, vec4f(0.0), uniforms.srStep.y > 0.5);

    // SINGLE EXIT POINT. Babylon appends its own `return fragmentOutputs;`, so a bare
    // `return;` above would be invalid WGSL and this whole shader would fail to build.
    fragmentOutputs.color = outColor;
}
