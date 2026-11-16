import { clamp } from "../math/vec2.js";

/**
 * Vertex heightmap over a regular grid whose origin is world (0, 0).
 * Cell (cx, cz) spans x in [cx*cellSize, (cx+1)*cellSize), same for z.
 *
 * Triangulation contract: each cell is split along the diagonal from
 * (x1, z0) to (x0, z1). The terrain mesh MUST use the same split so that
 * getTerrainHeight() matches the rendered surface exactly.
 */
export class Heightmap {
  readonly vertsX: number;
  readonly vertsZ: number;
  readonly width: number;
  readonly depth: number;

  constructor(
    readonly cols: number,
    readonly rows: number,
    readonly cellSize: number,
    readonly heights: Float32Array,
  ) {
    this.vertsX = cols + 1;
    this.vertsZ = rows + 1;
    this.width = cols * cellSize;
    this.depth = rows * cellSize;
    if (heights.length !== this.vertsX * this.vertsZ) {
      throw new Error(`Heightmap: expected ${this.vertsX * this.vertsZ} heights, got ${heights.length}`);
    }
  }

  /** Height at an integer vertex, clamped to the grid. */
  vertex(vx: number, vz: number): number {
    const cx = clamp(vx, 0, this.cols);
    const cz = clamp(vz, 0, this.rows);
    return this.heights[cz * this.vertsX + cx] ?? 0;
  }

  setVertex(vx: number, vz: number, h: number): void {
    if (vx < 0 || vz < 0 || vx > this.cols || vz > this.rows) return;
    this.heights[vz * this.vertsX + vx] = h;
  }

  inBounds(x: number, z: number): boolean {
    return x >= 0 && z >= 0 && x <= this.width && z <= this.depth;
  }
}

/**
 * Deterministic surface height at world (x, z). Shared by client (sprite/prop
 * snapping, camera clamp) and server (LOS, spawn placement).
 */
export function getTerrainHeight(hm: Heightmap, x: number, z: number): number {
  const gx = clamp(x / hm.cellSize, 0, hm.cols);
  const gz = clamp(z / hm.cellSize, 0, hm.rows);
  const x0 = Math.min(Math.floor(gx), hm.cols - 1);
  const z0 = Math.min(Math.floor(gz), hm.rows - 1);
  const fx = gx - x0;
  const fz = gz - z0;

  const h00 = hm.vertex(x0, z0);
  const h10 = hm.vertex(x0 + 1, z0);
  const h01 = hm.vertex(x0, z0 + 1);
  const h11 = hm.vertex(x0 + 1, z0 + 1);

  if (fx + fz <= 1) {
    return h00 + (h10 - h00) * fx + (h01 - h00) * fz;
  }
  return h11 + (h01 - h11) * (1 - fx) + (h10 - h11) * (1 - fz);
}
