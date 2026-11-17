import {
  BuildingSchema,
  computeWalkRegion,
  getTerrainHeight,
  stairCells,
  wallKey,
  type Building,
  type BuildingsFile,
  type CellRect,
  type PropInstance,
  type Dir,
  type RoofKind,
  type Stair,
  type Wall,
  type WallKind,
  type WallMaterial,
} from "@levi/shared";
import type { DevContext } from "./types.js";

export type BuildToolId = "select" | "room" | "wall" | "door" | "window" | "floor" | "stairs" | "ladder" | "prop" | "erase";
export type RoomPreset = "house" | "shed" | "floor";
export type Side = "n" | "e" | "s" | "w";

export interface BuildSettings {
  tool: BuildToolId;
  preset: RoomPreset;
  material: WallMaterial;
  /** Storey being edited. */
  storey: number;
  /** Selected building (edits on upper storeys go to it). */
  selected: string | null;
  /** Prop tool: which prop, facing (quarter turns), text for readable props. */
  prop: string;
  rot: number;
  signText: string;
}

/** Facing of a prop with `rot` quarter turns, as a cell step [dx, dz]. */
export function propFacing(rot: number): [number, number] {
  return [[0, 1], [-1, 0], [0, -1], [1, 0]][rot & 3] as [number, number];
}

interface Snapshot {
  buildings: Building[];
  props: PropInstance[];
}

/** A wall edge without kind/material. */
export type Edge = Pick<Wall, "x" | "z" | "axis">;

const MAX_UNDO = 80;

/** Edges around a cell rect, by side. */
export function rectEdges(r: CellRect): Record<Side, Edge[]> {
  const out: Record<Side, Edge[]> = { n: [], e: [], s: [], w: [] };
  for (let x = r.cx0; x <= r.cx1; x++) {
    out.n.push({ axis: "x", x, z: r.cz0 });
    out.s.push({ axis: "x", x, z: r.cz1 + 1 });
  }
  for (let z = r.cz0; z <= r.cz1; z++) {
    out.w.push({ axis: "z", x: r.cx0, z });
    out.e.push({ axis: "z", x: r.cx1 + 1, z });
  }
  return out;
}

function grow(r: CellRect, n: number): CellRect {
  return { cx0: r.cx0 - n, cz0: r.cz0 - n, cx1: r.cx1 + n, cz1: r.cz1 + n };
}

function union(a: CellRect, b: CellRect): CellRect {
  return { cx0: Math.min(a.cx0, b.cx0), cz0: Math.min(a.cz0, b.cz0), cx1: Math.max(a.cx1, b.cx1), cz1: Math.max(a.cz1, b.cz1) };
}

function overlaps(a: CellRect, b: CellRect): boolean {
  return a.cx0 <= b.cx1 && b.cx0 <= a.cx1 && a.cz0 <= b.cz1 && b.cz0 <= a.cz1;
}

function inRect(r: CellRect, x: number, z: number): boolean {
  return x >= r.cx0 && z >= r.cz0 && x <= r.cx1 && z <= r.cz1;
}

/**
 * Building editor: every operation edits a copy of a building definition,
 * validates it, swaps it into the map's BuildingIndex and refreshes walk
 * grid, meshes and map image. Whole-file snapshots give simple undo.
 */
export class BuildTool {
  readonly settings: BuildSettings = {
    tool: "room", preset: "house", material: "wood", storey: 0, selected: null,
    prop: "barrel", rot: 0, signText: "Welcome!",
  };
  dirty = false;
  onChange: (() => void) | null = null;
  private readonly undoStack: Snapshot[] = [];

  constructor(private readonly ctx: DevContext) {}

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get selected(): Building | null {
    const id = this.settings.selected;
    return id ? this.ctx.data.buildings.get(id)?.def ?? null : null;
  }

  /** All building definitions (for saving). */
  defs(): Building[] {
    return this.ctx.data.buildings.defs();
  }

  /** The whole buildings file (buildings + props), for saving. */
  file(): BuildingsFile {
    return { buildings: this.defs(), props: [...this.ctx.data.buildings.props] };
  }

  /** Height of the plane being edited, or null = use the terrain. */
  editPlaneY(): number | null {
    const b = this.selected;
    return b ? b.baseY + this.settings.storey * b.floorHeight : null;
  }

  select(id: string | null): void {
    this.settings.selected = id;
    const b = this.selected;
    if (!b) this.settings.storey = 0;
    else this.settings.storey = Math.min(this.settings.storey, b.storeys.length);
    this.onChange?.();
  }

  setStorey(n: number): void {
    const max = this.selected ? this.selected.storeys.length : 0;
    this.settings.storey = Math.max(0, Math.min(max, n));
    this.onChange?.();
  }

  // --- Undo / refresh ----------------------------------------------------------

