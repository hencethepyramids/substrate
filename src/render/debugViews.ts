/**
 * The number every shader sees for `debug.view`.
 *
 * One table, because more than one material implements the same view — sky
 * irradiance shows up on the dome and on the terrain, and the two have to agree on
 * what 6 means. A material simply omits the codes it does not implement and falls
 * through to its normal shading path, so adding a view here does not oblige every
 * shader to grow a branch.
 *
 * Names come from DEBUG_VIEWS in core/settings.ts. Numbers are explicit rather than
 * an index into that array: reordering the array must not silently change what a
 * shader draws.
 */
export const DEBUG_CODES: Record<string, number> = {
    off: 0,
    normals: 1,
    "terrain.rings": 2,
    "terrain.morph": 3,
    linearDepth: 4,
    "terrain.slope": 5,
    "sky.irradiance": 6,
    "sky.aerial": 7,
    cascades: 8,
    shadowMap: 9,
    "substrate.depression": 10,
    "substrate.mass": 11,
    "substrate.compaction": 12,
    "substrate.phase": 13,
    "surface.specular": 14,
    "surface.roughness": 15,
    "surface.subsurface": 16,
    "surface.glints": 17,
    wind: 18,
};

export function debugCode(view: string): number {
    return DEBUG_CODES[view] ?? 0;
}
