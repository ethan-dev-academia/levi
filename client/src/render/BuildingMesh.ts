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

const WALL_COLOR: Record<WallMaterial, string> = { wood: "#9a6a42", brick: "#a3533b", stone: "#8f8a80", plaster: "#d8cdb4" };
const TRIM_COLOR: Record<WallMaterial, string> = { wood: "#5b3a22", brick: "#7d3b29", stone: "#6c675f", plaster: "#5b3a22" };
const ROOF_COLOR: Record<WallMaterial, string> = { wood: "#6b4a32", brick: "#8e3f2b", stone: "#566070", plaster: "#9a7b45" };
const FLOOR_COLOR = "#8b6743";
const FOUNDATION_COLOR = "#77736b";
const STAIR_COLOR = "#6e4a2c";

/** One merged geometry per colour; position-only (normals come from flat shading). */
class Batch {
  private readonly parts = new Map<string, THREE.BufferGeometry[]>();

  add(color: string, g: THREE.BufferGeometry): void {
    for (const name of Object.keys(g.attributes)) if (name !== "position") g.deleteAttribute(name);
    let list = this.parts.get(color);
    if (!list) this.parts.set(color, (list = []));
    list.push(g);
  }

  box(color: string, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
    if (x1 - x0 <= 1e-4 || y1 - y0 <= 1e-4 || z1 - z0 <= 1e-4) return;
    const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
    g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    this.add(color, g);
  }

  /** Triangles from a flat [x,y,z,...] list (3 vertices each). */
  tris(color: string, pts: number[]): void {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    g.setIndex([...Array(pts.length / 3).keys()]);
    this.add(color, g);
  }

  build(target: THREE.Object3D, material: (color: string) => THREE.Material): void {
    for (const [color, list] of this.parts) {
      const merged = mergeGeometries(list);
      for (const g of list) g.dispose();
      if (merged) target.add(new THREE.Mesh(merged, material(color)));
    }
    this.parts.clear();
  }
}

/** Per-scene cache of opaque flat-shaded materials, keyed by colour. */
export class MaterialCache {
  private readonly mats = new Map<string, THREE.MeshLambertMaterial>();

  get = (color: string): THREE.MeshLambertMaterial => {
    let m = this.mats.get(color);
    if (!m) this.mats.set(color, (m = new THREE.MeshLambertMaterial({ color, flatShading: true })));
    return m;
  };