  private checkpoint(): void {
    this.undoStack.push(structuredClone({ buildings: this.defs(), props: [...this.ctx.data.buildings.props] }));
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
  }

  undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) return;
    const index = this.ctx.data.buildings;
    let area: CellRect | null = null;
    for (const info of [...index.all()]) {
      area = area ? union(area, info.bounds) : info.bounds;
      index.remove(info.def.id);
    }
    for (const def of prev.buildings) {
      const info = index.set(def);
      area = area ? union(area, info.bounds) : info.bounds;
    }
    for (const p of [...index.props, ...prev.props]) {
      const c: CellRect = { cx0: p.x, cz0: p.z, cx1: p.x, cz1: p.z };
      area = area ? union(area, c) : c;
    }
    index.setProps(prev.props);
    this.ctx.props.rebuild();
    if (this.settings.selected && !index.get(this.settings.selected)) this.settings.selected = null;
    this.ctx.buildings.rebuildAll();
    if (area) this.refreshGround(area);
    this.dirty = true;
    this.onChange?.();
  }

  /** Re-derive walkability and the map image after building changes. */
  private refreshGround(area: CellRect): void {
    const { data, walk, mapImage, terrain } = this.ctx;
    const r = grow(area, 1);
    computeWalkRegion(walk, data, r);
    data.buildings.applyEdgesToGround(walk);
    terrain.rebuildCells(r);
    mapImage.redraw(r);
  }

  /** Validate + commit an edited definition (or delete it when empty). */
  private commit(def: Building, isNew = false): void {
    const index = this.ctx.data.buildings;
    const old = index.get(def.id)?.bounds ?? null;
    this.trimStoreys(def);
    const empty = def.storeys.every((s) => s.tiles.length === 0 && s.walls.length === 0) && def.stairs.length === 0;
    if (empty) {
      index.remove(def.id);
      this.dropPropsOf(def.id);
      if (this.settings.selected === def.id) this.settings.selected = null;
      this.ctx.buildings.rebuild(def.id);
      if (old) this.refreshGround(old);
    } else {
      const info = index.set(BuildingSchema.parse(def));
      this.ctx.buildings.rebuild(def.id);
      this.ctx.props.rebuild();
      this.refreshGround(old ? union(old, info.bounds) : info.bounds);
      if (isNew) this.settings.selected = def.id;
    }
    this.settings.storey = Math.min(this.settings.storey, Math.max(0, (index.get(def.id)?.def.storeys.length ?? 1)));
    this.dirty = true;
    this.onChange?.();
  }

  /** Drop empty storeys from the top that no stairs reach. */
  private trimStoreys(def: Building): void {
    while (def.storeys.length > 1) {
      const k = def.storeys.length - 1;
      const top = def.storeys[k]!;
      if (top.tiles.length > 0 || top.walls.length > 0 || def.stairs.some((s) => s.to >= k)) break;
      def.storeys.pop();
    }
  }

  private ensureStoreys(def: Building, n: number): void {
    while (def.storeys.length < n) def.storeys.push({ tiles: [], walls: [] });
  }

  /** Building to edit for a cell rect: the selection, else one it touches (storey 0 only). */
  private targetFor(r: CellRect): Building | null {
    const sel = this.selected;
    if (sel) {
      const info = this.ctx.data.buildings.get(sel.id)!;
      if (this.settings.storey > 0 || overlaps(grow(info.bounds, 1), r)) return structuredClone(sel);
    }
    if (this.settings.storey > 0) return null;
    for (const info of this.ctx.data.buildings.all()) if (overlaps(grow(info.bounds, 1), r)) return structuredClone(info.def);
    return null;
  }

  private newBuilding(r: CellRect, roof: RoofKind): Building {
    const index = this.ctx.data.buildings;
    let n = index.size + 1;
    while (index.get(`building-${n}`)) n++;
    // Floor sits just above the highest terrain under it; a foundation fills the gap.
    let top = -Infinity;
    for (let z = r.cz0; z <= r.cz1 + 1; z++) {
      for (let x = r.cx0; x <= r.cx1 + 1; x++) top = Math.max(top, getTerrainHeight(this.ctx.data.hm, x, z));
    }
    return BuildingSchema.parse({
      id: `building-${n}`,
      name: `Building ${n}`,
      material: this.settings.material,
      baseY: Math.round((top + 0.1) * 100) / 100,
      storeys: [{ tiles: [], walls: [] }],
      roof: { kind: roof },
    });
  }

  // --- Operations ----------------------------------------------------------------

  /** Room / floor tool: tiles for the rect plus walls per preset. `openSide` faces the camera. */
  placeRoom(r: CellRect, cameraSide: Side): string {
    const s = this.settings;
    let def = this.targetFor(r);
    let isNew = false;
    if (!def) {
      if (s.storey > 0) return "Select a building first (Select tool) to build on an upper storey.";
      def = this.newBuilding(r, s.preset === "shed" ? "shed" : "gable");
      isNew = true;
    }
    this.checkpoint();
    this.ensureStoreys(def, s.storey + 1);
    const storey = def.storeys[s.storey]!;
    const tiles = new Set(storey.tiles.map(([x, z]) => `${x},${z}`));
    for (let z = r.cz0; z <= r.cz1; z++) for (let x = r.cx0; x <= r.cx1; x++) {
      if (!tiles.has(`${x},${z}`)) storey.tiles.push([x, z]);
    }
    if (s.preset !== "floor") {
      const walls = new Map(storey.walls.map((w) => [wallKey(w), w]));
      const sides = rectEdges(r);
      for (const side of ["n", "e", "s", "w"] as const) {
        if (s.preset === "shed" && side === cameraSide) continue; // open front
        const edges = sides[side];
        edges.forEach((e, i) => {
          const door = s.preset === "house" && s.storey === 0 && side === cameraSide && i === Math.floor((edges.length - 1) / 2);
          walls.set(wallKey(e), { ...e, kind: door ? "door" : "wall", material: s.material === def.material ? undefined : s.material } as Wall);
        });
      }
      storey.walls = [...walls.values()].map(stripUndefined);
    }
    this.commit(def, isNew);
    const size = `${r.cx1 - r.cx0 + 1}×${r.cz1 - r.cz0 + 1}`;
    return `${isNew ? "New" : "Extended"} ${def.name}: ${s.preset} ${size} on storey ${s.storey}.`;
  }

  /** Wall / door / window tool over a run of edges. A run that's already all `kind` is removed. */
  paintEdges(edges: Edge[], kind: WallKind): string {
    if (edges.length === 0) return "";
    const s = this.settings;
    const r = edgesRect(edges);
    const def = this.targetFor(r);
    if (!def) return s.storey > 0 ? "Select a building first." : "Walls belong to a building: drag a Room first (or select one).";
    this.checkpoint();
    this.ensureStoreys(def, s.storey + 1);
    const storey = def.storeys[s.storey]!;
    const walls = new Map(storey.walls.map((w) => [wallKey(w), w]));
    const allSame = edges.every((e) => walls.get(wallKey(e))?.kind === kind);
    for (const e of edges) {
      if (allSame) walls.delete(wallKey(e));
      else walls.set(wallKey(e), stripUndefined({ ...e, kind, material: s.material === def.material ? undefined : s.material } as Wall));
    }
    storey.walls = [...walls.values()];
    this.commit(def);
    return allSame ? `Removed ${edges.length} ${kind}(s).` : `Placed ${edges.length} ${kind}(s).`;
  }

  /** Erase tiles, walls and stairs inside a rect on the edited storey. */
  erase(r: CellRect): string {
    const def = this.targetFor(r);
    if (!def) return "Nothing to erase here.";
    const k = this.settings.storey;
    const storey = def.storeys[k];
    if (!storey) return "Nothing on this storey.";
    this.checkpoint();
    const before = storey.tiles.length + storey.walls.length + def.stairs.length;
    storey.tiles = storey.tiles.filter(([x, z]) => !inRect(r, x, z));
    storey.walls = storey.walls.filter((w) => {
      // A wall is inside if both cells it separates touch the rect.
      const [ax, az, bx, bz] = w.axis === "x" ? [w.x, w.z - 1, w.x, w.z] : [w.x - 1, w.z, w.x, w.z];
      return !(inRect(r, ax, az) || inRect(r, bx, bz));
    });
    def.stairs = def.stairs.filter((st) => !(k >= st.from && k <= st.to && stairCells(st).some(([x, z]) => inRect(r, x, z))));
    const removed = before - (storey.tiles.length + storey.walls.length + def.stairs.length);
    const index = this.ctx.data.buildings;
    const keep = index.props.filter((p) => !(p.storey === k && inRect(r, p.x, p.z) && (k === 0 || p.building === def.id)));
    const propsRemoved = index.props.length - keep.length;
    if (propsRemoved > 0) {
      index.setProps(keep);
      this.ctx.props.rebuild();
    }
    this.commit(def);
    return `Erased ${removed + propsRemoved} piece(s).`;
  }

  /** Stairs / ladder at a cell, climbing away from the camera. Clicking one again removes it. */
  placeStair(cx: number, cz: number, kind: Stair["kind"], dir: Dir): string {
    const r: CellRect = { cx0: cx, cz0: cz, cx1: cx, cz1: cz };
    const def = this.targetFor(r);
    if (!def) return "Stairs belong to a building: drag a Room first (or select one).";
    const k = this.settings.storey;
    this.checkpoint();
    const existing = def.stairs.find((s) => k >= s.from && k <= s.to && stairCells(s).some(([x, z]) => x === cx && z === cz));
    if (existing) {
      def.stairs = def.stairs.filter((s) => s !== existing);
      this.commit(def);
      return `Removed ${existing.kind}.`;
    }
    // Same spot one storey down? Extend that flight instead (stacked ladders).
    const below = def.stairs.find((s) => s.kind === kind && s.x === cx && s.z === cz && s.dir === dir && s.to === k);
    this.ensureStoreys(def, k + 2);
    if (below) below.to = k + 1;
    else {
      let n = def.stairs.length + 1;
      while (def.stairs.some((s) => s.id === `stair-${n}`)) n++;
      def.stairs.push({ id: `stair-${n}`, kind, x: cx, z: cz, dir, length: kind === "ladder" ? 1 : 3, from: k, to: k + 1 });
    }
    this.commit(def);
    return `${kind === "ladder" ? "Ladder" : "Stairs"} from storey ${below ? below.from : k} to ${k + 1}. Add a floor up there (Storey ${k + 1}, Room or Floor tool).`;
  }

  // --- Props ----------------------------------------------------------------------

  /** Place the selected prop at a cell of the edited storey; clicking an existing prop removes it. */
  placeProp(cx: number, cz: number): string {
    const s = this.settings;
    const index = this.ctx.data.buildings;
    const def = this.ctx.propDefs.get(s.prop);
    if (!def) return `Unknown prop "${s.prop}".`;
    const building = s.storey > 0 ? s.selected : index.containing(cx, cz)?.def.id ?? null;
    if (s.storey > 0 && !building) return "Select a building first to furnish an upper storey.";
    this.checkpoint();
    const existing = index.propAt(cx, cz, s.storey, building);
    let props: PropInstance[];
    let msg: string;
    if (existing) {
      props = index.props.filter((p) => p !== existing);
      msg = `Removed ${this.ctx.propDefs.get(existing.prop)?.name ?? existing.prop}.`;
    } else {
      let n = index.props.length + 1;
      while (index.props.some((p) => p.id === `prop-${n}`)) n++;
      const inst: PropInstance = { id: `prop-${n}`, prop: def.id, x: cx, z: cz, rot: s.rot & 3, storey: s.storey, solid: def.solid };
      if (building) inst.building = building;
      if (def.readable) inst.text = s.signText.slice(0, 1000);
      props = [...index.props, inst];
      msg = `Placed ${def.name}${def.readable ? ` ("${inst.text}")` : ""}.`;
    }
    index.setProps(props);
    this.ctx.props.rebuild();
    this.refreshGround({ cx0: cx, cz0: cz, cx1: cx, cz1: cz });
    this.dirty = true;
    this.onChange?.();
    return msg;
  }

  rotateProp(): void {
    this.settings.rot = (this.settings.rot + 1) & 3;
    this.onChange?.();
  }

  private dropPropsOf(buildingId: string): void {
    const index = this.ctx.data.buildings;
    const keep = index.props.filter((p) => !(p.building === buildingId && p.storey > 0));
    if (keep.length !== index.props.length) index.setProps(keep);
    this.ctx.props.rebuild();
  }

  /** Select the building under a cell (or clear the selection). */
  pick(cx: number, cz: number): string {
    const info = this.ctx.data.buildings.containing(cx, cz);
    this.select(info?.def.id ?? null);
    return info ? `Selected ${info.def.name}.` : "Selection cleared.";
  }

  updateSelected(patch: Partial<Pick<Building, "name" | "material" | "baseY" | "floorHeight">> & { roof?: Partial<Building["roof"]> }): void {
    const sel = this.selected;
    if (!sel) return;
    this.checkpoint();
    const def = structuredClone(sel);
    const { roof, ...rest } = patch;
    Object.assign(def, rest);
    if (roof) def.roof = { ...def.roof, ...roof };
    this.commit(def);
  }

  deleteSelected(): void {
    const sel = this.selected;
    if (!sel) return;
    this.checkpoint();
    const info = this.ctx.data.buildings.remove(sel.id);
    this.dropPropsOf(sel.id);
    this.settings.selected = null;
    this.settings.storey = 0;
    this.ctx.buildings.rebuild(sel.id);
    if (info) this.refreshGround(info.bounds);
    this.dirty = true;
    this.onChange?.();
  }
}

function edgesRect(edges: Edge[]): CellRect {
  let r: CellRect | null = null;
  for (const e of edges) {
    const c: CellRect = { cx0: e.x - 1, cz0: e.z - 1, cx1: e.x, cz1: e.z };
    r = r ? union(r, c) : c;
  }
  return r!;
}

/** exactOptionalPropertyTypes: drop keys whose value is undefined. */
function stripUndefined<T extends object>(o: T): T {
  for (const k of Object.keys(o) as Array<keyof T>) if (o[k] === undefined) delete o[k];
  return o;
}
