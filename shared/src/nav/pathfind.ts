import type { Vec2 } from "../math/vec2.js";
import type { WalkGrid } from "../terrain/WalkGrid.js";
import { BinaryHeap } from "./BinaryHeap.js";

export interface PathOptions {
  /** Hard cap on A* node expansions (server CPU budget per request). */
  maxExpansions: number;
  /** If the clicked cell is blocked, search this many cells out for a walkable one. */
  snapRadius: number;
}

export const DEFAULT_PATH_OPTIONS: PathOptions = { maxExpansions: 60_000, snapRadius: 6 };

/**
 * Per-grid scratch buffers, reused across searches. Generation stamps mean
 * no O(cells) clearing per search, which matters on 1M+ cell maps.
 */
interface SearchScratch {
  g: Float32Array;
  parent: Int32Array;
  seen: Uint32Array;
  closed: Uint32Array;
  gen: number;
}

const scratchByGrid = new WeakMap<WalkGrid, SearchScratch>();

function scratchFor(grid: WalkGrid): SearchScratch {
  const n = grid.cols * grid.rows;
  let s = scratchByGrid.get(grid);
  if (!s || s.g.length !== n) {
    s = { g: new Float32Array(n), parent: new Int32Array(n), seen: new Uint32Array(n), closed: new Uint32Array(n), gen: 0 };
    scratchByGrid.set(grid, s);
  }
  s.gen++;
  if (s.gen === 0xffffffff) {
    s.seen.fill(0);
    s.closed.fill(0);
    s.gen = 1;
  }
  return s;
}

const SQRT2 = Math.SQRT2;
// 8-neighbourhood: dx, dz, cost
const DIRS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, SQRT2], [1, -1, SQRT2], [-1, 1, SQRT2], [-1, -1, SQRT2],
];

function octile(ax: number, az: number, bx: number, bz: number): number {
  const dx = Math.abs(ax - bx);
  const dz = Math.abs(az - bz);
  return dx + dz + (SQRT2 - 2) * Math.min(dx, dz);
}

/** Nearest walkable cell to (cx, cz) within `radius`, by distance to `target`. */
export function nearestWalkableCell(
  grid: WalkGrid, cx: number, cz: number, radius: number, target: Vec2,
): { cx: number; cz: number } | null {
  if (grid.isWalkable(cx, cz)) return { cx, cz };
  let best: { cx: number; cz: number } | null = null;
  let bestD = Infinity;
  for (let r = 1; r <= radius; r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue; // ring only
        const nx = cx + dx;
        const nz = cz + dz;
        if (!grid.isWalkable(nx, nz)) continue;
        const c = grid.cellCenter(nx, nz);
        const d = (c.x - target.x) ** 2 + (c.z - target.z) ** 2;
        if (d < bestD) { bestD = d; best = { cx: nx, cz: nz }; }
      }
    }
    if (best) return best;
  }
  return null;
}

/** True if the straight segment a→b only crosses walkable cells (grid DDA). */
export function lineWalkable(grid: WalkGrid, a: Vec2, b: Vec2): boolean {
  const cs = grid.cellSize;
  let cx = Math.floor(a.x / cs);
  let cz = Math.floor(a.z / cs);
  const ex = Math.floor(b.x / cs);
  const ez = Math.floor(b.z / cs);
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
  const tDeltaX = stepX !== 0 ? cs / Math.abs(dx) : Infinity;
  const tDeltaZ = stepZ !== 0 ? cs / Math.abs(dz) : Infinity;
  let tMaxX = stepX > 0 ? ((cx + 1) * cs - a.x) / dx : stepX < 0 ? (cx * cs - a.x) / dx : Infinity;
  let tMaxZ = stepZ > 0 ? ((cz + 1) * cs - a.z) / dz : stepZ < 0 ? (cz * cs - a.z) / dz : Infinity;

  const maxSteps = Math.abs(ex - cx) + Math.abs(ez - cz) + 2;
  for (let i = 0; i <= maxSteps; i++) {
    if (!grid.isWalkable(cx, cz)) return false;
    if (cx === ex && cz === ez) return true;
    if (tMaxX < tMaxZ) {
      cx += stepX; tMaxX += tDeltaX;
    } else if (tMaxZ < tMaxX) {
      cz += stepZ; tMaxZ += tDeltaZ;
    } else {
      // Exactly through a corner: forbid squeezing between two blocked cells.
      if (!grid.isWalkable(cx + stepX, cz) || !grid.isWalkable(cx, cz + stepZ)) return false;
      cx += stepX; cz += stepZ; tMaxX += tDeltaX; tMaxZ += tDeltaZ;
    }
  }
  return false;
}

