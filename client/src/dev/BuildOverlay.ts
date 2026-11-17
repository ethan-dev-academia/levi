import * as THREE from "three";
import type { CellRect } from "@levi/shared";
import type { Edge } from "./BuildTool.js";

const GRID_RADIUS = 5;
const MAX_SEGMENTS = 4096;

/**
 * Build-mode guides drawn on the edit plane: a faint cell grid around the
 * cursor, plus the rect / edges / cells about to be placed. One
 * LineSegments buffer, rewritten each frame.
 */
export class BuildOverlay {
  readonly group = new THREE.Group();
  private readonly grid: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  private readonly shape: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  private readonly gridPos = new Float32Array(MAX_SEGMENTS * 6);
  private readonly shapePos = new Float32Array(MAX_SEGMENTS * 6);

  constructor() {
    const make = (buf: Float32Array, color: number, opacity: number) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(buf, 3));
      g.setDrawRange(0, 0);
      const line = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false, fog: false }));
      line.frustumCulled = false;
      line.renderOrder = 11;
      return line;
    };
    this.grid = make(this.gridPos, 0xffffff, 0.22);
    this.shape = make(this.shapePos, 0xffe14a, 1);
    this.group.add(this.grid, this.shape);
    this.group.visible = false;
  }

  setColor(hex: number): void {
    this.shape.material.color.setHex(hex);
  }

  /** Grid lines around cell (cx, cz) at height `y(x, z)`. */
  setGrid(cx: number, cz: number, y: (x: number, z: number) => number): void {
    let n = 0;
    const seg = (x0: number, z0: number, x1: number, z1: number): void => {
      if (n >= MAX_SEGMENTS) return;
      this.gridPos.set([x0, y(x0, z0) + 0.04, z0, x1, y(x1, z1) + 0.04, z1], n * 6);
      n++;
    };
    const R = GRID_RADIUS;
    for (let i = -R; i <= R + 1; i++) {
      for (let j = -R; j <= R; j++) {
        seg(cx + i, cz + j, cx + i, cz + j + 1);
        seg(cx + j, cz + i, cx + j + 1, cz + i);
      }
    }
    this.grid.geometry.attributes["position"]!.needsUpdate = true;
    this.grid.geometry.setDrawRange(0, n * 2);
  }

  private writeShape(segs: number[][]): void {
    const n = Math.min(segs.length, MAX_SEGMENTS);
    for (let i = 0; i < n; i++) this.shapePos.set(segs[i]!, i * 6);
    this.shape.geometry.attributes["position"]!.needsUpdate = true;
    this.shape.geometry.setDrawRange(0, n * 2);
  }

  clearShape(): void {
    this.shape.geometry.setDrawRange(0, 0);
  }

  /** Outline of a cell rect, with short posts at the corners. */
  setRect(r: CellRect, y: number, wallHeight = 0): void {
    const x0 = r.cx0, z0 = r.cz0, x1 = r.cx1 + 1, z1 = r.cz1 + 1, yy = y + 0.06;
    const segs = [
      [x0, yy, z0, x1, yy, z0], [x1, yy, z0, x1, yy, z1], [x1, yy, z1, x0, yy, z1], [x0, yy, z1, x0, yy, z0],
    ];
    if (wallHeight > 0) for (const [x, z] of [[x0, z0], [x1, z0], [x1, z1], [x0, z1]] as const) segs.push([x, yy, z, x, yy + wallHeight, z]);
    this.writeShape(segs);
  }

  /** Wall edges as upright frames. */
  setEdges(edges: readonly Edge[], y: number, h: number): void {
    const segs: number[][] = [];
    for (const e of edges) {
      const [ax, az, bx, bz] = e.axis === "x" ? [e.x, e.z, e.x + 1, e.z] : [e.x, e.z, e.x, e.z + 1];
      segs.push([ax, y + 0.06, az, bx, y + 0.06, bz], [ax, y + h, az, bx, y + h, bz], [ax, y, az, ax, y + h, az], [bx, y, bz, bx, y + h, bz]);
    }
    this.writeShape(segs);
  }

  /** Outline cells plus an arrow along `dir` (stairs preview). */
  setCells(cells: ReadonlyArray<readonly [number, number]>, y: number, dir: readonly [number, number]): void {
    const segs: number[][] = [];
    const yy = y + 0.06;
    for (const [x, z] of cells) {
      segs.push([x, yy, z, x + 1, yy, z], [x + 1, yy, z, x + 1, yy, z + 1], [x + 1, yy, z + 1, x, yy, z + 1], [x, yy, z + 1, x, yy, z]);
    }
    const first = cells[0];
    const last = cells[cells.length - 1];
    if (first && last) {
      const sx = first[0] + 0.5, sz = first[1] + 0.5;
      const ex = last[0] + 0.5 + dir[0] * 0.4, ez = last[1] + 0.5 + dir[1] * 0.4;
      const [px, pz] = [-dir[1] * 0.25, dir[0] * 0.25];
      segs.push([sx, yy, sz, ex, yy + 0.5, ez]);
      segs.push([ex, yy + 0.5, ez, ex - dir[0] * 0.3 + px, yy + 0.4, ez - dir[1] * 0.3 + pz]);
      segs.push([ex, yy + 0.5, ez, ex - dir[0] * 0.3 - px, yy + 0.4, ez - dir[1] * 0.3 - pz]);
    }
    this.writeShape(segs);
  }
}
