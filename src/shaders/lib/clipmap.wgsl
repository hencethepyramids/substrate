// SHARED INCLUDE — substrateClipmap
//
// Where a clipmap vertex ends up. Requires <substrateTerrainField> for sbSampleField.
//
// RULE 4, THE SECOND HALF. terrainField.wgsl is the single definition of "where is
// the ground"; this is the single definition of "where does this vertex go". Both
// matter, and this one is the reason the file exists: the beauty pass and the shadow
// cascades snap, morph and displace through these exact lines, so a vertex cannot
// land in one place for shading and a few centimetres away for depth. That
// disagreement is what makes terrain shadow itself in thin moving stripes, and it is
// nearly impossible to diagnose after the fact because both passes look correct on
// their own.

// Declares sbSubTex, so every pass that includes THIS one has to bind the substrate —
// which is the point. Phase 3 wrote down that displacing the buffer was a Phase 8 job,
// and this is where it lands: the ground stops being a normal map and becomes geometry.
// The shadow cascades come along for free, and must, because a shadow cast by the
// undisplaced surface is the shadow of a footprint that is not there.
#include<substrateBuffer>

/// Clipmap centre, normally the camera XZ. Snapped per level below.
uniform tCenter: vec2f;
/// 0 leaves the clipmap on the bare heightfield, for seeing what the buffer is adding.
uniform tDisplace: f32;
/// Metres per cell at level 0.
uniform tInnerSpacing: f32;
/// Cells across one side of every level.
uniform tCells: f32;
/// 0 disables CDLOD morphing, for seeing exactly where the LOD seams are.
uniform tMorph: f32;
/// Number of levels, used for the per-level depth bias.
uniform tLevels: f32;

struct SbClipmapVertex {
    world: vec3f,
    deriv: vec2f,
    level: f32,
    /// How far this vertex has morphed toward its parent's grid, 0..1.
    morph: f32,
    /// How much of the depression this vertex's geometry has already taken, 0..1. The
    /// surface shader adds only what is left, so a print is never shaded twice.
    reliefTaken: f32,
    /// How far this vertex was actually lowered, in metres.
    reliefDepth: f32,
};

/// Cell widths, in substrate texels, between "the grid resolves this" and "it cannot".
///
/// A vertex can only represent what its own cell can hold. At level 0 the spacing is
/// 8.5 cm against a 6.25 cm buffer texel, so a bootprint is genuinely geometry; by level
/// 3 one cell is 68 cm and a print inside it is a sub-cell wiggle that would alias into a
/// shimmering horizon every time the clipmap snapped. So displacement fades out across
/// the range where the grid stops being able to hold the detail, and the surface shader
/// picks up the rest as a normal — which is what it did for the whole of Phases 3 to 7.
const SB_DISPLACE_FULL: f32 = 3.0;
const SB_DISPLACE_NONE: f32 = 9.0;

/// Depression averaged over the cell a vertex stands for, and how much of it was taken.
///
/// FOUR TAPS AT THE QUADRANT CENTRES, not at the cell corners: this is a box filter over
/// exactly the ground the vertex represents, and sampling the corners would share every
/// tap with the neighbouring vertex and filter nothing.
///
/// The width is the MORPHED spacing. A vertex at the outer edge of its level has slid
/// onto one of its parent's, and the parent filters at twice the width — so anything but
/// `spacing * (1 + morph)` leaves the two disagreeing about how deep the ground is at
/// exactly the place they are meant to be the same vertex, which is a crack along every
/// ring boundary.
struct SbClipmapRelief {
    /// Metres the vertex is lowered by.
    depth: f32,
    /// Fraction of the buffer's depression this cell was able to take, 0..1.
    taken: f32,
    /// Gradient of exactly that much of it. THE NORMAL HAS TO MOVE WITH THE VERTEX.
    slope: vec2f,
};

fn sbClipmapRelief(worldXZ: vec2f, spacing: f32) -> SbClipmapRelief {
    var r: SbClipmapRelief;
    r.depth = 0.0;
    r.taken = 0.0;
    r.slope = vec2f(0.0, 0.0);

    let texel = uniforms.sbSubExtent / max(uniforms.sbSubSize, 1.0);
    r.taken = (1.0 - smoothstep(SB_DISPLACE_FULL, SB_DISPLACE_NONE, spacing / max(texel, 1e-4))) * uniforms.tDisplace;
    if (r.taken <= 0.0) {
        return r;
    }
    let q = spacing * 0.25;
    let a = sbSubstrateAt(worldXZ + vec2f(-q, -q));
    let b = sbSubstrateAt(worldXZ + vec2f(q, -q));
    let c = sbSubstrateAt(worldXZ + vec2f(-q, q));
    let d = sbSubstrateAt(worldXZ + vec2f(q, q));
    r.depth = (a.depression + b.depression + c.depression + d.depression) * 0.25 * r.taken;
    // The same four taps carry the gradient for free — it is the analytic derivative of
    // the very interpolation the depression came from, so the normal cannot describe a
    // surface different from the one the vertex was moved onto.
    r.slope = (a.slope + b.slope + c.slope + d.slope) * 0.25 * r.taken;
    return r;
}

/// `carrier` is the vertex buffer's position attribute, which is not a position:
/// (gridX, ringLevel, gridZ).
fn sbClipmapVertex(carrier: vec3f) -> SbClipmapVertex {
    let level = carrier.y;
    var g = vec2f(carrier.x, carrier.z);

    let spacing = uniforms.tInnerSpacing * exp2(level);

    // Snap this level to twice its own cell size. Twice, not once: it makes the
    // offset between a level's centre and its child's centre an exact multiple of
    // this level's spacing, which is what keeps the ring boundaries on a common
    // lattice. Without the snap, coarse vertices slide across the heightfield as
    // the player walks and the whole horizon shimmers.
    let snap = spacing * 2.0;
    let centre = floor(uniforms.tCenter / snap) * snap;

    let half = uniforms.tCells * 0.5;

    // CDLOD. Chebyshev distance from the centre decides how far this vertex has
    // morphed toward its parent's grid. By the outer edge every odd vertex has slid
    // onto an even one, so this level's boundary lands exactly on the next level's
    // vertices: no T-junctions, and no popping when a level changes.
    let d = max(abs(g.x), abs(g.y));
    let morphStart = half * 0.70;
    let morphEnd = half * 0.95;
    let a = clamp((d - morphStart) / (morphEnd - morphStart), 0.0, 1.0) * uniforms.tMorph;
    let odd = fract(g * 0.5) * 2.0;
    g = g - odd * a;

    let worldXZ = centre + g * spacing;

    // The one shared field lookup.
    let field = sbSampleField(worldXZ);

    // And what has been carved out of it, filtered at the morphed spacing so that the
    // boundary between two levels stays watertight.
    let relief = sbClipmapRelief(worldXZ, spacing * (1.0 + a));

    var v: SbClipmapVertex;
    v.world = vec3f(worldXZ.x, field.x - relief.depth, worldXZ.y);
    // AND THE NORMAL COMES WITH IT. Lowering the vertex without lowering the derivative
    // leaves a real hollow in the mesh shaded as though the ground were still flat —
    // which looks, convincingly, like nothing happened at all. The buffer lowers the
    // surface, so its slope subtracts, exactly as it does in the surface shader.
    v.deriv = field.yz - relief.slope;
    v.level = level;
    v.morph = a;
    v.reliefTaken = relief.taken;
    v.reliefDepth = relief.depth;
    return v;
}
