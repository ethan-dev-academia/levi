import {
  BuildingSchema,
  computeWalkRegion,
  getTerrainHeight,
  stairCells,
  wallKey,
  type Building,
  type BuildingsFile,
  type CellRect,
  type EnemySpawn,
  type SpawnZone,
  type GroundItem,
  type LootSlot,
  type NpcSpawn,
  type PropInstance,
  type Dir,
  type RoofKind,
  type Stair,
  type Wall,
  type WallKind,
  type WallMaterial,
} from "@levi/shared";
import type { DevContext } from "./types.js";

export type BuildToolId = "select" | "room" | "wall" | "door" | "window" | "floor" | "stairs" | "ladder" | "prop" | "npc" | "item" | "enemy" | "zone" | "erase";
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
  /** NPC tool: which NPC definition to place. */
  npc: string;
  /** Movement for newly placed NPCs. */
  npcWander: NpcSpawn["wander"];
  npcRadius: number;
  /** Placed NPC being edited (clicked); route clicks go to it while recording. */
  editNpc: string | null;
  recordingRoute: boolean;
  /** Item tool: which item lies on the ground, and how many. */
  groundItem: string;
  groundQty: number;
  /** Enemy tool: which enemy, and how far it roams. */
  enemy: string;
  enemyWander: "none" | "area";
  enemyRadius: number;
  /** Zone tool: the zone being painted, and whether strokes add or remove cells. */
  zone: string | null;
  zoneErase: boolean;
  zoneBrush: number;
}

export { propFacing } from "@levi/shared";

