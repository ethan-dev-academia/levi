import type { Vec2 } from "../math/vec2.js";
import { WALK_BLOCKED, WALK_FORCED, type CellRect, type MapData } from "./MapData.js";

/** Per-cell walkability on the 2D (X, Z) plane. 1 = walkable. */
export class WalkGrid {
  readonly cells: Uint8Array;

  constructor(
    readonly cols: number,
    readonly rows: number,
    readonly cellSize: number,
  ) {
    this.cells = new Uint8Array(cols * rows);
  }

  index(cx: number, cz: number): number {
    return cz * this.cols + cx;
  }

  inGrid(cx: number, cz: number): boolean {
    return cx >= 0 && cz >= 0 && cx < this.cols && cz < this.rows;
  }

  isWalkable(cx: number, cz: number): boolean {
    return this.inGrid(cx, cz) && this.cells[cz * this.cols + cx] === 1;
  }

  setWalkable(cx: number, cz: number, walkable: boolean): void {
    if (this.inGrid(cx, cz)) this.cells[cz * this.cols + cx] = walkable ? 1 : 0;
  }

  cellOf(p: Vec2): { cx: number; cz: number } {
    return { cx: Math.floor(p.x / this.cellSize), cz: Math.floor(p.z / this.cellSize) };
  }

  cellCenter(cx: number, cz: number): Vec2 {
    return { x: (cx + 0.5) * this.cellSize, z: (cz + 0.5) * this.cellSize };
  }

  isWalkableAt(p: Vec2): boolean {
    const { cx, cz } = this.cellOf(p);
    return this.isWalkable(cx, cz);
  }
}

/** Auto rule: underwater or too steep = blocked. Painted overrides win. */
export function computeWalkRegion(grid: WalkGrid, data: MapData, r: CellRect): void {
  const { hm, def, walkOverride, holes } = data;
  const cx0 = Math.max(0, r.cx0);
  const cz0 = Math.max(0, r.cz0);
  const cx1 = Math.min(def.cols - 1, r.cx1);
  const cz1 = Math.min(def.rows - 1, r.cz1);
  for (let cz = cz0; cz <= cz1; cz++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      const i = cz * def.cols + cx;
      if (holes[i] === 1) { grid.cells[i] = 0; continue; } // void: nothing to stand on
      const o = walkOverride[i];
      if (o === WALK_BLOCKED) { grid.cells[i] = 0; continue; }
      if (o === WALK_FORCED) { grid.cells[i] = 1; continue; }
      const a = hm.vertex(cx, cz);
      const b = hm.vertex(cx + 1, cz);
      const c = hm.vertex(cx, cz + 1);
      const d = hm.vertex(cx + 1, cz + 1);
      const dry = (a + b + c + d) / 4 > def.waterLevel + 0.15;
      grid.cells[i] = dry && Math.max(a, b, c, d) - Math.min(a, b, c, d) <= def.maxStep ? 1 : 0;
    }
  }
}

export function buildWalkGrid(data: MapData): WalkGrid {
  const grid = new WalkGrid(data.def.cols, data.def.rows, data.def.cellSize);
  computeWalkRegion(grid, data, { cx0: 0, cz0: 0, cx1: data.def.cols - 1, cz1: data.def.rows - 1 });
  return grid;
}
