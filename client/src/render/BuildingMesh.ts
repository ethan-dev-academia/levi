import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  DIR_VEC,
  getTerrainHeight,
  stairCells,
  storeyY,
  type BuildingInfo,
  type Heightmap,
  type Stair,
  type Wall,
  type WallMaterial,
} from "@levi/shared";

/** Wall thickness, post size. Walls are centred on their cell edge. */
const T = 0.16;
const POST = 0.24;
const SLAB = 0.18;
const OVERHANG = 0.35;
const DOOR_H = 2.05;
const SILL_H = 0.95;
const WINDOW_TOP = 1.75;

const WALL_COLOR: Record<WallMaterial, string> = { wood: "#9a6a42", brick: "#a3533b", stone: "#c4baa6", plaster: "#ddd2bb" };
const TRIM_COLOR: Record<WallMaterial, string> = { wood: "#5b3a22", brick: "#7d3b29", stone: "#978e7e", plaster: "#5b3a22" };
const ROOF_COLOR: Record<WallMaterial, string> = { wood: "#6b4a32", brick: "#8e3f2b", stone: "#4d5b70", plaster: "#9a7b45" };
const FLOOR_COLOR = "#8b6743";
const FOUNDATION_COLOR = "#8d877c";
const STAIR_COLOR = "#6e4a2c";

/** Key of the shared vertex-coloured material most pieces merge into. */
export const VERTEX = "vertex";
/** Colours that need their own material (shine, night glow); everything else is vertex-coloured. */
const OWN_MATERIAL = new Set<string>();

/** Box faces, as bits: +x, -x, +y, -y, +z, -z (BoxGeometry's group order). */
const FACE = { px: 1, nx: 2, py: 4, ny: 8, pz: 16, nz: 32 } as const;

/**
 * Geometry gathered per colour, then merged into as few meshes as possible:
 * one vertex-coloured mesh, plus one per special material. Position + colour
 * only (normals come from flat shading).
 */
class Batch {
  private readonly parts = new Map<string, THREE.BufferGeometry[]>();

  add(color: string, g: THREE.BufferGeometry): void {
    for (const name of Object.keys(g.attributes)) if (name !== "position") g.deleteAttribute(name);
    let list = this.parts.get(color);
    if (!list) this.parts.set(color, (list = []));
    list.push(g);
  }

  /** An axis-aligned box; `drop` leaves out faces that can never be seen (FACE bits). */
  box(color: string, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, drop = 0): void {
    if (x1 - x0 <= 1e-4 || y1 - y0 <= 1e-4 || z1 - z0 <= 1e-4) return;
    const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
    g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    if (drop) {
      const idx = g.index!.array;
      const keep: number[] = [];
      for (let f = 0; f < 6; f++) if (!(drop & (1 << f))) for (let i = f * 6; i < f * 6 + 6; i++) keep.push(idx[i]!);
      g.setIndex(keep);
    }
    this.add(color, g);
  }

  /** Triangles from a flat [x,y,z,...] list (3 vertices each). */
  tris(color: string, pts: number[]): void {
    // Drop zero-area triangles (tapering roof ends): their flat-shaded normal is NaN.
    const keep: number[] = [];
    for (let i = 0; i + 8 < pts.length; i += 9) {
      const ux = pts[i + 3]! - pts[i]!, uy = pts[i + 4]! - pts[i + 1]!, uz = pts[i + 5]! - pts[i + 2]!;
      const vx = pts[i + 6]! - pts[i]!, vy = pts[i + 7]! - pts[i + 1]!, vz = pts[i + 8]! - pts[i + 2]!;
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      if (cx * cx + cy * cy + cz * cz > 1e-10) for (let k = 0; k < 9; k++) keep.push(pts[i + k]!);
    }
    if (keep.length === 0) return;
    pts = keep;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    g.setIndex([...Array(pts.length / 3).keys()]);
    this.add(color, g);
  }

  build(target: THREE.Object3D, material: (color: string) => THREE.Material): void {
    const shared: THREE.BufferGeometry[] = [];
    const c = new THREE.Color();
    for (const [color, list] of this.parts) {
      const merged = mergeGeometries(list);
      for (const g of list) g.dispose();
      if (!merged) continue;
      if (OWN_MATERIAL.has(color)) {
        target.add(new THREE.Mesh(merged, material(color)));
        continue;
      }
      c.set(color);
      const n = merged.attributes.position!.count;
      const col = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
      merged.setAttribute("color", new THREE.BufferAttribute(col, 3));
      shared.push(merged);
    }
    if (shared.length) {
      const all = mergeGeometries(shared);
      for (const g of shared) g.dispose();
      if (all) target.add(new THREE.Mesh(all, material(VERTEX)));
    }
    this.parts.clear();
  }
}

/** Per-scene cache of opaque flat-shaded materials, keyed by colour. */
export class MaterialCache {
  private readonly mats = new Map<string, THREE.Material>();

  get = (color: string): THREE.Material => {
    let m = this.mats.get(color);
    if (!m) {
      if (color === VERTEX) m = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
      else if (color === BRASS) m = new THREE.MeshPhongMaterial({ color, flatShading: true, shininess: 60, specular: 0x6b5230 });
      else if (color === GLASS_LIT) {
        const g = new THREE.MeshLambertMaterial({ color, flatShading: true, emissive: 0xffa04a, emissiveIntensity: 0 });
        glowMats.add(g);
        m = g;
      } else m = new THREE.MeshLambertMaterial({ color, flatShading: true });
      this.mats.set(color, m);
    }
    return m;
  };

  dispose(): void {
    for (const m of this.mats.values()) {
      glowMats.delete(m as THREE.MeshLambertMaterial);
      m.dispose();
    }
  }
}

export interface StairPick {
  building: string;
  stair: string;
  /** Storey this flight starts on. */
  flight: number;
}

