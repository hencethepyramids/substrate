// The heat step. One draw per frame into the back buffer of a ping-pong pair, on the
// substrate's own window and texel grid.
//
// Heat conducts through the ground, is lost to the air, and drags phase along behind it.
// It does not advect: heat is IN the material, and the material is not going anywhere —
// which is the whole difference between this pass and the airborne one, and why this one
// needs no Jacobian and no open-boundary caveat.
//
// It writes phase but does not write the substrate. The relaxation pass mirrors the phase
// channel across, so the ground stays the only thing that writes the ground.

// ONLY the numbers. substrateTerrainField was included here at first out of habit, and
// it declares sbFieldTex — which obliged this pass to bind a heightfield it never reads,
// and cost a boot full of Babylon bind-group errors. Heat does not need to know where the
// ground is; it only needs to know what the ground is made of.
#include<substrateFireParams>

varying vUV: vec2f;

var frPrevSampler: sampler;
var frPrev: texture_2d<f32>;

/// x: timestep, y: reset, z: unused, w: unused.
uniform frStep: vec4f;
/// Whole-texel scroll from this frame's window to last frame's: old = new + shift.
uniform frShift: vec2f;
/// World XZ of the window's minimum corner, and its size.
uniform frOrigin: vec2f;
uniform frExtent: f32;
uniform frSize: f32;
/// xy world centre, z radius in metres, w heat added per second. Zero radius is no source.
uniform frSource: vec4f;

/// Explicit diffusion on a normalised Laplacian is unstable above about 1/4.
const FR_MAX_DIFF: f32 = 0.24;
/// Heat cannot exceed this. Normalised units — 1 is as hot as this world gets.
const FR_MAX_HEAT: f32 = 1.0;

fn frPrevAt(c: vec2i) -> vec4f {
    let p = c + vec2i(round(uniforms.frShift));
    let m = i32(uniforms.frSize) - 1;
    let inside = all(p >= vec2i(0, 0)) && all(p <= vec2i(m, m));
    return select(vec4f(0.0), textureLoad(frPrev, clamp(p, vec2i(0, 0), vec2i(m, m)), 0), inside);
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let size = uniforms.frSize;
    let texel = uniforms.frExtent / size;

    let c = vec2i(floor(input.vUV * size));
    let worldXZ = uniforms.frOrigin + (vec2f(c) + 0.5) * texel;

    let dt = uniforms.frStep.x;
    var s = frPrevAt(c);

    // CONDUCTION. Eight neighbours weighted 1 and 1/sqrt2, the same stencil the
    // relaxation uses, so heat spreads as round as slump does rather than in a cross.
    var lap = 0.0;
    var wSum = 0.0;
    for (var j = -1; j <= 1; j++) {
        for (var i = -1; i <= 1; i++) {
            if (i == 0 && j == 0) {
                continue;
            }
            let w = 1.0 / length(vec2f(f32(i), f32(j)));
            lap += w * (frPrevAt(c + vec2i(i, j)).r - s.r);
            wSum += w;
        }
    }
    // Conductivity is quoted in m2/s, so it converts through the cell size like any
    // diffusivity, and the clamp is the explicit-stability ceiling rather than a taste.
    let alpha = min(uniforms.fpConductivity * dt / (texel * texel), FR_MAX_DIFF);
    s.r = s.r + lap * (alpha / max(wSum, 1.0e-6));

    // SOURCE. Radial, so an ignition point is a hot spot rather than a hot square.
    let d = length(worldXZ - uniforms.frSource.xy);
    let r = max(uniforms.frSource.z, 1.0e-4);
    let falloff = exp(-(d * d) / (r * r));
    s.r = s.r + uniforms.frSource.w * falloff * dt;

    // COOLING to the air. Exponential, so it approaches ambient rather than crossing it.
    s.r = s.r * exp(-uniforms.fpCooling * dt);
    s.r = clamp(s.r, 0.0, FR_MAX_HEAT);

    // PHASE follows heat, but late. That lag is not a smoothing convenience: it is what
    // a crust IS. Rock at the surface sets while the rock beneath it is still molten, and
    // volcanic's six seconds against snow's four tenths is the whole difference between
    // a flow that carries a skin and a puddle that does not.
    // `target` is a RESERVED KEYWORD in WGSL, which is why this is not called that. It
    // reads like an ordinary variable name and nothing but the driver objects.
    let settled = fpPhaseTarget(s.r);
    let k = 1.0 - exp(-dt / max(uniforms.fpPhaseLag, 1.0e-3));
    s.g = clamp(s.g + (settled - s.g) * k, 0.0, 1.0);

    var outColor = vec4f(s.r, s.g, 0.0, 0.0);
    outColor = select(outColor, vec4f(0.0), uniforms.frStep.y > 0.5);

    // Single exit point — Babylon appends its own return.
    fragmentOutputs.color = outColor;
}
