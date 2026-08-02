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

/// Clipmap centre, normally the camera XZ. Snapped per level below.
uniform tCenter: vec2f;
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
};

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

    var v: SbClipmapVertex;
    v.world = vec3f(worldXZ.x, field.x, worldXZ.y);
    v.deriv = field.yz;
    v.level = level;
    v.morph = a;
    return v;
}
