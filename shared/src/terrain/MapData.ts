import { BuildingIndex } from "../building/BuildingIndex.js";
import type { Building, EnemySpawn, GroundItem, NpcSpawn } from "../schemas/building.js";
import type { PropInstance } from "../schemas/prop.js";
import { chunkKey, type MapChunk, type MapDef } from "../schemas/map.js";
import { bytesToBase64, decodeBytes, decodeHeights, encodeHeights, quantizeHeight } from "./codec.js";
import { Heightmap } from "./Heightmap.js";

export const WALK_AUTO = 0;
export const WALK_BLOCKED = 1;
export const WALK_FORCED = 2;
export type WalkOverride = typeof WALK_AUTO | typeof WALK_BLOCKED | typeof WALK_FORCED;

/** Cell rectangle, inclusive. */
export interface CellRect {
  cx0: number;
  cz0: number;
  cx1: number;
  cz1: number;
}

/**
 * Full in-memory state of one designed map: heights + per-cell paint and
 * collision overrides. Serialises to/from sparse chunk files.
 */
export class MapData {
  readonly hm: Heightmap;
  /** Terrain material id per cell (0 = auto). */
  readonly paint: Uint8Array;
  /** WALK_* per cell. */
  readonly walkOverride: Uint8Array;
  /** 1 = void: no ground at all (sky-island edges, chasms). Never walkable. */
  readonly holes: Uint8Array;
  readonly chunksX: number;
  readonly chunksZ: number;
  /** Buildings placed on this map (stored in buildings.json, not chunks). */
  readonly buildings: BuildingIndex;

  constructor(
    public def: MapDef,
    buildings: readonly Building[] = [],
    props: readonly PropInstance[] = [],
    npcs: readonly NpcSpawn[] = [],
    groundItems: readonly GroundItem[] = [],
    enemies: readonly EnemySpawn[] = [],
  ) {
    const heights = new Float32Array((def.cols + 1) * (def.rows + 1)).fill(quantizeHeight(def.baseHeight));
    this.hm = new Heightmap(def.cols, def.rows, def.cellSize, heights);
    this.paint = new Uint8Array(def.cols * def.rows);
    this.walkOverride = new Uint8Array(def.cols * def.rows);
    this.holes = new Uint8Array(def.cols * def.rows);
    this.chunksX = def.cols / def.chunkCells;
    this.chunksZ = def.rows / def.chunkCells;
    this.buildings = new BuildingIndex(buildings, def.cellSize, props, npcs, groundItems, enemies);
  }

  isHole(cx: number, cz: number): boolean {
    if (cx < 0 || cz < 0 || cx >= this.def.cols || cz >= this.def.rows) return false;
    return this.holes[cz * this.def.cols + cx] === 1;
  }

  /** Chunks whose vertex/cell ranges touch a cell rect (vertex edges are shared). */
  chunksTouching(r: CellRect): Array<[number, number]> {
    const n = this.def.chunkCells;
    const out: Array<[number, number]> = [];
    const kx0 = Math.max(0, Math.floor((r.cx0 - 1) / n));
    const kz0 = Math.max(0, Math.floor((r.cz0 - 1) / n));
    const kx1 = Math.min(this.chunksX - 1, Math.floor((r.cx1 + 1) / n));
    const kz1 = Math.min(this.chunksZ - 1, Math.floor((r.cz1 + 1) / n));
    for (let kz = kz0; kz <= kz1; kz++) for (let kx = kx0; kx <= kx1; kx++) out.push([kx, kz]);
    return out;
  }

  applyChunk(c: MapChunk): void {
    const n = this.def.chunkCells;
    if (c.kx >= this.chunksX || c.kz >= this.chunksZ) throw new Error(`chunk ${c.kx},${c.kz} out of range`);
    const v = n + 1;
    const heights = decodeHeights(c.heights, v * v);
    const paint = decodeBytes(c.paint, n * n, "paint");
    const walk = decodeBytes(c.walk, n * n, "walk");
    const holes = c.holes ? decodeBytes(c.holes, n * n, "holes") : new Uint8Array(n * n);
    const vx0 = c.kx * n;
    const vz0 = c.kz * n;
    for (let z = 0; z < v; z++) {
      for (let x = 0; x < v; x++) this.hm.setVertex(vx0 + x, vz0 + z, heights[z * v + x]!);
    }
    for (let z = 0; z < n; z++) {
      const row = (vz0 + z) * this.def.cols + vx0;
      this.paint.set(paint.subarray(z * n, z * n + n), row);
      this.walkOverride.set(walk.subarray(z * n, z * n + n), row);
      this.holes.set(holes.subarray(z * n, z * n + n), row);
    }
  }

  extractChunk(kx: number, kz: number): MapChunk {
    const n = this.def.chunkCells;
    const v = n + 1;
    const heights = new Float32Array(v * v);
    const paint = new Uint8Array(n * n);
    const walk = new Uint8Array(n * n);
    const holes = new Uint8Array(n * n);
    const vx0 = kx * n;
    const vz0 = kz * n;
    for (let z = 0; z < v; z++) {
      for (let x = 0; x < v; x++) heights[z * v + x] = this.hm.vertex(vx0 + x, vz0 + z);
    }
    for (let z = 0; z < n; z++) {
      const row = (vz0 + z) * this.def.cols + vx0;
      paint.set(this.paint.subarray(row, row + n), z * n);
      walk.set(this.walkOverride.subarray(row, row + n), z * n);
      holes.set(this.holes.subarray(row, row + n), z * n);
    }
    const chunk: MapChunk = { kx, kz, heights: encodeHeights(heights), paint: bytesToBase64(paint), walk: bytesToBase64(walk) };
    if (holes.some((h) => h !== 0)) chunk.holes = bytesToBase64(holes);
    return chunk;
  }

  /** True if the chunk is indistinguishable from a fresh flat map. */
  isChunkPristine(kx: number, kz: number): boolean {
    const n = this.def.chunkCells;
    const base = quantizeHeight(this.def.baseHeight);
    const vx0 = kx * n;
    const vz0 = kz * n;
    for (let z = 0; z <= n; z++) {
      for (let x = 0; x <= n; x++) {
        if (Math.abs(this.hm.vertex(vx0 + x, vz0 + z) - base) > 1e-4) return false;
      }
    }
    for (let z = 0; z < n; z++) {
      const row = (vz0 + z) * this.def.cols + vx0;
      for (let x = 0; x < n; x++) {
        if (this.paint[row + x] !== 0 || this.walkOverride[row + x] !== 0 || this.holes[row + x] !== 0) return false;
      }
    }
    return true;
  }
}

export function loadMapData(
  def: MapDef,
  chunks: readonly MapChunk[],
  buildings: readonly Building[] = [],
  props: readonly PropInstance[] = [],
  npcs: readonly NpcSpawn[] = [],
  groundItems: readonly GroundItem[] = [],
  enemies: readonly EnemySpawn[] = [],
): MapData {
  const data = new MapData(def, buildings, props, npcs, groundItems, enemies);
  for (const c of chunks) data.applyChunk(c);
  return data;
}

export function chunkKeyOf(kx: number, kz: number): string {
  return chunkKey(kx, kz);
}
