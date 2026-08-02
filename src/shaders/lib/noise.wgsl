// SHARED INCLUDE — substrateNoise
//
// Gradient noise carrying analytic derivatives. Every function here returns
// vec3f(value, d/dx, d/dy) rather than a bare value, and every domain transform
// below comes with the Jacobian needed to bring a gradient back to world space.
//
// This is not a stylistic preference. Finite-differencing the heightfield would
// need extra taps per vertex, would disagree between the beauty pass and the
// shadow cascades, and would give a normal that is wrong by half a texel exactly
// where the terrain is most curved. It is also what makes the fBm below able to
// damp its own detail by slope, which is the single largest contributor to the
// terrain reading as landform rather than as noise.

const SB_TAU_OVER_U32: f32 = 1.4629180792671596e-9; // 2*pi / 2^32

/// Unit-length gradient vector for an integer lattice point.
fn sbHash2(p: vec2i) -> vec2f {
    var n: u32 = u32(p.x) * 1597334673u + u32(p.y) * 3812015801u;
    n = (n ^ (n >> 16u)) * 2246822519u;
    n = (n ^ (n >> 13u)) * 3266489917u;
    n = n ^ (n >> 16u);
    let angle = f32(n) * SB_TAU_OVER_U32;
    return vec2f(cos(angle), sin(angle));
}

/// Gradient noise in [-1,1] with exact derivatives. Quintic interpolant, so the
/// second derivative is continuous too and the shading has no facet banding.
fn sbNoiseD(p: vec2f) -> vec3f {
    let i = floor(p);
    let f = p - i;
    let ii = vec2i(i);

    let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    let du = 30.0 * f * f * (f * (f - 2.0) + 1.0);

    let ga = sbHash2(ii + vec2i(0, 0));
    let gb = sbHash2(ii + vec2i(1, 0));
    let gc = sbHash2(ii + vec2i(0, 1));
    let gd = sbHash2(ii + vec2i(1, 1));

    let va = dot(ga, f - vec2f(0.0, 0.0));
    let vb = dot(gb, f - vec2f(1.0, 0.0));
    let vc = dot(gc, f - vec2f(0.0, 1.0));
    let vd = dot(gd, f - vec2f(1.0, 1.0));

    let k1 = vb - va;
    let k2 = vc - va;
    let k3 = va - vb - vc + vd;

    let value = va + k1 * u.x + k2 * u.y + k3 * u.x * u.y;

    let grad = ga + u.x * (gb - ga) + u.y * (gc - ga) + u.x * u.y * (ga - gb - gc + gd) + du * vec2f(k1 + k3 * u.y, k2 + k3 * u.x);

    return vec3f(value, grad);
}

/// fBm with slope damping. Where the surface accumulated so far is already steep,
/// finer octaves are suppressed — which is what carves smooth valley floors and
/// leaves crisp ridge lines instead of spreading uniform fuzz over everything.
/// Only possible because the derivative is exact at every octave.
fn sbFbmD(p0: vec2f, octaves: i32, lacunarity: f32, gain: f32, damping: f32) -> vec3f {
    var p = p0;
    var amp = 1.0;
    var freq = 1.0;
    var sum = 0.0;
    var grad = vec2f(0.0);
    var norm = 0.0;

    for (var i = 0; i < octaves; i = i + 1) {
        let n = sbNoiseD(p);
        let damp = 1.0 / (1.0 + damping * dot(grad, grad));
        sum = sum + amp * n.x * damp;
        grad = grad + amp * freq * n.yz * damp;
        norm = norm + amp;
        amp = amp * gain;
        freq = freq * lacunarity;
        p = p * lacunarity;
    }

    let inv = 1.0 / max(norm, 1e-6);
    return vec3f(sum * inv, grad * inv);
}

/// Ridged multifractal. r = (1 - |n|)^2, so dr = -2(1-|n|)*sign(n)*dn.
/// Volcanic flow levees and fracture lines come from this.
fn sbRidgedD(p0: vec2f, octaves: i32, lacunarity: f32, gain: f32) -> vec3f {
    var p = p0;
    var amp = 1.0;
    var freq = 1.0;
    var sum = 0.0;
    var grad = vec2f(0.0);
    var norm = 0.0;

    for (var i = 0; i < octaves; i = i + 1) {
        let n = sbNoiseD(p);
        let s = select(-1.0, 1.0, n.x >= 0.0);
        let r = 1.0 - abs(n.x);
        sum = sum + amp * r * r;
        grad = grad - amp * freq * 2.0 * r * s * n.yz;
        norm = norm + amp;
        amp = amp * gain;
        freq = freq * lacunarity;
        p = p * lacunarity;
    }

    let inv = 1.0 / max(norm, 1e-6);
    return vec3f(sum * inv, grad * inv);
}

// -- domain transforms, each with its Jacobian --------------------------------

/// Rotate into the wind frame and stretch along it. Stretch > 1 elongates features
/// across the wind, which is what makes dune crests read as transverse ridges
/// rather than as blobs.
fn sbAniso(p: vec2f, dir: vec2f, stretch: f32) -> vec2f {
    return vec2f(dot(p, dir) / stretch, dot(p, vec2f(-dir.y, dir.x)));
}

/// Bring a gradient measured in sbAniso space back to world space: dn/dp = M^T dn/dq.
fn sbAnisoGrad(g: vec2f, dir: vec2f, stretch: f32) -> vec2f {
    return vec2f(g.x * dir.x / stretch - g.y * dir.y, g.x * dir.y / stretch + g.y * dir.x);
}

struct SbShear {
    p: vec2f,
    /// Gradient of the shear offset, already scaled by amplitude and frequency.
    g: vec2f,
};

/// Displace the domain along the wind by a noise field. This is what gives drifts
/// their lee-face asymmetry: the windward side gets stretched and the lee side
/// compressed, so slip faces steepen on one side only.
///
/// p' = p + dir * (amp * w(p*freq))  =>  J = I + amp*freq * outer(dir, grad w)
fn sbShearDomain(p: vec2f, dir: vec2f, freq: f32, amp: f32) -> SbShear {
    let w = sbNoiseD(p * freq + vec2f(37.2, 91.5));
    var s: SbShear;
    s.p = p + dir * (amp * w.x);
    s.g = amp * freq * w.yz;
    return s;
}

/// (J^T v)_i = v_i + amp*freq * grad_i * dot(v, dir)
fn sbShearGrad(gWarped: vec2f, dir: vec2f, s: SbShear) -> vec2f {
    return gWarped + s.g * dot(gWarped, dir);
}

/// Smoothstep with its derivative, for thresholded features (rock outcrops) that
/// still need a continuous normal.
fn sbSmoothstepD(e0: f32, e1: f32, x: f32) -> vec2f {
    let inv = 1.0 / max(e1 - e0, 1e-6);
    let t = clamp((x - e0) * inv, 0.0, 1.0);
    return vec2f(t * t * (3.0 - 2.0 * t), 6.0 * t * (1.0 - t) * inv);
}
