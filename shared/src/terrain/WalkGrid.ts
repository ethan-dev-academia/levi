import type { Vec2 } from "../math/vec2.js";
import { WALK_BLOCKED, WALK_FORCED, type CellRect, type MapData } from "./MapData.js";

/** Blocked-side bits per cell (walls, windows on cell edges). */
export const EDGE_N = 1; // towards -Z
export const EDGE_E = 2; // towards +X
export const EDGE_S = 4; // towards +Z
export const EDGE_W = 8; // towards -X

/** Bit for a cardinal step (dx, dz). */
export function edgeBit(dx: number, dz: number): number {
  return dx > 0 ? EDGE_E : dx < 0 ? EDGE_W : dz > 0 ? EDGE_S : EDGE_N;
}

/**
 * Per-cell walkability on the 2D (X, Z) plane. 1 = walkable.
 * All coordinates are GLOBAL cell coords; a grid may cover a sub-rectangle
 * of the map starting at (ox, oz), e.g. one building's upper floor.
 * Optional `edges` block movement across individual cell sides (walls).
 */
export class WalkGrid {
  readonly cells: Uint8Array;
  /** EDGE_* bits per cell; allocated on first wall. */
  edges: Uint8Array | null = null;

  constructor(
    readonly cols: number,
    readonly rows: number,
    readonly cellSize: number,
    readonly ox = 0,
    readonly oz = 0,
  ) {
    this.cells = new Uint8Array(cols * rows);
  }

  index(cx: number, cz: number): number {
    return (cz - this.oz) * this.cols + (cx - this.ox);
  }

  /** Inverse of index(). */
  cellAt(i: number): { cx: number; cz: number } {
    const lx = i % this.cols;
    return { cx: lx + this.ox, cz: (i - lx) / this.cols + this.oz };
  }

  inGrid(cx: number, cz: number): boolean {
    return cx >= this.ox && cz >= this.oz && cx < this.ox + this.cols && cz < this.oz + this.rows;
  }

  isWalkable(cx: number, cz: number): boolean {
    return this.inGrid(cx, cz) && this.cells[this.index(cx, cz)] === 1;
  }

  setWalkable(cx: number, cz: number, walkable: boolean): void {
    if (this.inGrid(cx, cz)) this.cells[this.index(cx, cz)] = walkable ? 1 : 0;
  }

  /** Mark one side of a cell as blocked (no-op outside the grid). */
  blockSide(cx: number, cz: number, bit: number): void {
    if (!this.inGrid(cx, cz)) return;
    this.edges ??= new Uint8Array(this.cols * this.rows);
    const i = this.index(cx, cz);
    this.edges[i] = this.edges[i]! | bit;
  }

  clearEdges(): void {
    this.edges?.fill(0);
  }

  /** Is the side of (cx, cz) facing the cardinal step (dx, dz) walled? */
  sideBlocked(cx: number, cz: number, dx: number, dz: number): boolean {
    return this.edges !== null && this.inGrid(cx, cz) && (this.edges[this.index(cx, cz)]! & edgeBit(dx, dz)) !== 0;
  }

  /**
   * Can an entity step from (cx, cz) to its neighbour (cx+dx, cz+dz)?
   * Diagonals need both L-shaped routes open: no corner cutting past
   * blocked cells or through wall ends.
   */
  canStep(cx: number, cz: number, dx: number, dz: number): boolean {
    if (!this.isWalkable(cx + dx, cz + dz)) return false;
    if (dx === 0 || dz === 0) return !this.sideBlocked(cx, cz, dx, dz);
    return (
      this.isWalkable(cx + dx, cz) && this.isWalkable(cx, cz + dz) &&
      !this.sideBlocked(cx, cz, dx, 0) && !this.sideBlocked(cx + dx, cz, 0, dz) &&
      !this.sideBlocked(cx, cz, 0, dz) && !this.sideBlocked(cx, cz + dz, dx, 0)
    );
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

/**
 * Auto rule: underwater or too steep = blocked. Painted overrides win.
 * Buildings are applied on top: ground-floor tiles are walkable, stair
 * footprints are not (see BuildingIndex).
 */
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
  data.buildings.applyCellsToGround(grid, { cx0, cz0, cx1, cz1 }, holes);
}

export function buildWalkGrid(data: MapData): WalkGrid {
  const grid = new WalkGrid(data.def.cols, data.def.rows, data.def.cellSize);
  computeWalkRegion(grid, data, { cx0: 0, cz0: 0, cx1: data.def.cols - 1, cz1: data.def.rows - 1 });
  data.buildings.applyEdgesToGround(grid);
  return grid;
}
