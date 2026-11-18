import type { Region } from "../schemas/map.js";
import type { CellRect, MapData } from "./MapData.js";

/** A cell counts as land when all four corners are clearly above water. */
const LAND_MARGIN = 0.1;

/** Region bounds (world units) → inclusive cell rect, clamped to the map. */
export function regionCellRect(data: MapData, r: Region): CellRect {
  const cs = data.def.cellSize;
  return {
    cx0: Math.max(0, Math.floor(r.bounds.x0 / cs)),
    cz0: Math.max(0, Math.floor(r.bounds.z0 / cs)),
    cx1: Math.min(data.def.cols - 1, Math.ceil(r.bounds.x1 / cs) - 1),
    cz1: Math.min(data.def.rows - 1, Math.ceil(r.bounds.z1 / cs) - 1),
  };
}

/** Region containing world point (x, z): the smallest one when regions nest (a town inside a continent), or null. */
export function regionAt(regions: readonly Region[], x: number, z: number): Region | null {
  let best: Region | null = null;
  let bestArea = Infinity;
  for (const r of regions) {
    if (x < r.bounds.x0 || x >= r.bounds.x1 || z < r.bounds.z0 || z >= r.bounds.z1) continue;
    const area = (r.bounds.x1 - r.bounds.x0) * (r.bounds.z1 - r.bounds.z0);
    if (area < bestArea) {
      best = r;
      bestArea = area;
    }
  }
  return best;
}

export interface FloatResult {
  landCells: number;
  voidCells: number;
}

/**
 * Turn the land inside a rect into a floating island:
 *  - every cell whose corners are all above water is land; its vertices are lifted by `lift`
 *  - every other cell in the rect becomes void (no ground), separating it from the sea
 * Paint and collision on land cells are preserved. Idempotent on void cells.
 */
export function floatRegion(data: MapData, rect: CellRect, lift: number): FloatResult {
  const { hm, def, holes } = data;
  const water = def.waterLevel + LAND_MARGIN;
  const w = rect.cx1 - rect.cx0 + 1;
  const h = rect.cz1 - rect.cz0 + 1;
  const vw = w + 1;
  const liftVertex = new Uint8Array(vw * (h + 1));
  let landCells = 0;
  let voidCells = 0;

  for (let cz = rect.cz0; cz <= rect.cz1; cz++) {
    for (let cx = rect.cx0; cx <= rect.cx1; cx++) {
      const i = cz * def.cols + cx;
      const land =
        holes[i] !== 1 &&
        hm.vertex(cx, cz) > water && hm.vertex(cx + 1, cz) > water &&
        hm.vertex(cx, cz + 1) > water && hm.vertex(cx + 1, cz + 1) > water;
      if (land) {
        landCells++;
        const lx = cx - rect.cx0;
        const lz = cz - rect.cz0;
        liftVertex[lz * vw + lx] = 1;
        liftVertex[lz * vw + lx + 1] = 1;
        liftVertex[(lz + 1) * vw + lx] = 1;
        liftVertex[(lz + 1) * vw + lx + 1] = 1;
      } else {
        voidCells++;
        holes[i] = 1;
        data.paint[i] = 0;
        data.walkOverride[i] = 0;
      }
    }
  }

  for (let lz = 0; lz <= h; lz++) {
    for (let lx = 0; lx <= w; lx++) {
      if (!liftVertex[lz * vw + lx]) continue;
      const vx = rect.cx0 + lx;
      const vz = rect.cz0 + lz;
      hm.setVertex(vx, vz, hm.vertex(vx, vz) + lift);
    }
  }
  return { landCells, voidCells };
}

/**
 * Make the map "ocean by default": every vertex outside all regions drops to
 * `seabed`, and cells fully outside regions lose paint/collision/void.
 * Also sets the map's baseHeight so untouched chunks stay ocean.
 */
export function sinkOutsideRegions(data: MapData, seabed: number): void {
  const { def, hm } = data;
  def.baseHeight = seabed;
  const rects = def.regions.map((r) => regionCellRect(data, r));
  const vertexInside = (vx: number, vz: number): boolean =>
    rects.some((r) => vx >= r.cx0 && vx <= r.cx1 + 1 && vz >= r.cz0 && vz <= r.cz1 + 1);
  const cellInside = (cx: number, cz: number): boolean =>
    rects.some((r) => cx >= r.cx0 && cx <= r.cx1 && cz >= r.cz0 && cz <= r.cz1);

  for (let vz = 0; vz <= def.rows; vz++) {
    for (let vx = 0; vx <= def.cols; vx++) {
      if (!vertexInside(vx, vz)) hm.setVertex(vx, vz, seabed);
    }
  }
  for (let cz = 0; cz < def.rows; cz++) {
    for (let cx = 0; cx < def.cols; cx++) {
      if (cellInside(cx, cz)) continue;
      const i = cz * def.cols + cx;
      data.paint[i] = 0;
      data.walkOverride[i] = 0;
      data.holes[i] = 0;
    }
  }
}
