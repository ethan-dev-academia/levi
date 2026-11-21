import * as THREE from "three";
import { valueNoise2, type CellRect, type Heightmap, type MapData, type WalkGrid } from "@levi/shared";
import { cellColor, type PaletteOptions } from "./terrainPalette.js";
import type { TerrainTopology } from "./TerrainTopology.js";

export const CHUNK_CELLS = 64;
/** Chunks within this ring (Chebyshev distance) are built. */
const LOAD_RADIUS = 3;
/** Chunks beyond this ring are disposed. */
const UNLOAD_RADIUS = 5;
/** Max chunk builds per frame, to avoid hitches while running. */
const BUILDS_PER_FRAME = 2;

/** Floating-island underside shape. */
const LIP = 1.6; // thickness at the void edge
const DEPTH_PER_CELL = 1.25; // how fast the underside drops toward the middle
const MAX_DEPTH = 70;

const EARTH = new THREE.Color(0x6e5136);
const EARTH_DARK = new THREE.Color(0x4f3b2a);
const UNDER_ROCK = new THREE.Color(0x4a4643);
const UNDER_ROCK_DEEP = new THREE.Color(0x36383d);

const DOWN = new THREE.Vector3(0, -1, 0);
const N_POS_X = new THREE.Vector3(1, 0, 0);
const N_NEG_X = new THREE.Vector3(-1, 0, 0);
const N_POS_Z = new THREE.Vector3(0, 0, 1);
const N_NEG_Z = new THREE.Vector3(0, 0, -1);

/** Painted material id for cobblestone (sculpted into individual stones). */
const COBBLE = 10;
const FLOWERS = [0xf2e6a0, 0xe7a3c0, 0xa8c4f0, 0xf4f1ea, 0xe8b65a].map((c) => new THREE.Color(c));

