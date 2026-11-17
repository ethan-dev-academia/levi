import type { Building, Dir, EnemySpawn, GroundItem, NpcSpawn, SpawnZone, Stair, Wall } from "../schemas/building.js";
import type { PropInstance } from "../schemas/prop.js";
import type { CellRect } from "../terrain/MapData.js";
import { getTerrainHeight, type Heightmap } from "../terrain/Heightmap.js";
import { EDGE_E, EDGE_N, EDGE_S, EDGE_W, WalkGrid } from "../terrain/WalkGrid.js";

export const DIR_VEC: Readonly<Record<Dir, readonly [number, number]>> = {
  n: [0, -1], e: [1, 0], s: [0, 1], w: [-1, 0],
};

/** Packed cell key (maps are < 65536 cells a side). */
export const cellKey = (cx: number, cz: number): number => cz * 65536 + cx;

/** Surface height of storey `k`. */
export function storeyY(b: Building, k: number): number {
  return b.baseY + k * b.floorHeight;
}

/** Cells covered by a stair / ladder, foot first. */
export function stairCells(s: Stair): Array<[number, number]> {
  const [dx, dz] = DIR_VEC[s.dir];
  const out: Array<[number, number]> = [];
  for (let i = 0; i < s.length; i++) out.push([s.x + dx * i, s.z + dz * i]);
  return out;
}

/** Where you stand to climb up (and arrive when coming down). */
export function stairBottomCell(s: Stair): [number, number] {
  const [dx, dz] = DIR_VEC[s.dir];
  return [s.x - dx, s.z - dz];
}

/** Where you arrive going up (and stand to climb down). */
export function stairTopCell(s: Stair): [number, number] {
  const [dx, dz] = DIR_VEC[s.dir];
  return [s.x + dx * s.length, s.z + dz * s.length];
}

/**
 * Walkable cell to stand on at one end of a stair on `grid` (that storey's
 * walk grid): the cell just past that end if possible, else the nearest
 * walkable cell bordering the stair footprint. Null if none.
 */
export function stairLanding(grid: WalkGrid, s: Stair, end: "top" | "bottom"): [number, number] | null {
  const pref = end === "top" ? stairTopCell(s) : stairBottomCell(s);
  if (grid.isWalkable(pref[0], pref[1])) return pref;
  const cells = stairCells(s);
  const own = new Set(cells.map(([x, z]) => cellKey(x, z)));
  let best: [number, number] | null = null;
  let bestD = Infinity;
  for (const [x, z] of cells) {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, nz = z + dz;
        if (own.has(cellKey(nx, nz)) || !grid.isWalkable(nx, nz)) continue;
        const d = (nx - pref[0]) ** 2 + (nz - pref[1]) ** 2;
        if (d < bestD) { bestD = d; best = [nx, nz]; }
      }
    }
  }
  return best;
}

/** Stable identity of a wall edge, for editing. */
export function wallKey(w: Pick<Wall, "x" | "z" | "axis">): string {
  return `${w.axis}${w.x}_${w.z}`;
}

/** Block both cells either side of a wall edge (no-op for doorways). */
export function blockWall(grid: WalkGrid, w: Wall): void {
  if (w.kind === "door") return;
  if (w.axis === "x") {
    grid.blockSide(w.x, w.z - 1, EDGE_S);
    grid.blockSide(w.x, w.z, EDGE_N);
  } else {
    grid.blockSide(w.x - 1, w.z, EDGE_E);
    grid.blockSide(w.x, w.z, EDGE_W);
  }
}

/** Derived, never saved: lookup sets and per-storey walk grids. */
export interface BuildingInfo {
  readonly def: Building;
  /** Inclusive cell bounds of all tiles and stairs (walls if there are none). */
  readonly bounds: CellRect;
  /** Floor tiles per storey, as cellKey()s. */
  readonly tiles: ReadonlyArray<ReadonlySet<number>>;
  /** Walk grid per storey; null for storey 0 (that's the map's ground grid). */
  readonly grids: ReadonlyArray<WalkGrid | null>;
}

function inRect(r: CellRect, cx: number, cz: number): boolean {
  return cx >= r.cx0 && cz >= r.cz0 && cx <= r.cx1 && cz <= r.cz1;
}

