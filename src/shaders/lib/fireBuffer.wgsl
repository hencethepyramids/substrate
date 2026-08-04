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
