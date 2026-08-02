// SHARED INCLUDE — substrateShadow
//
// Three cascades in one atlas, sampled with PCSS. Every lit material includes this,
// so the terrain and the character are shadowed by the same code reading the same
// texture — there is no second path that can drift.
//
// ON THE ATLAS AND ITS ORIENTATION. Cascade c occupies the x range [c/3, (c+1)/3].
// The v axis needs no flip: the cast pass writes through shViewProj and this reads
// through the same matrix, so whatever Babylon's yFactor does to clip.y happens on
// both sides and cancels. Concretely, a cast vertex at clip y = Y lands on row
// (1+Y)/2 * H, and sampling at v = Y*0.5+0.5 reads row v*H — the same row. That
// cancellation is why this is the one orientation in the project that did not need
// to be measured.

var shMapSampler: sampler;
var shMap: texture_2d<f32>;

uniform shMatrix0: mat4x4f;
uniform shMatrix1: mat4x4f;
uniform shMatrix2: mat4x4f;
/// x,y,z: far distance of each cascade in metres. w: cross-fade band, metres.
uniform shSplits: vec4f;
/// World metres covered by one shadow texel, per cascade. w unused.
uniform shTexelWorld: vec4f;
/// Depth range over lateral extent, per cascade. Converts a depth difference into
/// the same units the uv offsets are in. w unused.
uniform shDepthScale: vec4f;
/// x: enabled. y: depth bias in light-space units. z: normal-offset in texels.
/// w: light angular size, as a fraction of a cascade's extent.
uniform shParams: vec4f;
/// x: PCF tap count. y: blocker search tap count. z: softness scale. w: debug view.
uniform shControl: vec4f;

const SH_CASCADES: f32 = 3.0;
const SH_GOLDEN_ANGLE: f32 = 2.3999632;

/// One texel of the atlas, in atlas UV. x is a third as wide as it looks.
fn shTexelUv() -> vec2f {
    let dims = vec2f(textureDimensions(shMap, 0));
    return vec2f(1.0, 1.0) / dims;
}

/// Nearest read of a cascade, in that cascade's own [0,1] coordinates.
///
/// The uv is clamped BEFORE it is folded into the atlas. Clamping afterwards, or
/// leaving it to the sampler's address mode, would let a tap that walks off the left
/// edge of cascade 1 land in cascade 0 and report an occluder from a completely
/// different projection.
fn shDepthAt(c: i32, uv: vec2f) -> f32 {
    let inside = clamp(uv, vec2f(0.0), vec2f(1.0));
    let atlas = vec2f((inside.x + f32(c)) / SH_CASCADES, inside.y);
    return textureSampleLevel(shMap, shMapSampler, atlas, 0.0).r;
}

fn shMatrixFor(c: i32) -> mat4x4f {
    var m = uniforms.shMatrix2;
    if (c == 0) {
        m = uniforms.shMatrix0;
    } else if (c == 1) {
        m = uniforms.shMatrix1;
    }
    return m;
}

fn shTexelWorldFor(c: i32) -> f32 {
    var t = uniforms.shTexelWorld.z;
    if (c == 0) {
        t = uniforms.shTexelWorld.x;
    } else if (c == 1) {
        t = uniforms.shTexelWorld.y;
    }
    return t;
}

fn shDepthScaleFor(c: i32) -> f32 {
    var t = uniforms.shDepthScale.z;
    if (c == 0) {
        t = uniforms.shDepthScale.x;
    } else if (c == 1) {
        t = uniforms.shDepthScale.y;
    }
    return t;
}

/// Vogel disk. A spiral rather than a stored Poisson set: no array to index
/// dynamically, even coverage at any tap count, and the per-pixel rotation turns
/// what would be visible banding into noise that Phase 9's TAA can eat.
fn shDiskTap(i: i32, count: i32, rotation: f32) -> vec2f {
    let r = sqrt((f32(i) + 0.5) / f32(count));
    let theta = f32(i) * SH_GOLDEN_ANGLE + rotation;
    return vec2f(cos(theta), sin(theta)) * r;
}

fn shDither(p: vec3f) -> f32 {
    return fract(sin(dot(p.xz, vec2f(12.9898, 78.233))) * 43758.5453) * 6.2831853;
}

