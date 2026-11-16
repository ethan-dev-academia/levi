import * as THREE from "three";
import { valueNoise2, type CellRect, type Heightmap, type MapData, type WalkGrid } from "@levi/shared";
import { cellColor, type PaletteOptions } from "./terrainPalette.js";

export const CHUNK_CELLS = 64;
/** Chunks within this ring (Chebyshev distance) are built. */
const LOAD_RADIUS = 3;
/** Chunks beyond this ring are disposed. */
const UNLOAD_RADIUS = 5;
/** Max chunk builds per frame, to avoid hitches while running. */
const BUILDS_PER_FRAME = 2;

/**
 * Streams flat-shaded terrain chunks around a focus point.
 *
 * Triangulation MUST match getTerrainHeight(): per cell,
 *   tri A = (x0,z0) (x0,z1) (x1,z0)   tri B = (x1,z1) (x1,z0) (x0,z1)
 * Normals come from screen-space derivatives (flatShading), so no normal
 * buffer is stored: 2 attributes × 9 floats per triangle.
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
  update(focusX: number, focusZ: number, force = false): void {
    const size = CHUNK_CELLS * this.hm.cellSize;
    const fx = Math.floor(focusX / size);
    const fz = Math.floor(focusZ / size);

    for (const [key, mesh] of this.chunks) {
      const [kx, kz] = key.split(",").map(Number) as [number, number];
      if (Math.max(Math.abs(kx - fx), Math.abs(kz - fz)) > UNLOAD_RADIUS) {
        this.group.remove(mesh);
        mesh.geometry.dispose();
        this.chunks.delete(key);
      }
    }

    // Nearest-first build queue.
    const wanted: Array<[number, number, number]> = [];
    for (let dz = -LOAD_RADIUS; dz <= LOAD_RADIUS; dz++) {
      for (let dx = -LOAD_RADIUS; dx <= LOAD_RADIUS; dx++) {
        const kx = fx + dx;
        const kz = fz + dz;
        if (kx < 0 || kz < 0 || kx >= this.chunksX || kz >= this.chunksZ) continue;
        if (this.chunks.has(`${kx},${kz}`)) continue;
        wanted.push([kx, kz, dx * dx + dz * dz]);
      }
    }
    wanted.sort((a, b) => a[2] - b[2]);
    const budget = force ? wanted.length : BUILDS_PER_FRAME;
    for (let i = 0; i < Math.min(budget, wanted.length); i++) {
      const [kx, kz] = wanted[i]!;
      this.buildChunk(kx, kz);
    }
  }

  /** Rebuild loaded chunks overlapping a cell rectangle (for the sculptor). */
  rebuildCells(r: CellRect): void {
    const kx0 = Math.max(0, Math.floor(r.cx0 / CHUNK_CELLS));
    const kz0 = Math.max(0, Math.floor(r.cz0 / CHUNK_CELLS));
    const kx1 = Math.min(this.chunksX - 1, Math.floor(r.cx1 / CHUNK_CELLS));
    const kz1 = Math.min(this.chunksZ - 1, Math.floor(r.cz1 / CHUNK_CELLS));
    for (let kz = kz0; kz <= kz1; kz++) {
      for (let kx = kx0; kx <= kx1; kx++) {
        const mesh = this.chunks.get(`${kx},${kz}`);
        if (mesh) {
          this.group.remove(mesh);
          mesh.geometry.dispose();
          this.chunks.delete(`${kx},${kz}`);
          this.buildChunk(kx, kz);
        }
      }
    }
  }

  private buildChunk(kx: number, kz: number): void {
    const { hm } = this;
    const cs = hm.cellSize;
    const c0x = kx * CHUNK_CELLS;
    const c0z = kz * CHUNK_CELLS;
    const c1x = Math.min(c0x + CHUNK_CELLS, hm.cols);
    const c1z = Math.min(c0z + CHUNK_CELLS, hm.rows);
    const tris = (c1x - c0x) * (c1z - c0z) * 2;
    const P = new Float32Array(tris * 9);
    const C = new Float32Array(tris * 9);
    const base = new THREE.Color();
    const col = new THREE.Color();
    let p = 0;
    let c = 0;

    const put = (x: number, y: number, z: number): void => {
      P[p++] = x; P[p++] = y; P[p++] = z;
    };
    const paint = (cl: THREE.Color): void => {
      for (let v = 0; v < 3; v++) {
        C[c++] = cl.r; C[c++] = cl.g; C[c++] = cl.b;
      }
    };

    for (let cz = c0z; cz < c1z; cz++) {
      for (let cx = c0x; cx < c1x; cx++) {
        const x0 = cx * cs, x1 = x0 + cs, z0 = cz * cs, z1 = z0 + cs;
        const h00 = hm.vertex(cx, cz);
        const h10 = hm.vertex(cx + 1, cz);
        const h01 = hm.vertex(cx, cz + 1);
        const h11 = hm.vertex(cx + 1, cz + 1);
        cellColor(this.data, this.walk, cx, cz, base, this.palette);

        put(x0, h00, z0); put(x0, h01, z1); put(x1, h10, z0);
        paint(col.copy(base).offsetHSL(0, 0, (valueNoise2(cx * 0.9, cz * 0.9, 7) - 0.5) * 0.06));

        put(x1, h11, z1); put(x1, h10, z0); put(x0, h01, z1);
        paint(col.copy(base).offsetHSL(0, 0, (valueNoise2(cx * 0.9 + 0.5, cz * 0.9, 7) - 0.5) * 0.06));
      }
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(P, 3));
    geom.setAttribute("color", new THREE.BufferAttribute(C, 3));
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

/** Large water plane extending past the map so the fogged horizon reads as sea. */
export function createWater(hm: Heightmap, level: number): THREE.Mesh {
  const size = Math.max(hm.width, hm.depth) * 3;
  const geom = new THREE.PlaneGeometry(size, size, 1, 1);
  geom.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshLambertMaterial({ color: 0x3f7391, transparent: true, opacity: 0.82 });
  const water = new THREE.Mesh(geom, mat);
  water.position.set(hm.width / 2, level, hm.depth / 2);
  water.name = "water";
  return water;
}
