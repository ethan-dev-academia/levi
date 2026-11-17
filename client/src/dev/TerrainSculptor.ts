import {
  chunkKey,
  computeWalkRegion,
  floatRegion,
  getTerrainHeight,
  regionCellRect,
  sinkOutsideRegions,
  WALK_BLOCKED,
  type CellRect,
  type MapChunk,
  type MapDef,
  type Region,
  type SaveMapRequest,
  type Vec2,
  type WalkOverride,
} from "@levi/shared";
import type { DevContext } from "./types.js";

export type SculptTool = "raise" | "lower" | "smooth" | "flatten" | "set" | "paint" | "walk" | "void" | "region";

export interface SculptSettings {
  tool: SculptTool;
  /** World units. */
  radius: number;
  /** Height tools: units/second at brush centre. Blend tools: rate. */
  strength: number;
  /** Target for the "set" tool. */
  setHeight: number;
  /** Terrain material id for "paint". */
  material: number;
  /** Override for "walk". */
  walkMode: WalkOverride;
  /** "void" tool: true = cut a hole, false = fill it back in. */
  voidCut: boolean;
}

interface UndoEntry {
  chunks: Map<string, MapChunk>;
  /** Map-level settings (regions, base/water height) before the edit. */
  def?: MapDef;
}

const MAX_UNDO = 60;

/** Smooth radial falloff: 1 at centre → 0 at the rim. */
function falloff(d: number, r: number): number {
  if (d >= r) return 0;
  const t = d / r;
  const u = 1 - t * t;
  return u * u;
}

/**
 * Edits MapData in place and keeps every derived view in sync: walk grid,
 * terrain chunks, topology (floating islands), map image. Tracks dirty
 * chunks for saving, plus chunk-granular undo.
 */
export class TerrainSculptor {
  readonly settings: SculptSettings = {
    tool: "raise",
    radius: 6,
    strength: 3,
    setHeight: 2,
    material: 1,
    walkMode: WALK_BLOCKED,
    voidCut: true,
  };
  readonly dirty = new Set<string>();
  defDirty = false;
  onChange: (() => void) | null = null;

  private stroke: { backup: Map<string, MapChunk>; flattenTo: number } | null = null;
  private readonly undoStack: UndoEntry[] = [];

  constructor(private readonly ctx: DevContext) {}

