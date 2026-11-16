import * as THREE from "three";
import { TERRAIN_MATERIALS, valueNoise2, type MapData, type WalkGrid } from "@levi/shared";

const MATERIAL_COLORS = TERRAIN_MATERIALS.map((m) => new THREE.Color(m.color));
const SAND = new THREE.Color(0xcdb87f);
const GRASS = new THREE.Color(0x67983f);
const GRASS_ALT = new THREE.Color(0x5e9039);
const ROCK = new THREE.Color(0x7d746a);
const BLOCKED_TINT = new THREE.Color(0xd23a2a);
export const WATER_COLOR = new THREE.Color(0x3f7391);

export interface PaletteOptions {
  /** Tint unwalkable cells red (sculptor collision view). */
  showCollision: boolean;
}

/**
 * Base colour of a terrain cell. Single source of truth for the 3D mesh,
 * minimap and world map. Painted material wins; otherwise "auto" picks
 * sand / rock / grass from height and slope.
 */
export function cellColor(data: MapData, walk: WalkGrid, cx: number, cz: number, out: THREE.Color, opts?: PaletteOptions): THREE.Color {
  const { hm, def } = data;
  const mat = data.paint[cz * def.cols + cx] ?? 0;

  if (mat > 0 && mat < MATERIAL_COLORS.length) {
    out.copy(MATERIAL_COLORS[mat]!);
  } else {
    const a = hm.vertex(cx, cz);
    const b = hm.vertex(cx + 1, cz);
    const c = hm.vertex(cx, cz + 1);
    const d = hm.vertex(cx + 1, cz + 1);
    const avg = (a + b + c + d) / 4;
    const slope = Math.max(a, b, c, d) - Math.min(a, b, c, d);
    if (avg - def.waterLevel < 0.6) out.copy(SAND);
    else if (slope > def.maxStep) out.copy(ROCK);
    else out.copy(GRASS).lerp(GRASS_ALT, valueNoise2(cx * 0.06, cz * 0.06, 99));
  }

  if (opts?.showCollision && !walk.isWalkable(cx, cz)) out.lerp(BLOCKED_TINT, 0.55);
  return out;
}