export interface BuildingView {
  readonly group: THREE.Group;
  /** Storey k: its floor, walls, and flights starting on it. */
  readonly storeys: THREE.Group[];
  readonly roof: THREE.Group;
  /** Roof-only materials (per building, so each can fade on its own). */
  readonly roofMaterials: THREE.MeshLambertMaterial[];
  readonly stairMeshes: THREE.Mesh[];
  /** Wall lines per storey, for cutaways. */
  readonly wallLines: WallLine[][];
  /** Highest storey with a floor or walls (the roof sits on it). */
  readonly topStorey: number;
  dispose(): void;
}

/** Brass trim (gutters, mullions, ridge caps) and window glass. */
export const BRASS = "#c4954a";
const GLASS_LIT = "#232c35";
const GLASS_DARK = "#1d242b";
/** Painted shutters, picked per building. */
const SHUTTERS = ["#2f5d62", "#6b2f2a", "#2e3f5c", "#3f5a36"];

/** Every lit window shares these, so night can switch them on together. */
const glowMats = new Set<THREE.MeshLambertMaterial>();
OWN_MATERIAL.add(BRASS);
OWN_MATERIAL.add(GLASS_LIT);
/** 0 = day, 1 = night: windows glow warm. */
export function setWindowGlow(n: number): void {
  for (const m of glowMats) m.emissiveIntensity = n * 1.5;
}

const shadeCache = new Map<string, string>();
/** Deterministic light/dark variant of a colour for seed `n` (one of three). */
function shadeOf(base: string, n: number, amount: number): string {
  const v = (((n * 2654435761) >>> 0) % 3) - 1; // -1, 0, 1
  const key = `${base}${v}${amount}`;
  let out = shadeCache.get(key);
  if (!out) shadeCache.set(key, (out = `#${new THREE.Color(base).multiplyScalar(1 + v * amount * 1.8).getHexString()}`));
  return out;
}

