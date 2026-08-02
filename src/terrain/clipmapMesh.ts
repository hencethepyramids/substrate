import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import type { Scene } from "@babylonjs/core/scene";

/**
 * Nested-ring geometry clipmap. Built once, never touched again.
 *
 *   8 levels, 160 cells per side, 8.5 cm at level 0
 *   -> level 7 spacing 10.88 m, half-extent 870.4 m
 *   -> 162,212 quads = 324,424 triangles in ONE mesh and ONE draw call
 *
 * Vertices carry (gridIndex.x, ringLevel, gridIndex.z) and nothing else. There are no
 * world positions in this buffer: the vertex shader snaps each level to its own grid,
 * morphs it, and displaces it. That is what makes a 1.7 km terrain a single immutable
 * 2 MB buffer instead of something the CPU has to rebuild as the player moves.
 */

export interface ClipmapConfig {
    /** Cells across one side of every level. Must be a multiple of 4. */
    cells: number;
    levels: number;
    /** Metres per cell at level 0. */
    innerSpacing: number;
}

export const CLIPMAP: ClipmapConfig = {
    cells: 160,
    levels: 8,
    innerSpacing: 0.085,
};

export function clipmapHalfExtent(cfg: ClipmapConfig): number {
    return (cfg.cells / 2) * cfg.innerSpacing * Math.pow(2, cfg.levels - 1);
}

export interface ClipmapStats {
    vertices: number;
    triangles: number;
    halfExtent: number;
    bytes: number;
}

export function buildClipmapMesh(name: string, scene: Scene, cfg: ClipmapConfig = CLIPMAP): { mesh: Mesh; stats: ClipmapStats } {
    const n = cfg.cells;
    const half = n / 2;

    // Each ring's hole is ONE CELL SMALLER than the level it wraps.
    //
    // A level snapped to twice its own spacing sits either exactly on its child's
    // centre or one cell off it — never more, never less (see the snap in
    // terrain.vertex.wgsl). Sizing the hole one cell small turns that ambiguity into
    // a one-or-two-cell overlap instead of a one-cell hole in the ground. In the
    // overlap band both levels have been morphed onto the same lattice and sample the
    // same field, so the surfaces coincide; the vertex shader biases finer levels
    // toward the camera to settle the depth test between them.
    const holeHalf = n / 4 - 1;

    const positions: number[] = [];
    const indices: number[] = [];

    // Reused per level: maps a grid coordinate to its index in the shared buffer.
    const stride = n + 1;
    const lookup = new Int32Array(stride * stride);

    for (let level = 0; level < cfg.levels; level++) {
        lookup.fill(-1);

        const vertexAt = (i: number, j: number): number => {
            const key = (i + half) * stride + (j + half);
            let index = lookup[key];
            if (index < 0) {
                index = positions.length / 3;
                // The carrier: grid X, ring level, grid Z.
                positions.push(i, level, j);
                lookup[key] = index;
            }
            return index;
        };

        for (let i = -half; i < half; i++) {
            for (let j = -half; j < half; j++) {
                // Skip cells the finer level already covers. Level 0 has no child.
                if (level > 0 && i >= -holeHalf && i + 1 <= holeHalf && j >= -holeHalf && j + 1 <= holeHalf) {
                    continue;
                }

                const a = vertexAt(i, j);
                const b = vertexAt(i + 1, j);
                const c = vertexAt(i, j + 1);
                const d = vertexAt(i + 1, j + 1);

                // Wound counter-clockwise in the XZ chart, matching Babylon's own
                // ground builder so front faces agree with the rest of the engine.
                indices.push(a, b, d);
                indices.push(a, d, c);
            }
        }
    }

    const mesh = new Mesh(name, scene);
    const data = new VertexData();
    data.positions = new Float32Array(positions);
    data.indices = new Uint32Array(indices);
    data.applyToMesh(mesh, false);

    // "position" here is grid data, so the bounds Babylon derives from it are
    // meaningless. The clipmap is always centred on the camera and always visible.
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.isPickable = false;
    mesh.freezeWorldMatrix();

    return {
        mesh,
        stats: {
            vertices: positions.length / 3,
            triangles: indices.length / 3,
            halfExtent: clipmapHalfExtent(cfg),
            bytes: positions.length * 4 + indices.length * 4,
        },
    };
}