interface Snapshot {
  buildings: Building[];
  props: PropInstance[];
  npcs: NpcSpawn[];
  groundItems: GroundItem[];
  enemies: EnemySpawn[];
  zones: SpawnZone[];
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
    npc: "", groundItem: "", groundQty: 1,
    npcWander: "area", npcRadius: 1, editNpc: null, recordingRoute: false,
    enemy: "", enemyWander: "area", enemyRadius: 2, zone: null, zoneErase: false, zoneBrush: 1,
  };
  dirty = false;
  onChange: (() => void) | null = null;
  /** Open the loot editor for a chest (set by dev/index). */
  onEditLoot: ((prop: PropInstance) => void) | null = null;
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
    const index = this.ctx.data.buildings;
    return { buildings: this.defs(), props: [...index.props], npcs: [...index.npcs], groundItems: [...index.groundItems], enemies: [...index.enemies], zones: [...index.zones] };
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
    const index = this.ctx.data.buildings;
    this.undoStack.push(structuredClone({ buildings: this.defs(), props: [...index.props], npcs: [...index.npcs], groundItems: [...index.groundItems], enemies: [...index.enemies], zones: [...index.zones] }));
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
    index.setNpcs(prev.npcs);
    index.setGroundItems(prev.groundItems);
    index.setEnemies(prev.enemies);
    index.setZones(prev.zones);
    this.ctx.props.rebuild();
    this.ctx.npcLayer.rebuild();
    this.ctx.groundItems.rebuild();
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
    const existing = index.propAt(cx, cz, s.storey, building);
    // Clicking a chest edits its loot instead of removing it.
    if (existing && this.ctx.propDefs.get(existing.prop)?.container) {
      this.onEditLoot?.(existing);
      return `Editing ${this.ctx.propDefs.get(existing.prop)?.name ?? "chest"} loot.`;
    }
    this.checkpoint();
    let props: PropInstance[];
    let msg: string;
    let created: PropInstance | null = null;
    if (existing) {
      props = index.props.filter((p) => p !== existing);
      msg = `Removed ${this.ctx.propDefs.get(existing.prop)?.name ?? existing.prop}.`;
    } else {
      let n = index.props.length + 1;
      while (index.props.some((p) => p.id === `prop-${n}`)) n++;
      const inst: PropInstance = { id: `prop-${n}`, prop: def.id, x: cx, z: cz, rot: s.rot & 3, storey: s.storey, solid: def.solid };
      if (building) inst.building = building;
      if (def.readable) inst.text = s.signText.slice(0, 1000);
      if (def.container) {
        inst.loot = [];
        created = inst;
      }
      props = [...index.props, inst];
      msg = `Placed ${def.name}${def.readable ? ` ("${inst.text}")` : ""}.`;
    }
    index.setProps(props);
    this.ctx.props.rebuild();
    this.refreshGround({ cx0: cx, cz0: cz, cx1: cx, cz1: cz });
    this.dirty = true;
    this.onChange?.();
    if (created) this.onEditLoot?.(created);
    return msg;
  }

  /** Set a chest's loot (from the loot editor). */
  setPropLoot(id: string, loot: Array<LootSlot | null>): void {
    const index = this.ctx.data.buildings;
    if (!index.props.some((p) => p.id === id)) return;
    this.checkpoint();
    // Trim trailing empties so the file stays tidy.
    const trimmed = [...loot];
    while (trimmed.length > 0 && !trimmed[trimmed.length - 1]) trimmed.pop();
    index.setProps(index.props.map((p) => (p.id === id ? { ...p, loot: trimmed } : p)));
    this.dirty = true;
    this.onChange?.();
  }

  /** Delete a prop by id (chest editor's Remove button). */
  removeProp(id: string): void {
    const index = this.ctx.data.buildings;
    const prop = index.props.find((p) => p.id === id);
    if (!prop) return;
    this.checkpoint();
    index.setProps(index.props.filter((p) => p.id !== id));
    this.ctx.props.rebuild();
    this.refreshGround({ cx0: prop.x, cz0: prop.z, cx1: prop.x, cz1: prop.z });
    this.dirty = true;
    this.onChange?.();
  }

  /** NPC tool: place the chosen NPC on a cell (click an NPC to remove it). */
  placeNpc(cx: number, cz: number): string {
    const s = this.settings;
    const index = this.ctx.data.buildings;
    const building = s.storey > 0 ? s.selected : null;
    if (s.storey > 0 && !building) return "Select a building first to place NPCs upstairs.";
    // Recording a route: clicks add stops to the NPC being edited.
    const editing = s.editNpc ? index.npcs.find((n) => n.id === s.editNpc) : undefined;
    if (s.recordingRoute && editing) {
      if (editing.route.length >= 24) return "Routes can have up to 24 stops.";
      this.updateNpc(editing.id, { route: [...editing.route, [cx, cz]], wander: "route" });
      return `Route stop ${editing.route.length + 1} added. Click more cells, then Finish route.`;
    }
    const existing = index.npcAt(cx, cz, s.storey, building);
    if (existing) {
      // Click a placed NPC to edit (or remove) it.
      s.editNpc = existing.id;
      s.recordingRoute = false;
      this.onChange?.();
      return `Selected ${this.ctx.npcs.get(existing.npc)?.name ?? existing.npc}: set how they move below.`;
    }
    if (!this.ctx.npcs.has(s.npc)) return "Pick an NPC first (make one with F2).";
    this.checkpoint();
    let n = index.npcs.length + 1;
    while (index.npcs.some((x) => x.id === `npc-${n}`)) n++;
    const spawn: NpcSpawn = {
      id: `npc-${n}`, npc: s.npc, x: cx, z: cz, rot: s.rot & 3, storey: s.storey,
      wander: s.npcWander === "route" ? "none" : s.npcWander, radius: s.npcRadius, route: [],
    };
    if (building) spawn.building = building;
    index.setNpcs([...index.npcs, spawn]);
    let msg = `Placed ${this.ctx.npcs.get(s.npc)?.name ?? s.npc}.`;
    s.editNpc = spawn.id;
    if (s.npcWander === "route") {
      s.recordingRoute = true;
      msg += " Now click cells to lay out their route, then Finish route.";
    }
    this.ctx.npcLayer.rebuild();
    this.refreshGround({ cx0: cx, cz0: cz, cx1: cx, cz1: cz });
    this.dirty = true;
    this.onChange?.();
    return msg;
  }

  /** The placed NPC currently selected for editing. */
  placedNpc(): NpcSpawn | undefined {
    const id = this.settings.editNpc;
    return id ? this.ctx.data.buildings.npcs.find((n) => n.id === id) : undefined;
  }

  /** Change a placed NPC's settings (movement, route...). */
  updateNpc(id: string, patch: Partial<Pick<NpcSpawn, "wander" | "radius" | "route" | "rot">>): void {
    const index = this.ctx.data.buildings;
    if (!index.npcs.some((n) => n.id === id)) return;
    this.checkpoint();
    index.setNpcs(index.npcs.map((n) => (n.id === id ? { ...n, ...patch } : n)));
    const sp = index.npcs.find((n) => n.id === id)!;
    this.ctx.npcLayer.rebuild();
    this.refreshGround({ cx0: sp.x, cz0: sp.z, cx1: sp.x, cz1: sp.z });
    this.dirty = true;
    this.onChange?.();
  }

  removeNpc(id: string): void {
    const index = this.ctx.data.buildings;
    const sp = index.npcs.find((n) => n.id === id);
    if (!sp) return;
    this.checkpoint();
    index.setNpcs(index.npcs.filter((n) => n.id !== id));
    this.settings.editNpc = null;
    this.settings.recordingRoute = false;
    this.ctx.npcLayer.rebuild();
    this.refreshGround({ cx0: sp.x, cz0: sp.z, cx1: sp.x, cz1: sp.z });
    this.dirty = true;
    this.onChange?.();
  }

  /** Enemy tool: place the chosen enemy's home spot (click an existing spot to remove it). */
  placeEnemy(cx: number, cz: number): string {
    const s = this.settings;
    const index = this.ctx.data.buildings;
    if (s.storey > 0) return "Enemies live on the ground for now.";
    const existing = index.enemies.find((e) => e.x === cx && e.z === cz);
    if (!existing && !this.ctx.enemyDefs.has(s.enemy)) return "Pick an enemy first (make one with F2).";
    this.checkpoint();
    let msg: string;
    if (existing) {
      index.setEnemies(index.enemies.filter((e) => e !== existing));
      msg = `Removed ${this.ctx.enemyDefs.get(existing.enemy)?.name ?? existing.enemy}.`;
    } else {
      let n = index.enemies.length + 1;
      while (index.enemies.some((x) => x.id === `enemy-${n}`)) n++;
      const spawn: EnemySpawn = {
        id: `enemy-${n}`, enemy: s.enemy, x: cx, z: cz, rot: s.rot & 3, storey: 0,
        wander: s.enemyWander, radius: s.enemyRadius, route: [],
      };
      index.setEnemies([...index.enemies, spawn]);
      msg = `Placed ${this.ctx.enemyDefs.get(s.enemy)?.name ?? s.enemy}.`;
    }
    this.dirty = true;
    this.onChange?.();
    return msg;
  }

  // --- Spawn zones -------------------------------------------------------------------------------

  get zones(): readonly SpawnZone[] {
    return this.ctx.data.buildings.zones;
  }

  selectedZone(): SpawnZone | undefined {
    return this.zones.find((z) => z.id === this.settings.zone);
  }

  private setZones(list: SpawnZone[]): void {
    this.ctx.data.buildings.setZones(list);
    this.dirty = true;
    this.onChange?.();
  }

  newZone(): void {
    this.checkpoint();
    let n = this.zones.length + 1;
    while (this.zones.some((z) => z.id === `zone-${n}`)) n++;
    const z: SpawnZone = { id: `zone-${n}`, name: `Zone ${n}`, cells: [], mobs: [] };
    this.settings.zone = z.id;
    this.settings.zoneErase = false;
    this.setZones([...this.zones, z]);
  }

  updateZone(id: string, patch: Partial<Pick<SpawnZone, "name" | "mobs">>): void {
    if (!this.zones.some((z) => z.id === id)) return;
    this.checkpoint();
    this.setZones(this.zones.map((z) => (z.id === id ? { ...z, ...patch } : z)));
  }

  deleteZone(id: string): void {
    this.checkpoint();
    if (this.settings.zone === id) this.settings.zone = null;
    this.setZones(this.zones.filter((z) => z.id !== id));
  }

  /** Start a paint stroke (one undo step per stroke). */
  beginZoneStroke(): string | null {
    if (this.settings.storey > 0) return "Spawn zones are painted on the ground.";
    if (!this.selectedZone()) return "Make or pick a zone first (Zone panel below).";
    this.checkpoint();
    return null;
  }

  /** Paint (or erase) a square brush of cells into the selected zone. */
  paintZone(cx: number, cz: number): void {
    const z = this.selectedZone();
    if (!z) return;
    const r = this.settings.zoneBrush - 1;
    const set = new Set(z.cells.map(([x, y]) => `${x},${y}`));
    let changed = false;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const k = `${cx + dx},${cz + dz}`;
        if (this.settings.zoneErase ? set.delete(k) : !set.has(k) && set.add(k)) changed = true;
      }
    }
    if (!changed) return;
    const cells = [...set].map((k) => k.split(",").map(Number) as [number, number]);
    this.ctx.data.buildings.setZones(this.zones.map((x) => (x.id === z.id ? { ...x, cells } : x)));
    this.dirty = true;
  }

  endZoneStroke(): void {
    this.onChange?.();
  }

  /** Item tool: drop the chosen item on a cell (click one to remove it). */
  placeGroundItem(cx: number, cz: number): string {
    const s = this.settings;
    const index = this.ctx.data.buildings;
    const building = s.storey > 0 ? s.selected : null;
    if (s.storey > 0 && !building) return "Select a building first to place items upstairs.";
    const existing = index.groundItemAt(cx, cz, s.storey, building);
    if (!existing && !this.ctx.items.has(s.groundItem)) return "Pick an item first.";
    this.checkpoint();
    let msg: string;
    if (existing) {
      index.setGroundItems(index.groundItems.filter((g) => g !== existing));
      msg = `Removed ${this.ctx.items.get(existing.item)?.name ?? existing.item} from the ground.`;
    } else {
      let n = index.groundItems.length + 1;
      while (index.groundItems.some((x) => x.id === `ground-${n}`)) n++;
      const g: GroundItem = { id: `ground-${n}`, item: s.groundItem, qty: Math.max(1, Math.min(10, s.groundQty)), x: cx, z: cz, storey: s.storey };
      if (building) g.building = building;
      index.setGroundItems([...index.groundItems, g]);
      msg = `Dropped ${g.qty > 1 ? `${g.qty}× ` : ""}${this.ctx.items.get(g.item)?.name ?? g.item} on the ground.`;
    }
    this.ctx.groundItems.rebuild();
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