/** Anything standing on a cell that blocks walking there. */
interface Blocker {
  x: number;
  z: number;
  storey: number;
  building?: string | undefined;
}

function deriveInfo(def: Building, cellSize: number, blockers: readonly Blocker[]): BuildingInfo {
  const tiles = def.storeys.map((s) => new Set(s.tiles.map(([x, z]) => cellKey(x, z))));
  let cx0 = Infinity, cz0 = Infinity, cx1 = -Infinity, cz1 = -Infinity;
  const grow = (x: number, z: number): void => {
    cx0 = Math.min(cx0, x); cz0 = Math.min(cz0, z); cx1 = Math.max(cx1, x); cz1 = Math.max(cz1, z);
  };
  for (const s of def.storeys) for (const [x, z] of s.tiles) grow(x, z);
  for (const st of def.stairs) for (const [x, z] of stairCells(st)) grow(x, z);
  if (cx0 === Infinity) for (const s of def.storeys) for (const w of s.walls) grow(w.x, w.z);
  if (cx0 === Infinity) grow(0, 0);
  const bounds: CellRect = { cx0, cz0, cx1, cz1 };

  const grids = def.storeys.map((storey, k) => {
    if (k === 0) return null;
    const g = new WalkGrid(cx1 - cx0 + 1, cz1 - cz0 + 1, cellSize, cx0, cz0);
    for (const [x, z] of storey.tiles) g.setWalkable(x, z, true);
    for (const st of def.stairs) {
      if (k < st.from || k > st.to) continue;
      for (const [x, z] of stairCells(st)) g.setWalkable(x, z, false);
    }
    for (const w of storey.walls) blockWall(g, w);
    for (const b of blockers) if (b.storey === k && b.building === def.id) g.setWalkable(b.x, b.z, false);
    return g;
  });
  return { def, bounds, tiles, grids };
}

/**
 * All buildings of a map, plus what gameplay needs from them: ground-floor
 * walkability/height, wall edges, and the walk grid of every upper storey.
 * Shared by the server sim and the client.
 */
export class BuildingIndex {
  private readonly byId = new Map<string, BuildingInfo>();
  private propList: PropInstance[] = [];
  private npcList: NpcSpawn[] = [];
  private groundList: GroundItem[] = [];
  private enemyList: EnemySpawn[] = [];
  private zoneList: SpawnZone[] = [];

  constructor(
    buildings: readonly Building[] = [],
    private readonly cellSize = 1,
    props: readonly PropInstance[] = [],
    npcs: readonly NpcSpawn[] = [],
    groundItems: readonly GroundItem[] = [],
    enemies: readonly EnemySpawn[] = [],
  ) {
    this.enemyList = [...enemies];
    this.propList = [...props];
    this.npcList = [...npcs];
    this.groundList = [...groundItems];
    for (const b of buildings) this.set(b);
  }

  /** Placed props (furniture, barrels, signs...). */
  get props(): readonly PropInstance[] {
    return this.propList;
  }

  /** NPCs standing in the world. */
  get npcs(): readonly NpcSpawn[] {
    return this.npcList;
  }

  /** Enemy home spots. */
  get enemies(): readonly EnemySpawn[] {
    return this.enemyList;
  }

  setEnemies(list: readonly EnemySpawn[]): void {
    this.enemyList = [...list];
  }

  /** Enemy spawn zones. */
  get zones(): readonly SpawnZone[] {
    return this.zoneList;
  }

  setZones(list: readonly SpawnZone[]): void {
    this.zoneList = [...list];
  }

  /** Items lying on the ground. */
  get groundItems(): readonly GroundItem[] {
    return this.groundList;
  }

  /** Replace all NPC spawns (they block their tile, like solid props). */
  setNpcs(npcs: readonly NpcSpawn[]): void {
    this.npcList = [...npcs];
    for (const info of [...this.byId.values()]) this.set(info.def);
  }

  setGroundItems(items: readonly GroundItem[]): void {
    this.groundList = [...items];
  }

  npcAt(cx: number, cz: number, storey: number, building: string | null): NpcSpawn | undefined {
    return this.npcList.find((n) => n.x === cx && n.z === cz && n.storey === storey && (storey === 0 || n.building === building));
  }

