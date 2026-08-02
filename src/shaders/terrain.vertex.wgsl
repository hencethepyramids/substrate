// Nested-ring geometry clipmap. One static mesh, one draw call, ~324k triangles.
//
// The vertex buffer carries (gridIndex, ringLevel) and nothing else — no world
// positions, no normals, no UVs. Everything below is computed here, which is what
// lets a 1.7 km terrain be a single immutable buffer that is never touched again
// after load.

#include<substratePack>
#include<substrateTerrainField>

// position is a carrier, not a position: (gridX, ringLevel, gridZ).
attribute position: vec3f;

uniform viewProjection: mat4x4f;

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

varying vWorld: vec3f;
varying vDeriv: vec2f;
varying vLevel: f32;
varying vMorph: f32;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    let level = vertexInputs.position.y;
    var g = vec2f(vertexInputs.position.x, vertexInputs.position.z);

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

    // The one shared field lookup. Phase 2's shadow cascades call this same function.
    let field = sbSampleField(worldXZ);

    let world = vec3f(worldXZ.x, field.x, worldXZ.y);
    vertexOutputs.vWorld = world;
    vertexOutputs.vDeriv = field.yz;
    vertexOutputs.vLevel = level;
    vertexOutputs.vMorph = a;

    var clip = uniforms.viewProjection * vec4f(world, 1.0);

    // Each ring's hole is built one cell small, so consecutive levels overlap by a
    // cell or two rather than ever leaving a gap — see clipmapMesh.ts. In that band
    // the two levels are coincident and coplanar, so bias finer levels toward the
    // camera to give the depth test something to decide on.
    clip.z = clip.z - (uniforms.tLevels - level) * 2.0e-6 * clip.w;

    vertexOutputs.position = clip;
}