  get hasUnsaved(): boolean {
    return this.dirty.size > 0 || this.defDirty;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  // --- Brush strokes -----------------------------------------------------

  beginStroke(at: Vec2): void {
    this.stroke = { backup: new Map(), flattenTo: getTerrainHeight(this.ctx.data.hm, at.x, at.z) };
  }

  endStroke(): void {
    if (this.stroke && this.stroke.backup.size > 0) {
      this.pushUndo({ chunks: this.stroke.backup });
      this.refreshTopology();
    }
    this.stroke = null;
    this.onChange?.();
  }

  get isStroking(): boolean {
    return this.stroke !== null;
  }

  /** Apply the active brush at `at` for `dt` seconds. */
  apply(at: Vec2, dt: number): void {
    if (!this.stroke) return;
    const t = this.settings.tool;
    if (t === "region") return; // handled by the region drag in dev/index
    if (t === "paint" || t === "walk" || t === "void") this.applyCells(at);
    else this.applyHeights(at, dt);
  }

  private applyHeights(at: Vec2, dt: number): void {
    const { hm } = this.ctx.data;
    const { tool, radius: r, strength } = this.settings;
    const cs = hm.cellSize;
    const vx0 = Math.max(0, Math.floor((at.x - r) / cs));
    const vz0 = Math.max(0, Math.floor((at.z - r) / cs));
    const vx1 = Math.min(hm.cols, Math.ceil((at.x + r) / cs));
    const vz1 = Math.min(hm.rows, Math.ceil((at.z + r) / cs));
    if (vx1 < vx0 || vz1 < vz0) return;

    const region: CellRect = { cx0: vx0 - 1, cz0: vz0 - 1, cx1: vx1, cz1: vz1 };
    this.snapshot(region);

    // Smoothing reads from an unmodified copy so the result is order-independent.
    const w = vx1 - vx0 + 1;
    let src: Float32Array | null = null;
    if (tool === "smooth") {
      src = new Float32Array(w * (vz1 - vz0 + 1));
      for (let vz = vz0; vz <= vz1; vz++) for (let vx = vx0; vx <= vx1; vx++) src[(vz - vz0) * w + (vx - vx0)] = hm.vertex(vx, vz);
    }
    const read = (vx: number, vz: number): number =>
      src && vx >= vx0 && vx <= vx1 && vz >= vz0 && vz <= vz1 ? src[(vz - vz0) * w + (vx - vx0)]! : hm.vertex(vx, vz);

    const target = tool === "set" ? this.settings.setHeight : this.stroke!.flattenTo;
    for (let vz = vz0; vz <= vz1; vz++) {
      for (let vx = vx0; vx <= vx1; vx++) {
        const f = falloff(Math.hypot(vx * cs - at.x, vz * cs - at.z), r);
        if (f <= 0) continue;
        const h = hm.vertex(vx, vz);
        const blend = 1 - Math.exp(-strength * dt * f * 1.5);
        let next = h;
        switch (tool) {
          case "raise": next = h + strength * dt * f; break;
          case "lower": next = h - strength * dt * f; break;
          case "smooth": {
            const avg = (read(vx - 1, vz) + read(vx + 1, vz) + read(vx, vz - 1) + read(vx, vz + 1) + read(vx, vz)) / 5;
            next = h + (avg - h) * blend;
            break;
          }
          case "flatten":
          case "set": next = h + (target - h) * blend; break;
          default: break;
        }
        hm.setVertex(vx, vz, Math.max(-300, Math.min(300, next)));
      }
    }
    this.afterEdit(region);
  }

  private applyCells(at: Vec2): void {
    const { data } = this.ctx;
    const { def } = data;
    const { tool, radius: r, material, walkMode, voidCut } = this.settings;
    const cs = def.cellSize;
    const cx0 = Math.max(0, Math.floor((at.x - r) / cs));
    const cz0 = Math.max(0, Math.floor((at.z - r) / cs));
    const cx1 = Math.min(def.cols - 1, Math.floor((at.x + r) / cs));
    const cz1 = Math.min(def.rows - 1, Math.floor((at.z + r) / cs));
    if (cx1 < cx0 || cz1 < cz0) return;

    const layer = tool === "paint" ? data.paint : tool === "walk" ? data.walkOverride : data.holes;
    const value = tool === "paint" ? material : tool === "walk" ? walkMode : voidCut ? 1 : 0;
    const region: CellRect = { cx0, cz0, cx1, cz1 };
    let changed = false;

    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        if (Math.hypot((cx + 0.5) * cs - at.x, (cz + 0.5) * cs - at.z) > r) continue;
        const i = cz * def.cols + cx;
        if (layer[i] === value) continue;
        if (!changed) { this.snapshot(region); changed = true; }
        layer[i] = value;
      }
    }
    if (changed) this.afterEdit(region);
  }

  /** Save pre-edit state of every chunk this stroke is about to touch. */
  private snapshot(region: CellRect, into?: Map<string, MapChunk>): void {
    const backup = into ?? this.stroke?.backup;
    if (!backup) return;
    for (const [kx, kz] of this.ctx.data.chunksTouching(region)) {
      const key = chunkKey(kx, kz);
      if (!backup.has(key)) backup.set(key, this.ctx.data.extractChunk(kx, kz));
    }
  }

  /** Re-derive walk grid, meshes and map image for an edited region; mark dirty. */
  private afterEdit(region: CellRect): void {
    const { data, walk, terrain, mapImage } = this.ctx;
    const grown: CellRect = { cx0: region.cx0 - 1, cz0: region.cz0 - 1, cx1: region.cx1 + 1, cz1: region.cz1 + 1 };
    computeWalkRegion(walk, data, grown);
    terrain.rebuildCells(grown);
    mapImage.redraw(grown);
    for (const [kx, kz] of data.chunksTouching(region)) this.dirty.add(chunkKey(kx, kz));
  }

  /** Floating/underside info is global; recompute after a stroke, rebuild what changed. */
  private refreshTopology(): void {
    const changed = this.ctx.topo.recompute(this.ctx.data.def.chunkCells);
    this.ctx.terrain.rebuildChunks(changed);
  }

  private fullRect(): CellRect {
    const { def } = this.ctx.data;
    return { cx0: 0, cz0: 0, cx1: def.cols - 1, cz1: def.rows - 1 };
  }

  private pushUndo(entry: UndoEntry): void {
    this.undoStack.push(entry);
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
  }

  // --- Undo -------------------------------------------------------------------

  undo(): void {
    const entry = this.undoStack.pop();
    if (!entry) return;
    const { data } = this.ctx;
    if (entry.def) {
      data.def = entry.def;
      this.ctx.water.position.y = entry.def.waterLevel;
      this.defDirty = true;
      this.ctx.onRegionsChanged();
    }
    const n = data.def.chunkCells;
    let region: CellRect | null = null;
    for (const chunk of entry.chunks.values()) {
      data.applyChunk(chunk);
      const r = { cx0: chunk.kx * n, cz0: chunk.kz * n, cx1: chunk.kx * n + n - 1, cz1: chunk.kz * n + n - 1 };
      region = region
        ? { cx0: Math.min(region.cx0, r.cx0), cz0: Math.min(region.cz0, r.cz0), cx1: Math.max(region.cx1, r.cx1), cz1: Math.max(region.cz1, r.cz1) }
        : r;
    }
    if (entry.def) {
      // Map-level settings changed (water/base height): everything re-derives.
      this.afterEdit(this.fullRect());
      this.ctx.terrain.rebuildAll();
    } else if (region) {
      this.afterEdit(region);
    }
    this.refreshTopology();
    this.onChange?.();
  }

  // --- Map-level operations -------------------------------------------------

  setWaterLevel(level: number): void {
    const { data, walk, terrain, mapImage, water } = this.ctx;
    this.pushUndo({ chunks: new Map(), def: structuredClone(data.def) });
    data.def.waterLevel = level;
    water.position.y = level;
    computeWalkRegion(walk, data, this.fullRect());
    this.refreshTopology();
    terrain.rebuildAll();
    mapImage.redraw(this.fullRect());
    this.defDirty = true;
    this.onChange?.();
  }

  setSpawn(p: Vec2): void {
    this.ctx.data.def.spawn = { x: Math.round(p.x * 100) / 100, z: Math.round(p.z * 100) / 100 };
    this.defDirty = true;
    this.onChange?.();
  }

  // --- Regions -------------------------------------------------------------------

  get regions(): readonly Region[] {
    return this.ctx.data.def.regions;
  }

  get waterLevel(): number {
    return this.ctx.data.def.waterLevel;
  }

  addRegion(bounds: Region["bounds"]): Region {
    const { def } = this.ctx.data;
    this.pushUndo({ chunks: new Map(), def: structuredClone(def) });
    let n = def.regions.length + 1;
    while (def.regions.some((r) => r.id === `region-${n}`)) n++;
    const region: Region = { id: `region-${n}`, name: `Region ${n}`, kind: "island", bounds };
    def.regions.push(region);
    this.regionsChanged();
    return region;
  }

  updateRegion(id: string, patch: Partial<Pick<Region, "name" | "kind">>): void {
    const r = this.ctx.data.def.regions.find((x) => x.id === id);
    if (!r) return;
    Object.assign(r, patch);
    this.regionsChanged();
  }

  deleteRegion(id: string): void {
    const { def } = this.ctx.data;
    this.pushUndo({ chunks: new Map(), def: structuredClone(def) });
    def.regions = def.regions.filter((r) => r.id !== id);
    this.regionsChanged();
  }

  /** Lift a region's land into the sky and cut void around it. */
  floatRegion(id: string, lift: number): string {
    const { data } = this.ctx;
    const region = data.def.regions.find((r) => r.id === id);
    if (!region) return "No such region.";
    const rect = regionCellRect(data, region);
    const backup = new Map<string, MapChunk>();
    this.snapshot(rect, backup);
    this.pushUndo({ chunks: backup, def: structuredClone(data.def) });

    const res = floatRegion(data, rect, lift);
    region.kind = "sky";
    region.altitude = Math.round((data.def.waterLevel + lift) * 10) / 10;
    this.afterEdit(rect);
    this.refreshTopology();
    this.regionsChanged();
    return `Floated "${region.name}" +${lift}: ${res.landCells} land cells lifted, ${res.voidCells} cells cut to void.`;
  }

  /** Everything outside all regions becomes ocean floor at `seabed`. */
  sinkOutsideRegions(seabed: number): string {
    const { data } = this.ctx;
    const backup = new Map<string, MapChunk>();
    this.snapshot(this.fullRect(), backup);
    this.pushUndo({ chunks: backup, def: structuredClone(data.def) });

    sinkOutsideRegions(data, seabed);
    this.afterEdit(this.fullRect());
    this.refreshTopology();
    this.ctx.terrain.rebuildAll();
    this.defDirty = true;
    this.onChange?.();
    return `Everything outside ${data.def.regions.length} region(s) is now ocean (floor ${seabed}).`;
  }

  private regionsChanged(): void {
    this.defDirty = true;
    this.ctx.onRegionsChanged();
    this.onChange?.();
  }

  // --- Persistence ----------------------------------------------------------------

  async save(): Promise<string> {
    const { data } = this.ctx;
    const chunks: MapChunk[] = [];
    const removed: string[] = [];
    for (const key of this.dirty) {
      const [kx, kz] = key.split("_").map(Number) as [number, number];
      if (data.isChunkPristine(kx, kz)) removed.push(key);
      else chunks.push(data.extractChunk(kx, kz));
    }
    const authored = new Set(data.def.chunks);
    for (const k of removed) authored.delete(k);
    for (const c of chunks) authored.add(chunkKey(c.kx, c.kz));
    const def = { ...data.def, chunks: [...authored].sort() };
    // Only send removals for files that actually exist.
    const existing = new Set(data.def.chunks);
    const body: SaveMapRequest = { map: def, chunks, removed: removed.filter((k) => existing.has(k)) };

    const res = await fetch("/__dev/save-map", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`save failed: HTTP ${res.status} ${await res.text()}`);

    data.def.chunks = def.chunks;
    this.dirty.clear();
    this.defDirty = false;
    this.onChange?.();
    return `Saved ${data.def.id}: ${chunks.length} chunk(s) written, ${body.removed.length} removed.`;
  }
}
