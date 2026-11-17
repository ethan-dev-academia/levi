import * as THREE from "three";
import { cellKey, valueNoise2, type CellRect, type MapData, type WalkGrid, type WallMaterial } from "@levi/shared";
import { cellColor, WATER_COLOR } from "./terrainPalette.js";
import type { TerrainTopology } from "./TerrainTopology.js";

const CLOUD = new THREE.Color(0xf4f7fa);
const CLOUD_SHADE = new THREE.Color(0xb9c6d3);
/** Cells beyond this distance from floating land never get clouds. */
const CLOUD_MAX = 52;
const DIAG = Math.SQRT2;
const ROOF_MAP_COLOR: Record<WallMaterial, string> = { wood: "#6b4a32", brick: "#8e3f2b", stone: "#566070", plaster: "#9a7b45" };

/**
 * 1px-per-cell top-down image of the map with hillshading. Shared by the
 * minimap and the world map; the sculptor redraws only edited regions.
 */
export class MapImage {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  /** Distance (cells, capped) to the nearest floating-island cell. */
  private readonly skyDist: Float32Array;

  constructor(
    private readonly data: MapData,
    private readonly walk: WalkGrid,
    private readonly topo: TerrainTopology,
  ) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = data.def.cols;
    this.canvas.height = data.def.rows;
    const ctx = this.canvas.getContext("2d", { willReadFrequently: false });
    if (!ctx) throw new Error("2D canvas unavailable");
    this.ctx = ctx;
    this.skyDist = new Float32Array(data.def.cols * data.def.rows);
    this.computeSkyDist(this.skyDist);
    this.redraw({ cx0: 0, cz0: 0, cx1: data.def.cols - 1, cz1: data.def.rows - 1 });
  }

  get worldWidth(): number {
    return this.data.hm.width;
  }

  get worldDepth(): number {
    return this.data.hm.depth;
  }

  redraw(r: CellRect): void {
    const { hm, def } = this.data;
    const cx0 = Math.max(0, r.cx0);
    const cz0 = Math.max(0, r.cz0);
    const cx1 = Math.min(def.cols - 1, r.cx1);
    const cz1 = Math.min(def.rows - 1, r.cz1);
    const w = cx1 - cx0 + 1;
    const h = cz1 - cz0 + 1;
    if (w <= 0 || h <= 0) return;

    // Buildings show as their roof seen from above.
    const roofs = new Map<number, string>();
    for (const info of this.data.buildings.all()) {
      const b = info.bounds;
      if (b.cx1 < cx0 || b.cz1 < cz0 || b.cx0 > cx1 || b.cz0 > cz1) continue;
      const color = info.def.roof.color ?? ROOF_MAP_COLOR[info.def.material];
      for (const s of info.def.storeys) for (const [x, z] of s.tiles) roofs.set(cellKey(x, z), color);
    }
    const img = this.ctx.createImageData(w, h);
    const col = new THREE.Color();
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const ci = cz * def.cols + cx;
        // Void looks straight down at the open sea, so it shares the sea's colour.
        const avg = this.data.holes[ci] === 1 ? Math.min(def.baseHeight, def.waterLevel) : (hm.vertex(cx, cz) + hm.vertex(cx + 1, cz + 1)) / 2;
        if (avg <= def.waterLevel + 0.15) {
          col.copy(WATER_COLOR).offsetHSL(0, 0, -Math.min(1, (def.waterLevel - avg + 0.15) / 4) * 0.12);
        } else {
          cellColor(this.data, this.walk, cx, cz, col);
          // NW-lit hillshade so relief reads from above.
          const dx = hm.vertex(cx + 1, cz) - hm.vertex(cx - 1, cz);
          const dz = hm.vertex(cx, cz + 1) - hm.vertex(cx, cz - 1);
          col.offsetHSL(0, 0, Math.max(-0.18, Math.min(0.18, (-dx - dz) * 0.045)));
        }
        if (roofs.has(cellKey(cx, cz))) col.set(roofs.get(cellKey(cx, cz))!).offsetHSL(0, 0, ((cx + cz) % 2) * 0.03);
        if (this.topo.floating[ci] !== 1) this.applyCloud(cx, cz, this.skyDist[ci]!, col);
        col.convertLinearToSRGB();
        const i = ((cz - cz0) * w + (cx - cx0)) * 4;
        img.data[i] = col.r * 255;
        img.data[i + 1] = col.g * 255;
        img.data[i + 2] = col.b * 255;
        img.data[i + 3] = 255;
      }
    }
    this.ctx.putImageData(img, cx0, cz0);
  }

  /**
   * Re-derive the cloud ring after floating land changed; redraws only the
   * area whose clouds moved.
   */
  refreshClouds(): void {
    const next = new Float32Array(this.skyDist.length);
    this.computeSkyDist(next);
    const { cols, rows } = this.data.def;
    let cx0 = cols, cz0 = rows, cx1 = -1, cz1 = -1;
    for (let i = 0; i < next.length; i++) {
      if (next[i] === this.skyDist[i]) continue;
      const x = i % cols, z = (i - x) / cols;
      if (x < cx0) cx0 = x;
      if (x > cx1) cx1 = x;
      if (z < cz0) cz0 = z;
      if (z > cz1) cz1 = z;
    }
    this.skyDist.set(next);
    if (cx1 >= 0) this.redraw({ cx0, cz0, cx1, cz1 });
  }

  /** Puffy, roughly round cloud bank hugging each floating island's coast. */
  private applyCloud(cx: number, cz: number, d: number, col: THREE.Color): void {
    if (d >= CLOUD_MAX) return;
    // Wobbly radius gives an organic, rounded outline instead of the region box.
    const reach = 30 + (valueNoise2(cx * 0.02, cz * 0.02, 71) - 0.5) * 18;
    const puff = (valueNoise2(cx * 0.09, cz * 0.09, 72) - 0.5) * 10;
    const edge = d + puff;
    if (edge >= reach) return;
    const a = Math.min(1, (reach - edge) / 6);
    // Light from the NW: darker undersides on the far side of each puff.
    const shade = valueNoise2(cx * 0.09 + 0.3, cz * 0.09 + 0.3, 72) - valueNoise2(cx * 0.09, cz * 0.09, 72);
    const c = CLOUD.clone().lerp(CLOUD_SHADE, Math.max(0, Math.min(1, 0.25 + shade * 2.2)));
    col.lerp(c, a * 0.92);
  }

  /** Two-pass chamfer distance from floating cells, capped at CLOUD_MAX. */
  private computeSkyDist(out: Float32Array): void {
    const { cols, rows } = this.data.def;
    const f = this.topo.floating;
    for (let i = 0; i < out.length; i++) out[i] = f[i] === 1 ? 0 : CLOUD_MAX;
    const relax = (i: number, j: number, w: number): void => {
      const v = out[j]! + w;
      if (v < out[i]!) out[i] = v;
    };
    for (let z = 0; z < rows; z++) {
      for (let x = 0; x < cols; x++) {
        const i = z * cols + x;
        if (x > 0) relax(i, i - 1, 1);
        if (z > 0) {
          relax(i, i - cols, 1);
          if (x > 0) relax(i, i - cols - 1, DIAG);
          if (x < cols - 1) relax(i, i - cols + 1, DIAG);
        }
      }
    }
    for (let z = rows - 1; z >= 0; z--) {
      for (let x = cols - 1; x >= 0; x--) {
        const i = z * cols + x;
        if (x < cols - 1) relax(i, i + 1, 1);
        if (z < rows - 1) {
          relax(i, i + cols, 1);
          if (x < cols - 1) relax(i, i + cols + 1, DIAG);
          if (x > 0) relax(i, i + cols - 1, DIAG);
        }
      }
    }
    for (let i = 0; i < out.length; i++) out[i] = Math.min(CLOUD_MAX, Math.round(out[i]! * 100) / 100);
  }
}