/**
 * A* over the walk grid. Returns world-space waypoints (excluding `from`),
 * string-pulled for straight-line movement. If the goal is unreachable,
 * returns a path to the reachable cell closest to it (OSRS behaviour).
 * Returns an empty array when no movement is possible.
 */
export function findPath(grid: WalkGrid, from: Vec2, to: Vec2, opts: PathOptions = DEFAULT_PATH_OPTIONS): Vec2[] {
  // The start cell may be blocked (terrain edited / teleported); A* still
  // expands out of it, so an entity is never permanently stuck.
  const start = grid.cellOf(from);
  if (!grid.inGrid(start.cx, start.cz)) return [];
  const goalRaw = grid.cellOf(to);
  const goal = nearestWalkableCell(grid, goalRaw.cx, goalRaw.cz, opts.snapRadius, to);
  if (!goal) return [];
  const exactGoal = goal.cx === goalRaw.cx && goal.cz === goalRaw.cz;
  const finalPoint = exactGoal ? { x: to.x, z: to.z } : grid.cellCenter(goal.cx, goal.cz);

  if (start.cx === goal.cx && start.cz === goal.cz) return [finalPoint];

  const { g, parent, seen, closed, gen } = scratchFor(grid);
  const open = new BinaryHeap();

  const startId = grid.index(start.cx, start.cz);
  const goalId = grid.index(goal.cx, goal.cz);
  g[startId] = 0;
  parent[startId] = -1;
  seen[startId] = gen;
  open.push(startId, octile(start.cx, start.cz, goal.cx, goal.cz));

  let bestId = startId;
  let bestH = octile(start.cx, start.cz, goal.cx, goal.cz);
  let expansions = 0;

  while (open.size > 0 && expansions < opts.maxExpansions) {
    const cur = open.pop()!;
    if (closed[cur] === gen) continue;
    closed[cur] = gen;
    expansions++;
    if (cur === goalId) { bestId = cur; break; }

    const cx = cur % grid.cols;
    const cz = (cur - cx) / grid.cols;
    const h = octile(cx, cz, goal.cx, goal.cz);
    if (h < bestH) { bestH = h; bestId = cur; }

    for (const [dx, dz, cost] of DIRS) {
      const nx = cx + dx;
      const nz = cz + dz;
      if (!grid.isWalkable(nx, nz)) continue;
      // No corner cutting on diagonals.
      if (dx !== 0 && dz !== 0 && (!grid.isWalkable(cx + dx, cz) || !grid.isWalkable(cx, cz + dz))) continue;
      const nid = grid.index(nx, nz);
      if (closed[nid] === gen) continue;
      const ng = g[cur]! + cost;
      if (seen[nid] !== gen || ng < g[nid]!) {
        seen[nid] = gen;
        g[nid] = ng;
        parent[nid] = cur;
        open.push(nid, ng + octile(nx, nz, goal.cx, goal.cz));
      }
    }
  }

  // Reconstruct cell chain (goal or closest reachable) → world points.
  const cells: number[] = [];
  for (let id = bestId; id !== -1 && id !== startId; id = parent[id]!) cells.push(id);
  cells.reverse();
  if (cells.length === 0) return [];

  const raw: Vec2[] = cells.map((id) => {
    const cx = id % grid.cols;
    return grid.cellCenter(cx, (id - cx) / grid.cols);
  });
  if (bestId === goalId) raw[raw.length - 1] = finalPoint;

  return smoothPath(grid, from, raw);
}

/** Greedy string-pulling: skip waypoints while a straight walkable line exists. */
export function smoothPath(grid: WalkGrid, from: Vec2, pts: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  let anchor = from;
  let i = 0;
  while (i < pts.length) {
    let j = pts.length - 1;
    while (j > i && !lineWalkable(grid, anchor, pts[j]!)) j--;
    out.push(pts[j]!);
    anchor = pts[j]!;
    i = j + 1;
  }
  return out;
}