  dispose(): void {
    for (const m of this.mats.values()) m.dispose();
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

/** Course height and depth relief per material (planks, brick courses, stone blocks). */
const COURSE: Record<WallMaterial, { h: number; relief: number; shade: number }> = {
  wood: { h: 0.3, relief: 0.03, shade: 0.05 },
  brick: { h: 0.2, relief: 0.012, shade: 0.045 },
  stone: { h: 0.42, relief: 0.035, shade: 0.06 },
  plaster: { h: 9, relief: 0, shade: 0 },
};

const shadeCache = new Map<string, string>();
/** Deterministic light/dark variant of a colour for course `n`. */
function shadeOf(base: string, n: number, amount: number): string {
  const v = (((n * 2654435761) >>> 0) % 3) - 1; // -1, 0, 1
  const key = `${base}${v}${amount}`;
  let out = shadeCache.get(key);
  if (!out) shadeCache.set(key, (out = `#${new THREE.Color(base).offsetHSL(0, 0, v * amount).getHexString()}`));
  return out;
}

/**
 * Wall segment pieces, clipped at `y0 + h` (h < storey height = cutaway).
 * Wall bodies are built from horizontal courses with alternating shade and
 * slight relief so planks / bricks / blocks read without textures.
 */
function wallPieces(b: Batch, w: Wall, mat: WallMaterial, y0: number, storeyH: number, h: number): void {
  const m = w.material ?? mat;
  const wall = WALL_COLOR[m];
  const trim = TRIM_COLOR[m];
  const course = COURSE[m];
  const yMax = y0 + h;
  const seg = (color: string, a0: number, a1: number, ya: number, yb: number, thick = T): void => {
    const top = Math.min(yb, yMax);
    if (w.axis === "x") b.box(color, w.x + a0, ya, w.z - thick / 2, w.x + a1, top, w.z + thick / 2);
    else b.box(color, w.x - thick / 2, ya, w.z + a0, w.x + thick / 2, top, w.z + a1);
  };
  /** Body between ya..yb in courses aligned to the storey floor. */
  const body = (a0: number, a1: number, ya: number, yb: number): void => {
    const first = Math.floor((ya - y0) / course.h);
    for (let n = first; y0 + n * course.h < yb; n++) {
      const c0 = Math.max(ya, y0 + n * course.h);
      const c1 = Math.min(yb, y0 + (n + 1) * course.h);
      // Boards/blocks run the whole wall line; bricks also vary per segment.
      const lineSeed = w.axis === "x" ? w.z * 131 : w.x * 131 + 5;
      const along = m === "brick" ? (w.axis === "x" ? w.x : w.z) * 7 : 0;
      const seed = n * 31 + lineSeed + along;
      const color = course.shade > 0 ? shadeOf(wall, seed, course.shade) : wall;
      seg(color, a0, a1, c0, c1, T + (((seed >>> 0) % 2) * course.relief));
    }
  };
  const y1 = y0 + storeyH;
  if (w.kind === "wall") {
    body(0, 1, y0, y1);
    return;
  }
  // Openings: jambs in trim, then the wall around the hole.
  seg(trim, 0, 0.09, y0, y1, T + 0.04);
  seg(trim, 0.91, 1, y0, y1, T + 0.04);
  if (w.kind === "door") {
    body(0.09, 0.91, y0 + DOOR_H, y1);
    seg(trim, 0.09, 0.91, y0 + DOOR_H - 0.08, y0 + DOOR_H, T + 0.04);
  } else {
    body(0.09, 0.91, y0, y0 + SILL_H);
    seg(trim, 0.04, 0.96, y0 + SILL_H - 0.06, y0 + SILL_H, T + 0.14);
    body(0.09, 0.91, y0 + WINDOW_TOP, y1);
    seg(trim, 0.09, 0.91, y0 + WINDOW_TOP, y0 + WINDOW_TOP + 0.07, T + 0.04);
    // Dark pane so windows read from outside.
    seg("#2b2722", 0.09, 0.91, y0 + SILL_H, y0 + WINDOW_TOP, T * 0.35);
  }
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

/** Build every wall line of a storey, each in full and cutaway form. */
function wallLines(walls: readonly Wall[], mat: WallMaterial, y0: number, storeyH: number, mats: MaterialCache): WallLine[] {
  const lines = new Map<string, { axis: "x" | "z"; coord: number; full: Batch; cut: Batch }>();
  const lineFor = (key: string, axis: "x" | "z", coord: number) => {
    let l = lines.get(key);
    if (!l) lines.set(key, (l = { axis, coord, full: new Batch(), cut: new Batch() }));
    return l;
  };
  for (const w of walls) {
    const l = lineFor(lineOf(w), w.axis, w.axis === "x" ? w.z : w.x);
    wallPieces(l.full, w, mat, y0, storeyH, storeyH);
    wallPieces(l.cut, w, mat, y0, storeyH, CUTAWAY_HEIGHT);
  }
  const trim = TRIM_COLOR[mat];
  for (const p of postSpots(walls)) {
    for (const key of p.lines) {
      const l = lines.get(key)!;
      l.full.box(trim, p.x - POST / 2, y0, p.z - POST / 2, p.x + POST / 2, y0 + storeyH + 0.04, p.z + POST / 2);
      l.cut.box(trim, p.x - POST / 2, y0, p.z - POST / 2, p.x + POST / 2, y0 + CUTAWAY_HEIGHT + 0.04, p.z + POST / 2);
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
const LIP = 0.05;
const FASCIA = 0.12;

const darkCache = new Map<string, string>();
function darker(color: string, amount: number): string {
  const key = `${color}${amount}`;
  let out = darkCache.get(key);
  if (!out) darkCache.set(key, (out = `#${new THREE.Color(color).offsetHSL(0, 0, -amount).getHexString()}`));
  return out;
}

type V3 = [number, number, number];
const lerp3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const add3 = (a: V3, n: V3, k: number): V3 => [a[0] + n[0] * k, a[1] + n[1] * k, a[2] + n[2] * k];

/**
 * One roof face as overlapping shingle courses. A→B is the eave, D→C the
 * top edge (C = D for a triangle). Each course is lifted at its lower edge
 * with a darker butt face, so the slope reads as layered shingles.
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
  const butt = darker(color, 0.1);
  for (let i = 0; i < courses; i++) {
    const t0 = i / courses, t1 = (i + 1) / courses;
    const L0 = lerp3(A, D, t0), R0 = lerp3(B, C, t0), L1 = lerp3(A, D, t1), R1 = lerp3(B, C, t1);
    const L0u = add3(L0, n, LIP), R0u = add3(R0, n, LIP);
    const c = shadeOf(color, i + seed, 0.035);
    b.tris(c, [...L0u, ...R0u, ...R1, ...L0u, ...R1, ...L1]);
    b.tris(butt, [...L0, ...R0, ...R0u, ...L0, ...R0u, ...L0u]);
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
  const cap = darker(roofColor, 0.2);
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
  if (kind === "gable") {
    slope(P(a0 - O, eave, c0 - O), P(a1 + O, eave, c0 - O), P(a1 + O, top3, cm), P(a0 - O, top3, cm), 0);
    slope(P(a1 + O, eave, c1 + O), P(a0 - O, eave, c1 + O), P(a0 - O, top3, cm), P(a1 + O, top3, cm), 7);
    for (const a of [a0, a1]) tri(gableColor, P(a, y, c0), P(a, y, c1), P(a, top3, cm));
    ridge(a0 - O, a1 + O, top3, cm);
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

  def.storeys.forEach((storey, k) => {
    const g = new THREE.Group();
    g.name = `storey:${k}`;
    const b = new Batch();
    const y0 = storeyY(def, k);
    // The roof caps the highest storey with a floor or walls.
    if (storey.tiles.length > 0 || storey.walls.length > 0) topStorey = k;

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
    const lines = wallLines(storey.walls, def.material, y0, def.floorHeight, mats);
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
    const m = new THREE.MeshLambertMaterial({ color, flatShading: true, side: THREE.DoubleSide, transparent: true });
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