/// PCSS against one cascade. 1 = fully lit.
///
/// Three steps, and the middle one is the whole point: search for blockers over a
/// wide area, turn the average blocker distance into a penumbra width, then filter
/// at that width. A contact shadow under the character stays tight while the shadow
/// of a ridge a hundred metres away goes soft, which a fixed-radius PCF cannot do.
fn shCascadeVisibility(c: i32, world: vec3f, n: vec3f, ndl: f32) -> f32 {
    let texelWorld = shTexelWorldFor(c);

    // Normal offset. Moving the lookup along the surface normal rather than biasing
    // depth is what keeps steep slopes free of acne without detaching contact
    // shadows; scale it by the texel footprint and by how grazing the light is.
    let slope = clamp(1.0 - ndl, 0.0, 1.0);
    let offset = world + n * (texelWorld * uniforms.shParams.z * (0.5 + slope));

    let m = shMatrixFor(c);
    let proj = m * vec4f(offset, 1.0);
    let ndc = proj.xyz / proj.w;
    let uv = ndc.xy * 0.5 + vec2f(0.5);
    let receiver = ndc.z;

    // RECEIVER PLANE DEPTH BIAS.
    //
    // A constant bias only works if every tap lands on the receiver itself. These
    // taps wander — over a metre in the near cascade — and a tap that far away on a
    // 15 degree slope sits a third of a metre nearer the light, so the surface
    // reports ITSELF as its own occluder and everything goes dark. That is what was
    // happening: shadow that scaled with the filter radius rather than with any
    // actual caster.
    //
    // The fix is to compare against the depth the receiver's own tangent plane would
    // have at each tap, not against a single depth. The gradient falls straight out
    // of the normal: transforming it by the cascade matrix already folds in the
    // ortho scales, so d(depth)/d(uv) is just -2 * nl.xy / nl.z. Clamped because a
    // surface edge-on to the light has an infinite one.
    let nl = (m * vec4f(n, 0.0)).xyz;
    let denom = select(min(nl.z, -1e-3), max(nl.z, 1e-3), nl.z >= 0.0);
    let plane = clamp(-2.0 * nl.xy / denom, vec2f(-64.0), vec2f(64.0));

    var visibility = 1.0;
    if (uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0 && receiver > 0.0 && receiver < 1.0) {
        let bias = uniforms.shParams.y * (1.0 + 2.0 * slope);
        let rotation = shDither(world);

        // 1. Blocker search. Deliberately NOT scaled by softness: softness is how
        //    wide the penumbra gets, not whether a caster is found at all, and
        //    folding it in here meant softness 0 stopped finding blockers and
        //    produced no shadows rather than hard ones.
        let searchTaps = i32(clamp(uniforms.shControl.y, 4.0, 32.0));
        let searchRadius = clamp(uniforms.shParams.w * shDepthScaleFor(c) * 0.5, shTexelUv().y * 2.0, 0.05);
        var blockerSum = 0.0;
        var blockerCount = 0.0;
        for (var i = 0; i < searchTaps; i = i + 1) {
            let duv = shDiskTap(i, searchTaps, rotation) * searchRadius;
            let d = shDepthAt(c, uv + duv);
            if (d < receiver + dot(plane, duv) - bias) {
                blockerSum = blockerSum + d;
                blockerCount = blockerCount + 1.0;
            }
        }

        if (blockerCount > 0.0) {
            // 2. Penumbra width. The textbook PCSS ratio divides by the blocker
            //    depth, but that is the PERSPECTIVE form — it assumes the light is a
            //    point and the shadow map diverges from it. These cascades are
            //    orthographic: a directional light's penumbra grows with the
            //    receiver-to-blocker separation alone, at a rate set by the sun's
            //    angular size. Dividing by blocker here made the penumbra depend on
            //    where the caster happened to sit between the near and far planes,
            //    which is a number with no physical meaning at all.
            //
            //    Floored at one texel so a fully occluded contact still filters over
            //    something. One texel in CASCADE uv is 1/resolution, which is what
            //    shTexelUv().y is — the x component is a third of that because the
            //    atlas is three cascades wide, and shDepthAt does that fold itself.
            let blocker = blockerSum / blockerCount;
            let separation = max(receiver - blocker, 0.0) * shDepthScaleFor(c);
            let radius = max(uniforms.shParams.w * uniforms.shControl.z * separation, shTexelUv().y);

            // 3. PCF at that radius.
            let taps = i32(clamp(uniforms.shControl.x, 4.0, 64.0));
            var lit = 0.0;
            for (var i = 0; i < taps; i = i + 1) {
                let duv = shDiskTap(i, taps, rotation) * radius;
                let d = shDepthAt(c, uv + duv);
                lit = lit + select(1.0, 0.0, d < receiver + dot(plane, duv) - bias);
            }
            visibility = lit / f32(taps);
        }
    }
    return visibility;
}

/// Visibility of the sun at a world position. 1 = lit.
///
/// Cascades cross-fade over the last `shSplits.w` metres of each range rather than
/// switching hard, because the two cascades disagree slightly about penumbra width
/// and a hard switch draws that disagreement as a line across the ground.
fn shVisibility(world: vec3f, n: vec3f, ndl: f32, viewDist: f32) -> f32 {
    var visibility = 1.0;
    if (uniforms.shParams.x > 0.5 && viewDist < uniforms.shSplits.z) {
        var c = 2;
        if (viewDist < uniforms.shSplits.x) {
            c = 0;
        } else if (viewDist < uniforms.shSplits.y) {
            c = 1;
        }

        visibility = shCascadeVisibility(c, world, n, ndl);

        // Blend into the next cascade near this one's far edge.
        let band = max(uniforms.shSplits.w, 1e-3);
        var edge = uniforms.shSplits.z;
        if (c == 0) {
            edge = uniforms.shSplits.x;
        } else if (c == 1) {
            edge = uniforms.shSplits.y;
        }
        let t = clamp((viewDist - (edge - band)) / band, 0.0, 1.0);
        if (t > 0.0 && c < 2) {
            visibility = mix(visibility, shCascadeVisibility(c + 1, world, n, ndl), t);
        } else if (t > 0.0) {
            // Last cascade fades to lit rather than ending in a wall of shadow.
            visibility = mix(visibility, 1.0, t);
        }
    }
    return visibility;
}

/// Which cascade a distance lands in, as a hue. For the `cascades` debug view.
fn shCascadeTint(viewDist: f32) -> vec3f {
    var tint = vec3f(0.35, 0.35, 1.0);
    if (viewDist >= uniforms.shSplits.z) {
        tint = vec3f(0.4, 0.4, 0.4);
    } else if (viewDist < uniforms.shSplits.x) {
        tint = vec3f(1.0, 0.35, 0.35);
    } else if (viewDist < uniforms.shSplits.y) {
        tint = vec3f(0.35, 1.0, 0.35);
    }
    return tint;
}