/** Deterministic 0..1 hash of three integers. */
function hash01(a: number, b: number, c: number): number {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(c | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Grass painted, or unpainted ground that the palette makes grass. */
function isGrassy(paint: number, a: number, b: number, c: number, d: number, water: number, maxStep: number): boolean {
  if (paint >= 1 && paint <= 3) return true;
  if (paint !== 0) return false;
  return (a + b + c + d) / 4 - water >= 0.6 && Math.max(a, b, c, d) - Math.min(a, b, c, d) <= maxStep;
}

/**
 * Streams flat-shaded terrain chunks around a focus point.
 *
 * Top triangulation MUST match getTerrainHeight(): per cell,
 *   tri A = (x0,z0) (x0,z1) (x1,z0)   tri B = (x1,z1) (x1,z0) (x0,z1)
 * Void cells draw nothing. Floating cells also get a jagged rock underside
 * and side walls along void edges. Normals come from screen-space
 * derivatives (flatShading), so no normal buffer is stored.
 */
export class ChunkedTerrain {
  readonly group = new THREE.Group();
  private readonly chunks = new Map<string, THREE.Mesh>();
  private readonly material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  private readonly chunksX: number;
  private readonly chunksZ: number;
  private readonly hm: Heightmap;
  private readonly palette: PaletteOptions = { showCollision: false };

  constructor(
    private readonly data: MapData,
    private readonly walk: WalkGrid,
    private readonly topo: TerrainTopology,
  ) {
    this.hm = data.hm;
    this.group.name = "terrain";
    this.chunksX = Math.ceil(this.hm.cols / CHUNK_CELLS);
    this.chunksZ = Math.ceil(this.hm.rows / CHUNK_CELLS);
  }

  get showCollision(): boolean {
    return this.palette.showCollision;
  }

  set showCollision(v: boolean) {
    if (v === this.palette.showCollision) return;
    this.palette.showCollision = v;
    this.rebuildAll();
  }

  /** Rebuild every loaded chunk (palette / water level changes). */
  rebuildAll(): void {
    this.rebuildCells({ cx0: 0, cz0: 0, cx1: this.hm.cols - 1, cz1: this.hm.rows - 1 });
  }

  /** Call every frame with the camera focus. `force` builds everything in range now (first frame). */
  update(focusX: number, focusZ: number, force = false, also?: { x: number; z: number }): void {
    const size = CHUNK_CELLS * this.hm.cellSize;
    const fx = Math.floor(focusX / size);
    const fz = Math.floor(focusZ / size);
    // A second place to keep built (a cutscene looking far away).
    const ax = also ? Math.floor(also.x / size) : fx;
    const az = also ? Math.floor(also.z / size) : fz;

    for (const [key, mesh] of this.chunks) {
      const [kx, kz] = key.split(",").map(Number) as [number, number];
      if (Math.max(Math.abs(kx - fx), Math.abs(kz - fz)) > UNLOAD_RADIUS && Math.max(Math.abs(kx - ax), Math.abs(kz - az)) > UNLOAD_RADIUS) {
        this.group.remove(mesh);
        mesh.geometry.dispose();
        this.chunks.delete(key);
      }
    }

    // Nearest-first build queue.
    const wanted: Array<[number, number, number]> = [];
    const seen = new Set<string>();
    const centres: Array<[number, number]> = also ? [[fx, fz], [ax, az]] : [[fx, fz]];
    for (const [cx, cz] of centres) {
      for (let dz = -LOAD_RADIUS; dz <= LOAD_RADIUS; dz++) {
        for (let dx = -LOAD_RADIUS; dx <= LOAD_RADIUS; dx++) {
          const kx = cx + dx;
          const kz = cz + dz;
          const key = `${kx},${kz}`;
          if (kx < 0 || kz < 0 || kx >= this.chunksX || kz >= this.chunksZ) continue;
          if (this.chunks.has(key) || seen.has(key)) continue;
          seen.add(key);
          wanted.push([kx, kz, dx * dx + dz * dz]);
        }
      }
    }
    wanted.sort((a, b) => a[2] - b[2]);
    // While a cutscene flies, build one at a time: a smooth camera beats fast pop-in.
    const budget = force ? wanted.length : also ? 1 : BUILDS_PER_FRAME;
    for (let i = 0; i < Math.min(budget, wanted.length); i++) {
      const [kx, kz] = wanted[i]!;
      this.buildChunk(kx, kz);
    }
  }

  /** Largest ring (≤ max) of chunks around the focus that is fully built. */
  builtRing(focusX: number, focusZ: number, max: number): number {
    const size = CHUNK_CELLS * this.hm.cellSize;
    const fx = Math.floor(focusX / size);
    const fz = Math.floor(focusZ / size);
    for (let r = 0; r <= max; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const kx = fx + dx, kz = fz + dz;
          if (kx < 0 || kz < 0 || kx >= this.chunksX || kz >= this.chunksZ) continue;
          if (!this.chunks.has(`${kx},${kz}`)) return r - 1;
        }
      }
    }
    return max;
  }

  /** Rebuild loaded chunks overlapping a cell rectangle (for the sculptor). */
  rebuildCells(r: CellRect): void {
    const kx0 = Math.max(0, Math.floor(r.cx0 / CHUNK_CELLS));
    const kz0 = Math.max(0, Math.floor(r.cz0 / CHUNK_CELLS));
    const kx1 = Math.min(this.chunksX - 1, Math.floor(r.cx1 / CHUNK_CELLS));
    const kz1 = Math.min(this.chunksZ - 1, Math.floor(r.cz1 / CHUNK_CELLS));
    for (let kz = kz0; kz <= kz1; kz++) for (let kx = kx0; kx <= kx1; kx++) this.rebuildChunk(kx, kz);
  }

  /** Rebuild specific chunks if loaded (after a topology change). */
  rebuildChunks(list: ReadonlyArray<readonly [number, number]>): void {
    for (const [kx, kz] of list) this.rebuildChunk(kx, kz);
  }

  private rebuildChunk(kx: number, kz: number): void {
    const key = `${kx},${kz}`;
    const mesh = this.chunks.get(key);
    if (!mesh) return;
    this.group.remove(mesh);
    mesh.geometry.dispose();
    this.chunks.delete(key);
    this.buildChunk(kx, kz);
  }

  /** Underside Y below vertex (vx, vz) of a floating island. */
  private bottomAt(vx: number, vz: number): number {
    const i = vz * (this.hm.cols + 1) + vx;
    const d = Math.min(this.topo.holeDist[i] ?? 0, 400);
    const top = this.hm.vertex(vx, vz);
    // Measure from the edge height so mountains on top don't bulge the underside.
    const ref = Math.min(top, (this.topo.edgeHeight[i] ?? top) + 2);
    const wobble = 0.7 + valueNoise2(vx * 0.21, vz * 0.21, 913) * 0.6;
    const spike = valueNoise2(vx * 0.7, vz * 0.7, 577) > 0.8 ? d * 0.45 : 0; // stalactites
    return ref - Math.min(MAX_DEPTH, LIP + d * DEPTH_PER_CELL * wobble + spike);
  }

  private buildChunk(kx: number, kz: number): void {
    const { hm, data, topo } = this;
    const { cols, rows } = data.def;
    const cs = hm.cellSize;
    const c0x = kx * CHUNK_CELLS;
    const c0z = kz * CHUNK_CELLS;
    const c1x = Math.min(c0x + CHUNK_CELLS, hm.cols);
    const c1z = Math.min(c0z + CHUNK_CELLS, hm.rows);
    const P: number[] = [];
    const C: number[] = [];
    const base = new THREE.Color();
    const col = new THREE.Color();
    const mortar = new THREE.Color();
    const stoneCol = new THREE.Color();
    const side = new THREE.Color();
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const e1 = new THREE.Vector3();
    const e2 = new THREE.Vector3();

    const tri = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, cl: THREE.Color): void => {
      P.push(ax, ay, az, bx, by, bz, cx, cy, cz);
      C.push(cl.r, cl.g, cl.b, cl.r, cl.g, cl.b, cl.r, cl.g, cl.b);
    };
    /** Emit a triangle wound so its normal faces `out`. */
    const facing = (out: THREE.Vector3, cl: THREE.Color): void => {
      e1.subVectors(b, a);
      e2.subVectors(c, a);
      if (e1.cross(e2).dot(out) >= 0) tri(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, cl);
      else tri(a.x, a.y, a.z, c.x, c.y, c.z, b.x, b.y, b.z, cl);
    };
    const isVoid = (x: number, z: number): boolean => x < 0 || z < 0 || x >= cols || z >= rows || data.holes[z * cols + x] === 1;
    const undersideColor = (depth: number, jx: number, jz: number): THREE.Color => {
      const t = Math.min(1, depth / 28);
      if (t < 0.25) col.copy(EARTH).lerp(EARTH_DARK, t / 0.25);
      else col.copy(UNDER_ROCK).lerp(UNDER_ROCK_DEEP, (t - 0.25) / 0.75);
      return col.offsetHSL(0, 0, (valueNoise2(jx * 0.8, jz * 0.8, 31) - 0.5) * 0.07);
    };

    for (let cz = c0z; cz < c1z; cz++) {
      for (let cx = c0x; cx < c1x; cx++) {
        const ci = cz * cols + cx;
        if (data.holes[ci] === 1) continue;

        const x0 = cx * cs, x1 = x0 + cs, z0 = cz * cs, z1 = z0 + cs;
        const h00 = hm.vertex(cx, cz);
        const h10 = hm.vertex(cx + 1, cz);
        const h01 = hm.vertex(cx, cz + 1);
        const h11 = hm.vertex(cx + 1, cz + 1);
        cellColor(data, this.walk, cx, cz, base, this.palette);
        const paint = data.paint[ci] ?? 0;
        const covered = data.buildings.containing(cx, cz) !== null;
        const cobbled = paint === COBBLE && !covered;
        // Cobbled cells: the ground between stones is dark mortar.
        const ground = cobbled ? mortar.copy(base).offsetHSL(0, -0.03, -0.17) : base;

        tri(x0, h00, z0, x0, h01, z1, x1, h10, z0, col.copy(ground).offsetHSL(0, 0, (valueNoise2(cx * 0.9, cz * 0.9, 7) - 0.5) * 0.06));
        tri(x1, h11, z1, x1, h10, z0, x0, h01, z1, col.copy(ground).offsetHSL(0, 0, (valueNoise2(cx * 0.9 + 0.5, cz * 0.9, 7) - 0.5) * 0.06));

        // Ground height inside the cell, matching the two top triangles.
        const hAt = (u: number, v: number): number =>
          u + v <= 1 ? h00 + (h10 - h00) * u + (h01 - h00) * v : h11 + (h01 - h11) * (1 - u) + (h10 - h11) * (1 - v);
        if (cobbled) {
          // Stones: two staggered rows per cell, each stone raised with bevelled sides.
          const stone = (u0: number, v0: number, u1: number, v1: number, n: number): void => {
            const r = hash01(cx, cz, n);
            const ins = 0.03 + r * 0.012;
            const ua = u0 + ins, ub = u1 - ins, va = v0 + ins, vb = v1 - ins;
            if (ub - ua < 0.05) return;
            const lift = 0.04 + r * 0.035;
            const tilt = (hash01(cz, cx, n + 9) - 0.5) * 0.03;
            const cl = stoneCol.copy(base).offsetHSL((r - 0.5) * 0.02, (hash01(cx, n, cz) - 0.5) * 0.05, (hash01(n, cz, cx) - 0.5) * 0.14 + 0.02);
            const pt = (u: number, v: number, top: boolean): THREE.Vector3 =>
              new THREE.Vector3(x0 + u * cs, hAt(u, v) + (top ? lift + tilt * (u - (ua + ub) / 2) * 4 : -0.01), z0 + v * cs);
            const t00 = pt(ua, va, true), t01 = pt(ua, vb, true), t11 = pt(ub, vb, true), t10 = pt(ub, va, true);
            tri(t00.x, t00.y, t00.z, t01.x, t01.y, t01.z, t10.x, t10.y, t10.z, cl);
            tri(t11.x, t11.y, t11.z, t10.x, t10.y, t10.z, t01.x, t01.y, t01.z, cl);
            side.copy(cl).offsetHSL(0, 0, -0.08);
            const sideQuad = (p: THREE.Vector3, q: THREE.Vector3, pu: number, pv: number, qu: number, qv: number, out: THREE.Vector3): void => {
              const pb = pt(pu, pv, false), qb = pt(qu, qv, false);
              a.copy(p); b.copy(q); c.copy(pb); facing(out, side);
              a.copy(q); b.copy(qb); c.copy(pb); facing(out, side);
            };
            sideQuad(t00, t10, ua, va, ub, va, N_NEG_Z);
            sideQuad(t01, t11, ua, vb, ub, vb, N_POS_Z);
            sideQuad(t00, t01, ua, va, ua, vb, N_NEG_X);
            sideQuad(t10, t11, ub, va, ub, vb, N_POS_X);
          };
          const j = (k: number): number => (hash01(cx, cz, k) - 0.5) * 0.12;
          const m1 = 0.5 + j(1);
          stone(0, 0, m1, 0.5, 0);
          stone(m1, 0, 1, 0.5, 1);
          const m2 = 0.25 + j(2), m3 = 0.75 + j(3);
          stone(0, 0.5, m2, 1, 2);
          stone(m2, 0.5, m3, 1, 3);
          stone(m3, 0.5, 1, 1, 4);
        } else if (!covered && isGrassy(paint, h00, h10, h01, h11, data.def.waterLevel, data.def.maxStep)) {
          // Tufts of grass and the odd flower.
          const r = hash01(cx, cz, 21);
          if (r < 0.24) {
            const u = 0.15 + hash01(cz, cx, 22) * 0.7, v = 0.15 + hash01(cx, cz, 23) * 0.7;
            const gx = x0 + u * cs, gz = z0 + v * cs, gy = hAt(u, v) - 0.02;
            const blade = side.copy(base).offsetHSL(0.012, 0.06, 0.07 + r * 0.25);
            for (let k = 0; k < 3; k++) {
              const ang = hash01(cx, cz, 30 + k) * Math.PI * 2;
              const hgt = 0.26 + hash01(cz, cx, 40 + k) * 0.22;
              const lean = 0.08 + hash01(cx, k, cz) * 0.1;
              const dx = Math.cos(ang), dz = Math.sin(ang);
              const bx = gx + dz * 0.04, bz = gz - dx * 0.04, ex = gx - dz * 0.04, ez = gz + dx * 0.04;
              const tx = gx + dx * lean, tz = gz + dz * lean, ty = gy + hgt;
              tri(bx, gy, bz, ex, gy, ez, tx, ty, tz, blade);
              tri(ex, gy, ez, bx, gy, bz, tx, ty, tz, blade);
            }
            if (r < 0.03) {
              const fl = FLOWERS[Math.floor(hash01(cz, cx, 50) * FLOWERS.length)]!;
              const fy = gy + 0.3;
              tri(gx - 0.06, fy, gz, gx + 0.06, fy, gz, gx, fy + 0.07, gz + 0.01, fl);
              tri(gx + 0.06, fy, gz, gx - 0.06, fy, gz, gx, fy + 0.07, gz + 0.01, fl);
              tri(gx, fy, gz - 0.06, gx, fy, gz + 0.06, gx + 0.01, fy + 0.07, gz, fl);
              tri(gx, fy, gz + 0.06, gx, fy, gz - 0.06, gx + 0.01, fy + 0.07, gz, fl);
            }
          }
        }

        if (topo.floating[ci] !== 1) continue;

        // --- Underside (faces down) ---------------------------------------
        const b00 = this.bottomAt(cx, cz);
        const b10 = this.bottomAt(cx + 1, cz);
        const b01 = this.bottomAt(cx, cz + 1);
        const b11 = this.bottomAt(cx + 1, cz + 1);
        const depthA = (h00 + h01 + h10 - b00 - b01 - b10) / 3;
        const depthB = (h11 + h10 + h01 - b11 - b10 - b01) / 3;
        a.set(x0, b00, z0); b.set(x0, b01, z1); c.set(x1, b10, z0);
        facing(DOWN, undersideColor(depthA, cx, cz));
        a.set(x1, b11, z1); b.set(x1, b10, z0); c.set(x0, b01, z1);
        facing(DOWN, undersideColor(depthB, cx + 0.5, cz));

        // --- Side walls where the cell borders void ----------------------
        const wall = (
          ax: number, az: number, ah: number, ab: number,
          bx: number, bz: number, bh: number, bb: number,
          out: THREE.Vector3,
        ): void => {
          const wc = undersideColor(((ah - ab) + (bh - bb)) / 4, ax + bx, az + bz);
          a.set(ax, ah, az); b.set(bx, bh, bz); c.set(ax, ab, az);
          facing(out, wc);
          a.set(bx, bh, bz); b.set(bx, bb, bz); c.set(ax, ab, az);
          facing(out, wc);
        };
        if (isVoid(cx, cz - 1)) wall(x0, z0, h00, b00, x1, z0, h10, b10, new THREE.Vector3(0, 0, -1));
        if (isVoid(cx, cz + 1)) wall(x0, z1, h01, b01, x1, z1, h11, b11, new THREE.Vector3(0, 0, 1));
        if (isVoid(cx - 1, cz)) wall(x0, z0, h00, b00, x0, z1, h01, b01, new THREE.Vector3(-1, 0, 0));
        if (isVoid(cx + 1, cz)) wall(x1, z0, h10, b10, x1, z1, h11, b11, new THREE.Vector3(1, 0, 0));
      }
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.Float32BufferAttribute(P, 3));
    geom.setAttribute("color", new THREE.Float32BufferAttribute(C, 3));
    geom.computeBoundingSphere();
    const mesh = new THREE.Mesh(geom, this.material);
    mesh.name = `chunk:${kx},${kz}`;
    mesh.matrixAutoUpdate = false;
    this.group.add(mesh);
    this.chunks.set(`${kx},${kz}`, mesh);
  }

  dispose(): void {
    for (const mesh of this.chunks.values()) mesh.geometry.dispose();
    this.chunks.clear();
    this.material.dispose();
  }
}

/**
 * Sea surface plus a dark abyss plane far below it, so void cells and deep
 * water read as open ocean rather than see-through sky.
 */
export function createWater(hm: Heightmap, level: number): THREE.Group {
  const size = Math.max(hm.width, hm.depth) * 3;
  const group = new THREE.Group();
  group.name = "water";
  group.position.set(hm.width / 2, level, hm.depth / 2);

  const surfaceGeom = new THREE.PlaneGeometry(size, size, 1, 1);
  surfaceGeom.rotateX(-Math.PI / 2);
  const surface = new THREE.Mesh(surfaceGeom, new THREE.MeshLambertMaterial({ color: 0x3f7391, transparent: true, opacity: 0.85 }));

  const abyssGeom = new THREE.PlaneGeometry(size, size, 1, 1);
  abyssGeom.rotateX(-Math.PI / 2);
  const abyss = new THREE.Mesh(abyssGeom, new THREE.MeshBasicMaterial({ color: 0x0f2f45 }));
  abyss.position.y = -30;

  group.add(abyss, surface);
  return group;
}

