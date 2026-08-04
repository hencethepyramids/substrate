// SHARED INCLUDE — substrateFireBuffer
//
// Reading the heat buffer. Like the airborne buffer, it rides THE SUBSTRATE'S OWN window
// — same origin, extent, texel grid and snapping — so heat, ground and air all agree
// about where a cell is without anyone resampling anyone. Requires <substrateBuffer> for
// the window uniforms.

var sbFireTexSampler: sampler;
var sbFireTex: texture_2d<f32>;

struct SbFire {
    /// Normalised heat. 0 is ambient; 1 is as hot as this world gets.
    heat: f32,
    /// Phase, lagged behind heat by the element's own phaseLag. This is the authoritative
    /// value; the substrate's A channel is a mirror of it kept for consumers that already
    /// read the ground through substrateBuffer.
    phase: f32,
};

fn sbFireTexel(c: vec2i) -> vec4f {
    let m = i32(uniforms.sbSubSize) - 1;
    return textureLoad(sbFireTex, clamp(c, vec2i(0, 0), vec2i(m, m)), 0);
}

/// Taps in the light-pool disc. Enough to read as a pool rather than as points; few
/// enough that snow and desert, which never light it, do not pay for it.
const SB_POOL_TAPS: i32 = 7;
/// Golden angle. Successive taps land as far from each other as a spiral allows, so a
/// handful of samples still cover the disc evenly instead of clumping into arms.
const SB_POOL_SPIRAL: f32 = 2.399963;

/// Heat at a world XZ. Plain bilinear — nothing takes a gradient of this.
fn sbFireAt(worldXZ: vec2f) -> SbFire {
    let t = (worldXZ - uniforms.sbSubOrigin) / uniforms.sbSubExtent * uniforms.sbSubSize - 0.5;
    let i = floor(t);
    let f = t - i;
    let c = vec2i(i);

    let v00 = sbFireTexel(c + vec2i(0, 0));
    let v10 = sbFireTexel(c + vec2i(1, 0));
    let v01 = sbFireTexel(c + vec2i(0, 1));
    let v11 = sbFireTexel(c + vec2i(1, 1));
    let v = mix(mix(v00, v10, f.x), mix(v01, v11, f.x), f.y) * sbSubWindow(worldXZ);

    var s: SbFire;
    s.heat = v.r;
    s.phase = v.g;
    return s;
}

/// Light arriving at a point from the hot ground around it.
///
/// Molten rock does not merely glow, it LIGHTS THINGS — and a surface lit only by its own
/// emission reads as a decal rather than as something hot. There is no light list here
/// and there does not need to be one: the heat buffer already knows where every hot cell
/// is, so the pool is an area light that happens to be stored as a texture, integrated by
/// sampling a disc around the shaded point.
///
/// Falloff is 1/(1 + d^2): inverse-square, with the 1 keeping a cell directly underfoot
/// from going singular. The taps ride a golden-angle spiral so seven of them still cover
/// the disc rather than clumping into arms.
///
/// Returns a scalar; the caller tints it, because what colour hot material glows is the
/// surface model's business and lives in sbEmissive.
fn sbHeatPool(worldXZ: vec2f, radius: f32) -> f32 {
    var acc = 0.0;
    for (var i = 0; i < SB_POOL_TAPS; i++) {
        let a = f32(i) * SB_POOL_SPIRAL;
        // sqrt spacing puts equal AREA behind each tap, so the disc is sampled evenly
        // rather than crowding the centre where a spiral naturally would.
        let r = radius * sqrt((f32(i) + 0.5) / f32(SB_POOL_TAPS));
        let o = vec2f(cos(a), sin(a)) * r;
        acc += sbFireAt(worldXZ + o).phase / (1.0 + dot(o, o));
    }
    return acc / f32(SB_POOL_TAPS);
}
