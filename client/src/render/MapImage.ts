import * as THREE from "three";
import { valueNoise2, type CellRect, type MapData, type WalkGrid } from "@levi/shared";
import { cellColor, WATER_COLOR } from "./terrainPalette.js";

const SKY = new THREE.Color(0xc9dbe6);

/**
 * 1px-per-cell top-down image of the map with hillshading. Shared by the
 * minimap and the world map; the sculptor redraws only edited regions.
 */
export class MapImage {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  constructor(
    private readonly data: MapData,
    private readonly walk: WalkGrid,
  ) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = data.def.cols;
    this.canvas.height = data.def.rows;
    const ctx = this.canvas.getContext("2d", { willReadFrequently: false });
    if (!ctx) throw new Error("2D canvas unavailable");
    this.ctx = ctx;
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

    const img = this.ctx.createImageData(w, h);
    const col = new THREE.Color();
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const avg = (hm.vertex(cx, cz) + hm.vertex(cx + 1, cz + 1)) / 2;
        if (this.data.holes[cz * def.cols + cx] === 1) {
          // Void: pale sky, so floating islands read as floating on the map.
          col.copy(SKY).offsetHSL(0, 0, (valueNoise2(cx * 0.08, cz * 0.08, 5) - 0.5) * 0.05);
        } else if (avg <= def.waterLevel + 0.15) {
          col.copy(WATER_COLOR).offsetHSL(0, 0, -Math.min(1, (def.waterLevel - avg + 0.15) / 4) * 0.12);
        } else {
          cellColor(this.data, this.walk, cx, cz, col);
          // NW-lit hillshade so relief reads from above.
          const dx = hm.vertex(cx + 1, cz) - hm.vertex(cx - 1, cz);
          const dz = hm.vertex(cx, cz + 1) - hm.vertex(cx, cz - 1);
          col.offsetHSL(0, 0, Math.max(-0.18, Math.min(0.18, (-dx - dz) * 0.045)));
        }
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
}