/** Deterministic 0..1 hash of a few integers. */
function hash(a: number, b: number, c = 0): number {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(c | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * How each material is sculpted: course height, block length (0 = boards
 * running the whole line), joint gap, relief out of the wall, shade spread.
 */
const SCULPT: Record<WallMaterial, { course: number; block: number; gap: number; relief: number; shade: number }> = {
  stone: { course: 0.42, block: 0.62, gap: 0.03, relief: 0.05, shade: 0.06 },
  brick: { course: 0.2, block: 0.44, gap: 0.022, relief: 0.022, shade: 0.06 },
  wood: { course: 0.3, block: 0, gap: 0.022, relief: 0.03, shade: 0.05 },
  plaster: { course: 0, block: 0, gap: 0, relief: 0.03, shade: 0 },
};

/** Which side of a wall faces out: +1 / -1 along the wall's normal axis, 0 = both (or unknown). */
type Side = -1 | 0 | 1;

interface WallCtx {
  /** Outer side of this wall. */
  out: Side;
  /** Storey index (0 gets a plinth, upper storeys a string course). */
  k: number;
  /** Top storey: gets a cornice. */
  top: boolean;
  /** Neighbouring segment kinds along the line (for shutters). */
  prev: Wall["kind"] | null;
  next: Wall["kind"] | null;
  shutter: string;
}

/**
 * One wall segment (a cell edge), sculpted: a mortar core with blocks,
 * bricks or boards standing proud of it on the outer face, plinth, string
 * courses and a cornice, and openings with dressed jambs, sills, lintels,
 * brass mullions, glass and painted shutters. Clipped at `y0 + h` for cutaways.
 */
function wallPieces(b: Batch, w: Wall, mat: WallMaterial, y0: number, storeyH: number, h: number, ctx: WallCtx): void {
  const m = w.material ?? mat;
  const wall = WALL_COLOR[m];
  const trim = TRIM_COLOR[m];
  const sc = SCULPT[m];
  const mortar = darker(wall, m === "wood" ? 0.14 : 0.1);
  const light = lighter(wall, 0.06);
  const yMax = y0 + h;
  const y1 = y0 + storeyH;
  const base = w.axis === "x" ? w.x : w.z; // line coordinate of a = 0
  const lineSeed = Math.round((w.axis === "x" ? w.z : w.x) * 7) + (w.axis === "x" ? 0 : 99991);
  const sides: Side[] = ctx.out === 0 ? [-1, 1] : [ctx.out];

  /** Box along a0..a1 (0..1 of the edge), ya..yb, across n0..n1 (offset from the wall line along its normal). */
  /** `back`: +1/-1 drops the face on that side of the normal axis (buried in the wall), plus the underside. */
  const piece = (color: string, a0: number, a1: number, ya: number, yb: number, n0: number, n1: number, back: Side = 0): void => {
    const top = Math.min(yb, yMax);
    if (top - ya <= 1e-3) return;
    const drop = back === 0 ? 0 : FACE.ny | (w.axis === "x" ? (back > 0 ? FACE.pz : FACE.nz) : back > 0 ? FACE.px : FACE.nx);
    if (w.axis === "x") b.box(color, w.x + a0, ya, w.z + n0, w.x + a1, top, w.z + n1, drop);
    else b.box(color, w.x + n0, ya, w.z + a0, w.x + n1, top, w.z + a1, drop);
  };
  /** A slab standing proud of the outer face(s) by `r`. */
  const proud = (color: string, a0: number, a1: number, ya: number, yb: number, r: number): void => {
    for (const s of sides) {
      if (s > 0) piece(color, a0, a1, ya, yb, T / 2 - 0.01, T / 2 + r, -1);
      else piece(color, a0, a1, ya, yb, -T / 2 - r, -T / 2 + 0.01, 1);
    }
  };

  /** Wall body between a0..a1 and ya..yb. */
  const body = (a0: number, a1: number, ya: number, yb: number): void => {
    if (yb - ya <= 1e-3 || a1 - a0 <= 1e-3) return;
    // The core: mortar behind blocks, or the plaster itself.
    piece(m === "plaster" ? wall : mortar, a0, a1, ya, yb, -T / 2, T / 2);
    if (m === "plaster") {
      proud(wall, a0, a1, ya, yb, sc.relief);
      return;
    }
    const first = Math.floor((ya - y0) / sc.course + 1e-6);
    for (let n = first; y0 + n * sc.course < yb - 1e-4; n++) {
      const lo = y0 + n * sc.course, hi = y0 + (n + 1) * sc.course;
      const c0 = Math.max(ya, lo) + (lo >= ya - 1e-6 ? sc.gap / 2 : 0);
      const c1 = Math.min(yb, hi) - (hi <= yb + 1e-6 ? sc.gap / 2 : 0);
      if (c1 - c0 < 0.02) continue;
      const row = n + Math.round(y0 * 10);
      if (sc.block === 0) {
        // Boards: one per course along the segment.
        const s = hash(row, lineSeed);
        proud(shadeOf(wall, Math.floor(s * 3), sc.shade), a0, a1, c0, c1, sc.relief * (0.5 + s * 0.7));
        continue;
      }
      // Blocks on a staggered running bond, continuous along the whole line.
      const L = sc.block;
      const off = (row % 2) * L * 0.5;
      const from = base + a0, to = base + a1;
      for (let k = Math.floor((from - off) / L) - 1; ; k++) {
        const jl = (hash(row, k, lineSeed) - 0.5) * L * 0.3;
        const jr = (hash(row, k + 1, lineSeed) - 0.5) * L * 0.3;
        const bx0 = off + k * L + jl + sc.gap / 2;
        const bx1 = off + (k + 1) * L + jr - sc.gap / 2;
        if (bx0 >= to) break;
        const s0 = Math.max(from, bx0), s1 = Math.min(to, bx1);
        if (s1 - s0 < 0.04) continue;
        const hs = hash(row, k, lineSeed + 3);
        proud(shadeOf(wall, Math.floor(hs * 3) + row, sc.shade), s0 - base, s1 - base, c0, c1, sc.relief * (0.45 + hs * 0.75));
      }
    }
  };

  // Plinth, string course and cornice run along every segment (doors break the plinth).
  const bands = (): void => {
    if (ctx.k === 0 && w.kind !== "door") proud(darker(wall, 0.1), 0, 1, y0 - 0.05, y0 + 0.45, sc.relief + 0.08);
    if (ctx.k > 0 && m !== "wood") proud(light, 0, 1, y0, y0 + 0.16, sc.relief + 0.07);
    if (ctx.k > 0 && m === "wood") proud(trim, 0, 1, y0, y0 + 0.14, sc.relief + 0.04);
    if (ctx.top) {
      const c = m === "wood" ? trim : light;
      proud(c, -0.02, 1.02, y1 - 0.24, y1, sc.relief + 0.15);
      if (m === "stone" || m === "brick") for (const a of [0.25, 0.75]) proud(c, a - 0.07, a + 0.07, y1 - 0.46, y1 - 0.24, sc.relief + 0.11);
    }
    if (m === "plaster") {
      // Half-timbering: sole and head beams, studs at every other cell edge.
      proud(trim, 0, 1, y0, y0 + 0.16, sc.relief + 0.03);
      proud(trim, 0, 1, y1 - 0.16, y1, sc.relief + 0.03);
      if (Math.round(base) % 2 === 0 && w.kind === "wall") proud(trim, -0.06, 0.06, y0, y1, sc.relief + 0.03);
    }
  };

  if (w.kind === "wall") {
    body(0, 1, y0, y1);
    bands();
    return;
  }

  // Openings: dressed jambs, then the wall around the hole.
  const jamb = m === "wood" || m === "plaster" ? trim : light;
  const jr = sc.relief + 0.05;
  piece(mortar, 0, 0.1, y0, y1, -T / 2, T / 2);
  piece(mortar, 0.9, 1, y0, y1, -T / 2, T / 2);
  const top = w.kind === "door" ? DOOR_H : WINDOW_TOP;
  const bottom = w.kind === "door" ? 0 : SILL_H;
  for (let yy = y0 + bottom, n = 0; yy < y0 + top - 0.05; yy += 0.42, n++) {
    const ye = Math.min(y0 + top, yy + 0.42) - 0.02;
    const wide = n % 2 === 0 ? 0.16 : 0.1;
    proud(jamb, 0.1 - wide + 0.06, 0.12, yy + 0.02, ye, jr);
    proud(jamb, 0.88, 0.9 + wide - 0.06, yy + 0.02, ye, jr);
  }
  if (w.kind === "window") {
    body(0, 0.1, y0, y0 + SILL_H - 0.1);
    body(0.9, 1, y0, y0 + SILL_H - 0.1);
  }
  body(0, 0.1, y0 + top + 0.26, y1);
  body(0.9, 1, y0 + top + 0.26, y1);
  // Lintel (with a keystone) above the opening.
  piece(mortar, 0.1, 0.9, y0 + top, y0 + top + 0.26, -T / 2, T / 2);
  proud(jamb, 0.02, 0.98, y0 + top, y0 + top + 0.26, jr + 0.02);
  proud(lighter(jamb, 0.04), 0.42, 0.58, y0 + top - 0.06, y0 + top + 0.34, jr + 0.07);
  body(0.1, 0.9, y0 + top + 0.26, y1);
  if (w.kind === "door") {
    // A worn step and a brass threshold.
    proud(darker(wall, 0.12), 0.06, 0.94, y0 - 0.05, y0 + 0.06, 0.22);
    piece(BRASS, 0.1, 0.9, y0, y0 + 0.03, -T / 2, T / 2);
    bands();
    return;
  }
  body(0.1, 0.9, y0, y0 + SILL_H - 0.1);
  // Sill with a drip edge.
  proud(jamb, 0.02, 0.98, y0 + SILL_H - 0.1, y0 + SILL_H, jr + 0.1);
  // Glass set back in the opening, with a brass cross.
  const lit = hash(Math.round(base * 3), lineSeed, Math.round(y0)) < 0.68;
  piece(lit ? GLASS_LIT : GLASS_DARK, 0.1, 0.9, y0 + SILL_H, y0 + top, -0.025, 0.025);
  piece(BRASS, 0.47, 0.53, y0 + SILL_H, y0 + top, -0.05, 0.05);
  const bar = y0 + SILL_H + (top - SILL_H) * 0.6;
  piece(BRASS, 0.1, 0.9, bar - 0.03, bar + 0.03, -0.05, 0.05);
  // Open shutters on the outside, where the wall either side is plain.
  if (ctx.out !== 0 && ctx.prev === "wall" && ctx.next === "wall") {
    const r0 = sc.relief + 0.02, r1 = sc.relief + 0.07;
    const n0 = ctx.out > 0 ? T / 2 + r0 : -T / 2 - r1;
    const n1 = ctx.out > 0 ? T / 2 + r1 : -T / 2 - r0;
    piece(ctx.shutter, -0.3, -0.04, y0 + SILL_H + 0.02, y0 + top - 0.02, n0, n1);
    piece(ctx.shutter, 1.04, 1.3, y0 + SILL_H + 0.02, y0 + top - 0.02, n0, n1);
  }
  bands();
}

/** A straight line of walls (same axis + coordinate) that can be cut away as one. */
export interface WallLine {
  axis: "x" | "z";
  /** z for axis "x" lines, x for axis "z" lines. */
  coord: number;
  full: THREE.Group;
  cut: THREE.Group;
}

const lineKey = (axis: "x" | "z", coord: number): string => `${axis}${coord}`;
const lineOf = (w: Wall): string => lineKey(w.axis, w.axis === "x" ? w.z : w.x);

/** Corner / end posts (not mid-run), each listed with the wall lines it touches. */
function postSpots(walls: readonly Wall[]): Array<{ x: number; z: number; lines: string[] }> {
  const at = new Map<string, { dirs: Set<string>; lines: Set<string> }>();
  const touch = (x: number, z: number, d: string, line: string): void => {
    const k = `${x},${z}`;
    let e = at.get(k);
    if (!e) at.set(k, (e = { dirs: new Set(), lines: new Set() }));
    e.dirs.add(d);
    e.lines.add(line);
  };
  for (const w of walls) {
    const line = lineOf(w);
    if (w.axis === "x") { touch(w.x, w.z, "e", line); touch(w.x + 1, w.z, "w", line); }
    else { touch(w.x, w.z, "s", line); touch(w.x, w.z + 1, "n", line); }
  }
  const out: Array<{ x: number; z: number; lines: string[] }> = [];
  for (const [k, e] of at) {
    const s = e.dirs;
    if (s.size === 2 && ((s.has("e") && s.has("w")) || (s.has("n") && s.has("s")))) continue;
    const [x, z] = k.split(",").map(Number) as [number, number];
    out.push({ x, z, lines: [...e.lines] });
  }
  return out;
}

/** Height walls are cut down to when they'd hide the player. */
export const CUTAWAY_HEIGHT = 0.8;

/** Corner quoins (stone/brick: big alternating blocks) or a timber post. */
function cornerPost(b: Batch, mat: WallMaterial, x: number, z: number, y0: number, top: number): void {
  if (mat === "wood" || mat === "plaster") {
    b.box(TRIM_COLOR[mat], x - POST / 2, y0, z - POST / 2, x + POST / 2, top, z + POST / 2);
    return;
  }
  const q = lighter(WALL_COLOR[mat], 0.07);
  const r = SCULPT[mat].relief + 0.06;
  b.box(darker(WALL_COLOR[mat], 0.1), x - T / 2 - 0.01, y0, z - T / 2 - 0.01, x + T / 2 + 0.01, top, z + T / 2 + 0.01);
  for (let y = y0, n = 0; y < top - 1e-3; y += 0.42, n++) {
    const ye = Math.min(top, y + 0.42);
    const long = 0.32, short = 0.17;
    const [hx, hz] = n % 2 === 0 ? [long, short] : [short, long];
    b.box(shadeOf(q, n + Math.round(x * 3 + z), 0.03), x - hx - r * 0.3, y + 0.015, z - hz - r * 0.3, x + hx + r * 0.3, ye - 0.015, z + hz + r * 0.3);
  }
}

/** Build every wall line of a storey, each in full and cutaway form. */
function wallLines(
  walls: readonly Wall[],
  mat: WallMaterial,
  y0: number,
  storeyH: number,
  mats: MaterialCache,
  inside: (x: number, z: number) => boolean,
  k: number,
  top: boolean,
  shutter: string,
): WallLine[] {
  const lines = new Map<string, { axis: "x" | "z"; coord: number; full: Batch; cut: Batch }>();
  const lineFor = (key: string, axis: "x" | "z", coord: number) => {
    let l = lines.get(key);
    if (!l) lines.set(key, (l = { axis, coord, full: new Batch(), cut: new Batch() }));
    return l;
  };
  const kindAt = new Map<string, Wall["kind"]>();
  for (const w of walls) kindAt.set(`${w.axis}${w.x},${w.z}`, w.kind);
  for (const w of walls) {
    const l = lineFor(lineOf(w), w.axis, w.axis === "x" ? w.z : w.x);
    // Outside is the side without floor.
    const [ax, az, bx, bz] = w.axis === "x" ? [w.x, w.z - 1, w.x, w.z] : [w.x - 1, w.z, w.x, w.z];
    const inA = inside(ax, az), inB = inside(bx, bz);
    const out: Side = inA && !inB ? 1 : inB && !inA ? -1 : 0;
    const prev = kindAt.get(w.axis === "x" ? `x${w.x - 1},${w.z}` : `z${w.x},${w.z - 1}`) ?? null;
    const next = kindAt.get(w.axis === "x" ? `x${w.x + 1},${w.z}` : `z${w.x},${w.z + 1}`) ?? null;
    const ctx: WallCtx = { out, k, top, prev, next, shutter };
    wallPieces(l.full, w, mat, y0, storeyH, storeyH, ctx);
    wallPieces(l.cut, w, mat, y0, storeyH, CUTAWAY_HEIGHT, ctx);
  }
  for (const p of postSpots(walls)) {
    for (const key of p.lines) {
      const l = lines.get(key)!;
      cornerPost(l.full, mat, p.x, p.z, y0, y0 + storeyH + 0.04);
      cornerPost(l.cut, mat, p.x, p.z, y0, y0 + CUTAWAY_HEIGHT + 0.04);
    }
  }
  return [...lines.values()].map((l) => {
    const full = new THREE.Group();
    const cut = new THREE.Group();
    l.full.build(full, mats.get);
    l.cut.build(cut, mats.get);
    cut.visible = false;
    return { axis: l.axis, coord: l.coord, full, cut };
  });
}

/** Local frame of a stair: u along `dir`, v across, origin at the foot cell's corner. */
function stairMatrix(s: Stair): THREE.Matrix4 {
  const [dx, dz] = DIR_VEC[s.dir];
  const U = new THREE.Vector3(dx, 0, dz);
  const V = new THREE.Vector3(-dz, 0, dx); // U × up: keeps the basis right-handed
  const origin = new THREE.Vector3(s.x + 0.5, 0, s.z + 0.5).addScaledVector(U, -0.5).addScaledVector(V, -0.5);
  return new THREE.Matrix4().makeBasis(U, new THREE.Vector3(0, 1, 0), V).setPosition(origin);
}

function flightGeometry(s: Stair, y0: number, h: number): THREE.BufferGeometry {
  const b = new Batch();
  if (s.kind === "stairs") {
    const steps = Math.max(4, Math.round(h / 0.26));
    const run = s.length / steps;
    for (let i = 0; i < steps; i++) b.box(STAIR_COLOR, i * run, y0, 0.06, s.length, y0 + (h * (i + 1)) / steps, 0.94);
  } else {
    // Ladder leaning against the far edge of its cell, poking above the floor.
    const top = h + 0.9;
    const lean = new THREE.Matrix4().makeRotationZ(0.18);
    const parts: THREE.BufferGeometry[] = [];
    const piece = (x0: number, yA: number, z0: number, x1: number, yB: number, z1: number): void => {
      const g = new THREE.BoxGeometry(x1 - x0, yB - yA, z1 - z0);
      g.translate((x0 + x1) / 2, (yA + yB) / 2, (z0 + z1) / 2);
      parts.push(g);
    };
    piece(-0.04, 0, 0.18, 0.04, top, 0.26);
    piece(-0.04, 0, 0.74, 0.04, top, 0.82);
    for (let y = 0.3; y < top - 0.1; y += 0.32) piece(-0.03, y, 0.2, 0.03, y + 0.06, 0.8);
    const g = mergeGeometries(parts.map((p) => { for (const n of Object.keys(p.attributes)) if (n !== "position") p.deleteAttribute(n); return p; }))!;
    for (const p of parts) p.dispose();
    g.applyMatrix4(lean);
    g.translate(0.62, y0, 0);
    b.add(STAIR_COLOR, g);
  }
  const holder = new THREE.Group();
  b.build(holder, () => new THREE.MeshBasicMaterial());
  const mesh = holder.children[0] as THREE.Mesh;
  const geom = mesh.geometry;
  (mesh.material as THREE.Material).dispose();
  geom.applyMatrix4(stairMatrix(s));
  return geom;
}

/** Shingle course length along the slope, lip height and fascia depth. */
const COURSE_LEN = 0.36;
/** Tile width across the slope. */
const TILE_W = 0.42;
const LIP = 0.05;
const FASCIA = 0.12;

const lightCache = new Map<string, string>();
function lighter(color: string, amount: number): string {
  const key = `${color}${amount}`;
  let out = lightCache.get(key);
  if (!out) lightCache.set(key, (out = `#${new THREE.Color(color).lerp(new THREE.Color(1, 1, 1), amount * 1.6).getHexString()}`));
  return out;
}

const darkCache = new Map<string, string>();
function darker(color: string, amount: number): string {
  const key = `${color}${amount}`;
  let out = darkCache.get(key);
  if (!out) darkCache.set(key, (out = `#${new THREE.Color(color).multiplyScalar(Math.max(0.15, 1 - amount * 2.2)).getHexString()}`));
  return out;
}

type V3 = [number, number, number];
const lerp3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const add3 = (a: V3, n: V3, k: number): V3 => [a[0] + n[0] * k, a[1] + n[1] * k, a[2] + n[2] * k];

/**
 * One roof face as rows of individual tiles. A→B is the eave, D→C the top
 * edge (C = D for a triangle). Each tile is lifted at its lower edge with a
 * darker butt face; thin gaps between tiles show the dark underlay, so the
 * slope reads as laid slates even without textures.
 */
function shingledSlope(b: Batch, color: string, A: V3, B: V3, C: V3, D: V3, seed: number): void {
  const mid = lerp3(D, C, 0.5);
  const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
  const v = [mid[0] - A[0], mid[1] - A[1], mid[2] - A[2]];
  let n: V3 = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
  const len = Math.hypot(...n) || 1;
  n = [n[0] / len, n[1] / len, n[2] / len];
  if (n[1] < 0) n = [-n[0], -n[1], -n[2]];
  const slopeLen = Math.hypot(...v);
  const courses = Math.max(2, Math.round(slopeLen / COURSE_LEN));
  const butt = darker(color, 0.12);
  // Underlay: what shows through the joints.
  b.tris(darker(color, 0.25), [...A, ...B, ...C, ...A, ...C, ...D]);
  for (let i = 0; i < courses; i++) {
    const t0 = i / courses, t1 = Math.min(1, (i + 1.15) / courses);
    const L0 = lerp3(A, D, t0), R0 = lerp3(B, C, t0), L1 = lerp3(A, D, t1), R1 = lerp3(B, C, t1);
    const width = Math.hypot(R0[0] - L0[0], R0[1] - L0[1], R0[2] - L0[2]);
    if (width < 0.05) continue;
    const tiles = Math.max(1, Math.round(width / TILE_W));
    const stagger = (i % 2) * 0.5;
    const gap = Math.min(0.2, 0.035 / (width / tiles));
    for (let j = -1; j <= tiles; j++) {
      let s0 = (j + stagger) / tiles, s1 = (j + 1 + stagger) / tiles;
      s0 = Math.max(0, s0 + (j + stagger > 0 ? gap / tiles : 0));
      s1 = Math.min(1, s1 - (j + 1 + stagger < tiles ? gap / tiles : 0));
      if (s1 - s0 < 0.2 / tiles) continue;
      const h = hash(i, j + 7, seed);
      const lift = LIP * (0.8 + h * 0.5);
      const P0 = lerp3(L0, R0, s0), P1 = lerp3(L0, R0, s1), Q0 = lerp3(L1, R1, s0), Q1 = lerp3(L1, R1, s1);
      const P0u = add3(P0, n, lift), P1u = add3(P1, n, lift), Q0u = add3(Q0, n, 0.012), Q1u = add3(Q1, n, 0.012);
      b.tris(shadeOf(color, Math.floor(h * 3) + i, 0.045), [...P0u, ...P1u, ...Q1u, ...P0u, ...Q1u, ...Q0u]);
      b.tris(butt, [...P0, ...P1, ...P1u, ...P0, ...P1u, ...P0u]);
    }
  }
  // Fascia: the roof's thickness along the eave.
  const Ad: V3 = [A[0], A[1] - FASCIA, A[2]], Bd: V3 = [B[0], B[1] - FASCIA, B[2]];
  b.tris(darker(color, 0.16), [...A, ...B, ...Bd, ...A, ...Bd, ...Ad]);
}

/** Roof over the top storey's tile rectangle. */
function roof(b: Batch, info: BuildingInfo, top: number, roofColor: string, gableColor: string): void {
  const def = info.def;
  const kind = def.roof.kind;
  if (kind === "none") return;
  // Footprint: the top storey's floor, else the box its walls enclose,
  // else the floor of the storey below (walls-only upper storeys).
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  const grow = (ax: number, az: number, bx: number, bz: number): void => {
    x0 = Math.min(x0, ax); z0 = Math.min(z0, az); x1 = Math.max(x1, bx); z1 = Math.max(z1, bz);
  };
  const storey = def.storeys[top]!;
  for (const [x, z] of storey.tiles) grow(x, z, x + 1, z + 1);
  if (x0 === Infinity) for (const w of storey.walls) grow(w.x, w.z, w.axis === "x" ? w.x + 1 : w.x, w.axis === "z" ? w.z + 1 : w.z);
  if (x0 === Infinity || x1 - x0 < 1 || z1 - z0 < 1) {
    x0 = z0 = Infinity; x1 = z1 = -Infinity;
    for (let k = top; k >= 0 && x0 === Infinity; k--) for (const [x, z] of def.storeys[k]!.tiles) grow(x, z, x + 1, z + 1);
  }
  if (x0 === Infinity) return;
  const y = storeyY(def, top) + def.floorHeight;
  const O = OVERHANG;
  const p = def.roof.pitch;

  if (kind === "flat") {
    b.box(roofColor, x0 - O / 2, y, z0 - O / 2, x1 + O / 2, y + 0.18, z1 + O / 2);
    const rim = darker(roofColor, 0.12);
    const e = O / 2, t = 0.14, h2 = y + 0.36;
    b.box(rim, x0 - e, y, z0 - e, x1 + e, h2, z0 - e + t);
    b.box(rim, x0 - e, y, z1 + e - t, x1 + e, h2, z1 + e);
    b.box(rim, x0 - e, y, z0 - e, x0 - e + t, h2, z1 + e);
    b.box(rim, x1 + e - t, y, z0 - e, x1 + e, h2, z1 + e);
    return;
  }

  // Lean-to roofs fall towards the side with the fewest walls (a shed's open front).
  const walls = def.storeys[top]!.walls;
  const sideWalls = {
    z0: walls.filter((w) => w.axis === "x" && w.z === z0).length,
    z1: walls.filter((w) => w.axis === "x" && w.z === z1).length,
    x0: walls.filter((w) => w.axis === "z" && w.x === x0).length,
    x1: walls.filter((w) => w.axis === "z" && w.x === x1).length,
  };
  const open = (Object.keys(sideWalls) as Array<keyof typeof sideWalls>).reduce((m, k) => (sideWalls[k] < sideWalls[m] ? k : m), "z1");

  // Work in a frame where the ridge runs along "a" (the longer side; for a
  // lean-to, parallel to its open side).
  const alongX = kind === "shed" ? open === "z0" || open === "z1" : x1 - x0 >= z1 - z0;
  const [a0, a1, c0, c1] = alongX ? [x0, x1, z0, z1] : [z0, z1, x0, x1];
  const P = (a: number, h: number, c: number): V3 => (alongX ? [a, h, c] : [c, h, a]);
  const slope = (A: V3, B: V3, C: V3, D: V3, seed: number): void => shingledSlope(b, roofColor, A, B, C, D, seed);
  const cap = def.material === "stone" || def.material === "brick" ? BRASS : darker(roofColor, 0.2);
  /** Ridge cap along a (a from..to) at height h. */
  const ridge = (from: number, to: number, h: number, c: number): void => {
    if (to - from <= 0.01) return;
    const [ax0, , az0] = P(from, 0, c - 0.1);
    const [ax1, , az1] = P(to, 0, c + 0.1);
    b.box(cap, Math.min(ax0, ax1), h - 0.06, Math.min(az0, az1), Math.max(ax0, ax1), h + 0.1, Math.max(az0, az1));
  };
  const tri = (color: string, ...v: V3[]): void => b.tris(color, v.flat());
  const quad = (color: string, A: V3, B: V3, C: V3, D: V3): void => { tri(color, A, B, C); tri(color, A, C, D); };
  const span = c1 - c0;

  if (kind === "shed") {
    // Single slope: high at the back, falling past the open side.
    const openAtLow = open === "z0" || open === "x0";
    const cH = openAtLow ? c1 : c0;
    const cL = openAtLow ? c0 : c1;
    const sg = Math.sign(cL - cH);
    const hiY = y + p * span * 0.5;
    const loY = y - p * O;
    slope(P(a0 - O, loY, cL + sg * O), P(a1 + O, loY, cL + sg * O), P(a1 + O, hiY, cH - (sg * O) / 2), P(a0 - O, hiY, cH - (sg * O) / 2), 0);
    // Infill: high back wall strip and the two side triangles.
    quad(gableColor, P(a0, y, cH), P(a1, y, cH), P(a1, hiY, cH), P(a0, hiY, cH));
    for (const a of [a0, a1]) tri(gableColor, P(a, y, cH), P(a, y, cL), P(a, hiY, cH));
    return;
  }

  const half = span / 2;
  const rise = p * half;
  const cm = (c0 + c1) / 2;
  const top3 = y + rise;
  const eave = y - p * O;
  /** A box between two frame points (any order). */
  const boxP = (color: string, p: V3, q: V3): void =>
    b.box(color, Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.min(p[2], q[2]), Math.max(p[0], q[0]), Math.max(p[1], q[1]), Math.max(p[2], q[2]));
  const mat = def.material;
  const groundY = storeyY(def, 0);
  /** Brass gutters along both eaves, with downpipes at the corners. */
  const gutters = (from: number, to: number): void => {
    const gy = eave - FASCIA;
    for (const [c, s] of [[c0 - O, 1], [c1 + O, -1]] as const) {
      boxP(BRASS, P(from, gy - 0.12, c - 0.07), P(to, gy + 0.01, c + 0.07));
      for (const a of [a0 + 0.12, a1 - 0.12]) {
        const wc = s > 0 ? c0 - T / 2 - 0.07 : c1 + T / 2 + 0.07;
        boxP(BRASS, P(a - 0.05, groundY + 0.1, wc - 0.05), P(a + 0.05, gy - 0.05, wc + 0.05));
        boxP(BRASS, P(a - 0.05, gy - 0.12, Math.min(c, wc) - 0.03), P(a + 0.05, gy - 0.04, Math.max(c, wc) + 0.03));
      }
    }
  };
  if (kind === "gable") {
    slope(P(a0 - O, eave, c0 - O), P(a1 + O, eave, c0 - O), P(a1 + O, top3, cm), P(a0 - O, top3, cm), 0);
    slope(P(a1 + O, eave, c1 + O), P(a0 - O, eave, c1 + O), P(a0 - O, top3, cm), P(a1 + O, top3, cm), 7);
    const sc = SCULPT[mat];
    for (const [a, s] of [[a0, -1], [a1, 1]] as const) {
      tri(sc.course > 0 ? darker(gableColor, 0.1) : gableColor, P(a, y, c0), P(a, y, c1), P(a, top3, cm));
      if (sc.course === 0) continue;
      // Courses of the gable wall, stepping in under the slopes.
      for (let yy = y, row = 0; yy < top3 - 0.08; yy += sc.course, row++) {
        const ye = Math.min(top3, yy + sc.course) - sc.gap / 2;
        const wHalf = half * (1 - (Math.min(top3, yy + sc.course) - y) / rise) - 0.04;
        if (wHalf < 0.08) break;
        const L = sc.block || 99;
        const off = (row % 2) * L * 0.5;
        for (let k = Math.floor((cm - wHalf - off) / L) - 1; ; k++) {
          const bc0 = Math.max(cm - wHalf, off + k * L + sc.gap / 2);
          const bc1 = Math.min(cm + wHalf, off + (k + 1) * L - sc.gap / 2);
          if (off + k * L > cm + wHalf) break;
          if (bc1 - bc0 < 0.05) continue;
          const h = hash(row, k, Math.round(a * 7));
          const r = sc.relief * (0.45 + h * 0.75);
          boxP(shadeOf(gableColor, Math.floor(h * 3) + row, sc.shade), P(a + s * (T / 2 - 0.01), yy + sc.gap / 2, bc0), P(a + s * (T / 2 + r), ye, bc1));
        }
      }
    }
    ridge(a0 - O, a1 + O, top3, cm);
    gutters(a0 - O, a1 + O);
    // A chimney on homes (not on halls and towers).
    if (span <= 12 && a1 - a0 <= 22 && def.storeys.length <= 3) {
      const ca = Math.round(a0 + (a1 - a0) * 0.72) + 0.5;
      const cc = cm + Math.min(half * 0.4, 1.2);
      const stack = darker(WALL_COLOR[mat === "wood" || mat === "plaster" ? "stone" : mat], 0.04);
      const yTop = top3 + 1.0;
      boxP(darker(stack, 0.1), P(ca - 0.36, y - 0.2, cc - 0.36), P(ca + 0.36, yTop, cc + 0.36));
      for (let yy = y, n = 0; yy < yTop - 0.05; yy += 0.42, n++) {
        boxP(shadeOf(stack, n, 0.05), P(ca - 0.4, yy + 0.02, cc - 0.4), P(ca + 0.4, Math.min(yTop, yy + 0.42) - 0.02, cc + 0.4));
      }
      boxP(BRASS, P(ca - 0.46, yTop, cc - 0.46), P(ca + 0.46, yTop + 0.1, cc + 0.46));
      boxP(darker(stack, 0.15), P(ca - 0.14, yTop + 0.1, cc - 0.14), P(ca + 0.14, yTop + 0.5, cc + 0.14));
    }
    return;
  }
  // Hip: ridge shortened by the half-span at each end (a pyramid when square).
  const r0 = Math.min(a0 + half, (a0 + a1) / 2);
  const r1 = Math.max(a1 - half, (a0 + a1) / 2);
  slope(P(a0 - O, eave, c0 - O), P(a1 + O, eave, c0 - O), P(r1, top3, cm), P(r0, top3, cm), 0);
  slope(P(a1 + O, eave, c1 + O), P(a0 - O, eave, c1 + O), P(r0, top3, cm), P(r1, top3, cm), 7);
  slope(P(a0 - O, eave, c1 + O), P(a0 - O, eave, c0 - O), P(r0, top3, cm), P(r0, top3, cm), 3);
  slope(P(a1 + O, eave, c0 - O), P(a1 + O, eave, c1 + O), P(r1, top3, cm), P(r1, top3, cm), 5);
  ridge(r0, r1, top3, cm);
  gutters(a0 - O, a1 + O);
}

/** Build the full 3D view of one building. */
export function buildBuildingView(info: BuildingInfo, hm: Heightmap, mats: MaterialCache): BuildingView {
  const def = info.def;
  const group = new THREE.Group();
  group.name = `building:${def.id}`;
  const storeys: THREE.Group[] = [];
  const stairMeshes: THREE.Mesh[] = [];
  const stairMat = mats.get(STAIR_COLOR);
  const allLines: WallLine[][] = [];
  let topStorey = 0;
  def.storeys.forEach((st, k) => {
    if (st.tiles.length > 0 || st.walls.length > 0) topStorey = k;
  });
  const shutter = SHUTTERS[Math.floor(hash(def.id.length, [...def.id].reduce((a, c) => a * 31 + c.charCodeAt(0), 7)) * SHUTTERS.length)]!;
  /** Floor cells of storey k, or of the nearest storey below that has any. */
  const insideOf = (k: number): ((x: number, z: number) => boolean) => {
    for (let j = k; j >= 0; j--) {
      const t = def.storeys[j]!.tiles;
      if (t.length === 0) continue;
      const set = new Set(t.map(([x, z]) => `${x},${z}`));
      return (x, z) => set.has(`${x},${z}`);
    }
    return () => false;
  };

  def.storeys.forEach((storey, k) => {
    const g = new THREE.Group();
    g.name = `storey:${k}`;
    const b = new Batch();
    const y0 = storeyY(def, k);

    // Floor: storey 0 sits on a stone foundation down to the terrain; upper
    // storeys are slabs with holes where flights arrive from below.
    for (const [x, z] of storey.tiles) {
      if (k === 0) {
        const low = Math.min(
          getTerrainHeight(hm, x, z), getTerrainHeight(hm, x + 1, z), getTerrainHeight(hm, x, z + 1), getTerrainHeight(hm, x + 1, z + 1),
        );
        b.box(FOUNDATION_COLOR, x, low - 0.4, z, x + 1, y0 - 0.06, z + 1);
        b.box(FLOOR_COLOR, x, y0 - 0.06, z, x + 1, y0, z + 1);
      } else {
        const opening = def.stairs.some((s) => s.from < k && k <= s.to && stairCells(s).some(([sx, sz]) => sx === x && sz === z));
        if (!opening) b.box(FLOOR_COLOR, x, y0 - SLAB, z, x + 1, y0, z + 1);
      }
    }
    b.build(g, mats.get);
    const lines = wallLines(storey.walls, def.material, y0, def.floorHeight, mats, insideOf(k), k, k === topStorey, shutter);
    for (const l of lines) g.add(l.full, l.cut);
    allLines.push(lines);

    for (const s of def.stairs) {
      if (k < s.from || k >= s.to) continue;
      const mesh = new THREE.Mesh(flightGeometry(s, y0, def.floorHeight), stairMat);
      mesh.userData = { building: def.id, stair: s.id, flight: k } satisfies StairPick;
      g.add(mesh);
      stairMeshes.push(mesh);
    }
    storeys.push(g);
    group.add(g);
  });

  const roofGroup = new THREE.Group();
  roofGroup.name = "roof";
  const roofColor = def.roof.color ?? ROOF_COLOR[def.material];
  const roofMaterials: THREE.MeshLambertMaterial[] = [];
  const rb = new Batch();
  roof(rb, info, topStorey, roofColor, WALL_COLOR[def.material]);
  rb.build(roofGroup, (color) => {
    const m = color === VERTEX
      ? new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide, transparent: true })
      : new THREE.MeshLambertMaterial({ color, flatShading: true, side: THREE.DoubleSide, transparent: true });
    roofMaterials.push(m);
    return m;
  });
  group.add(roofGroup);

  return {
    group,
    storeys,
    roof: roofGroup,
    roofMaterials,
    stairMeshes,
    wallLines: allLines,
    topStorey,
    dispose() {
      group.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
      for (const m of roofMaterials) m.dispose();
    },
  };
}