  groundItemAt(cx: number, cz: number, storey: number, building: string | null): GroundItem | undefined {
    return this.groundList.find((g) => g.x === cx && g.z === cz && g.storey === storey && (storey === 0 || g.building === building));
  }

  private blockers(): Blocker[] {
    // Wandering NPCs don't pin a tile (they move around); stationary ones do.
    return [...this.propList.filter((p) => p.solid), ...this.npcList.filter((n) => n.wander === "none")];
  }

  /** Replace all props; upper-storey grids are re-derived (props can block). */
  setProps(props: readonly PropInstance[]): void {
    this.propList = [...props];
    for (const info of [...this.byId.values()]) this.set(info.def);
  }

  /** Prop standing on a cell of a storey (and building, above the ground floor). */
  propAt(cx: number, cz: number, storey: number, building: string | null): PropInstance | undefined {
    return this.propList.find(
      (p) => p.x === cx && p.z === cz && p.storey === storey && (storey === 0 || p.building === building),
    );
  }

  get size(): number {
    return this.byId.size;
  }

  all(): IterableIterator<BuildingInfo> {
    return this.byId.values();
  }

  /** Plain definitions, for saving. */
  defs(): Building[] {
    return [...this.byId.values()].map((i) => i.def);
  }

  get(id: string): BuildingInfo | undefined {
    return this.byId.get(id);
  }

  /** Add or replace a building; returns its derived info. */
  set(def: Building): BuildingInfo {
    const info = deriveInfo(def, this.cellSize, this.blockers());
    this.byId.set(def.id, info);
    return info;
  }

  remove(id: string): BuildingInfo | undefined {
    const info = this.byId.get(id);
    this.byId.delete(id);
    return info;
  }

  /** Building whose ground-floor tile covers this cell. */
  groundOwner(cx: number, cz: number): BuildingInfo | null {
    const k = cellKey(cx, cz);
    for (const info of this.byId.values()) {
      if (inRect(info.bounds, cx, cz) && info.tiles[0]!.has(k)) return info;
    }
    return null;
  }

  /** Building whose bounds contain this cell. */
  containing(cx: number, cz: number): BuildingInfo | null {
    for (const info of this.byId.values()) if (inRect(info.bounds, cx, cz)) return info;
    return null;
  }

  /** Ground (storey 0) surface: a building's floor, else the terrain. */
  groundHeight(hm: Heightmap, x: number, z: number): number {
    const owner = this.groundOwner(Math.floor(x / this.cellSize), Math.floor(z / this.cellSize));
    return owner ? owner.def.baseY : getTerrainHeight(hm, x, z);
  }

  /** Overlay buildings (and solid ground-level props) on fresh ground walkability inside `r`. */
  applyCellsToGround(grid: WalkGrid, r: CellRect, holes: Uint8Array): void {
    this.applyBuildingCells(grid, r, holes);
    for (const b of this.blockers()) if (b.storey === 0 && inRect(r, b.x, b.z)) grid.setWalkable(b.x, b.z, false);
  }

  private applyBuildingCells(grid: WalkGrid, r: CellRect, holes: Uint8Array): void {
    for (const info of this.byId.values()) {
      const b = info.bounds;
      if (b.cx1 < r.cx0 || b.cz1 < r.cz0 || b.cx0 > r.cx1 || b.cz0 > r.cz1) continue;
      for (const [x, z] of info.def.storeys[0]!.tiles) {
        if (!inRect(r, x, z) || !grid.inGrid(x, z)) continue;
        if (holes[grid.index(x, z)] !== 1) grid.setWalkable(x, z, true);
      }
      for (const st of info.def.stairs) {
        if (st.from !== 0) continue;
        for (const [x, z] of stairCells(st)) if (inRect(r, x, z)) grid.setWalkable(x, z, false);
      }
    }
  }

  /** Rebuild every ground-floor wall edge on the map's ground grid. */
  applyEdgesToGround(grid: WalkGrid): void {
    grid.clearEdges();
    for (const info of this.byId.values()) for (const w of info.def.storeys[0]!.walls) blockWall(grid, w);
  }
}
