import type { MapData } from "@levi/shared";

const FAR = 1e6;
const DIAG = Math.SQRT2;

/**
 * Derived (never saved) shape info used to render floating islands:
 *  - floating[cell]: land not connected (4-neighbour, through non-void cells)
 *    to anything at sea level → it hangs in the sky and gets an underside
 *  - holeDist[vertex]: distance in cells to the nearest void cell
 *  - edgeHeight[vertex]: surface height at that nearest void edge
 *    (underside depth is measured from here, so mountains don't bulge it)
 */
export class TerrainTopology {
  readonly floating: Uint8Array;
  readonly holeDist: Float32Array;
  readonly edgeHeight: Float32Array;
  private readonly vx: number;

  constructor(private readonly data: MapData) {
    const { cols, rows } = data.def;
    this.vx = cols + 1;
    this.floating = new Uint8Array(cols * rows);
    this.holeDist = new Float32Array((cols + 1) * (rows + 1));
    this.edgeHeight = new Float32Array((cols + 1) * (rows + 1));
    this.compute();
  }

  /** Recompute everything; returns chunk coords whose topology changed. */
  recompute(chunkCells: number): Array<[number, number]> {
    const prevFloat = this.floating.slice();
    const prevDist = this.holeDist.slice();
    this.compute();

    const { cols, rows } = this.data.def;
    const changed: Array<[number, number]> = [];
    for (let kz = 0; kz < rows / chunkCells; kz++) {
      for (let kx = 0; kx < cols / chunkCells; kx++) {
        if (this.chunkDiffers(kx, kz, chunkCells, prevFloat, prevDist)) changed.push([kx, kz]);
      }
    }
    return changed;
  }

  private chunkDiffers(kx: number, kz: number, n: number, pf: Uint8Array, pd: Float32Array): boolean {
    const { cols } = this.data.def;
    for (let z = kz * n; z < kz * n + n; z++) {
      for (let x = kx * n; x < kx * n + n; x++) {
        if (pf[z * cols + x] !== this.floating[z * cols + x]) return true;
      }
    }
    for (let z = kz * n; z <= kz * n + n; z++) {
      for (let x = kx * n; x <= kx * n + n; x++) {
        const i = z * this.vx + x;
        if (Math.abs(pd[i]! - this.holeDist[i]!) > 0.01) return true;
      }
    }
    return false;
  }

  private compute(): void {
    this.computeFloating();
    this.computeHoleDistance();
  }

  private computeFloating(): void {
    const { hm, def, holes } = this.data;
    const { cols, rows } = def;
    const grounded = new Uint8Array(cols * rows);
    const queue = new Int32Array(cols * rows);
    let head = 0;
    let tail = 0;
    const sea = def.waterLevel + 1;

    for (let cz = 0; cz < rows; cz++) {
      for (let cx = 0; cx < cols; cx++) {
        const i = cz * cols + cx;
        if (holes[i]) continue;
        const lo = Math.min(hm.vertex(cx, cz), hm.vertex(cx + 1, cz), hm.vertex(cx, cz + 1), hm.vertex(cx + 1, cz + 1));
        if (lo <= sea) {
          grounded[i] = 1;
          queue[tail++] = i;
        }
      }
    }
    while (head < tail) {
      const i = queue[head++]!;
      const cx = i % cols;
      const cz = (i - cx) / cols;
      const visit = (nx: number, nz: number): void => {
        if (nx < 0 || nz < 0 || nx >= cols || nz >= rows) return;
        const j = nz * cols + nx;
        if (grounded[j] || holes[j]) return;
        grounded[j] = 1;
        queue[tail++] = j;
      };
      visit(cx + 1, cz);
      visit(cx - 1, cz);
      visit(cx, cz + 1);
      visit(cx, cz - 1);
    }
    for (let i = 0; i < cols * rows; i++) this.floating[i] = holes[i] || grounded[i] ? 0 : 1;
  }

  /** Two-pass chamfer distance transform over vertices, seeded at void-cell corners. */
  private computeHoleDistance(): void {
    const { hm, def, holes } = this.data;
    const { cols, rows } = def;
    const W = this.vx;
    const H = rows + 1;
    const D = this.holeDist;
    const E = this.edgeHeight;
    D.fill(FAR);

    for (let cz = 0; cz < rows; cz++) {
      for (let cx = 0; cx < cols; cx++) {
        if (!holes[cz * cols + cx]) continue;
        for (const [vx, vz] of [[cx, cz], [cx + 1, cz], [cx, cz + 1], [cx + 1, cz + 1]] as const) {
          const i = vz * W + vx;
          D[i] = 0;
          E[i] = hm.vertex(vx, vz);
        }
      }
    }

    const relax = (i: number, j: number, w: number): void => {
      const d = D[j]! + w;
      if (d < D[i]!) {
        D[i] = d;
        E[i] = E[j]!;
      }
    };
    for (let z = 0; z < H; z++) {
      for (let x = 0; x < W; x++) {
        const i = z * W + x;
        if (x > 0) relax(i, i - 1, 1);
        if (z > 0) {
          relax(i, i - W, 1);
          if (x > 0) relax(i, i - W - 1, DIAG);
          if (x < W - 1) relax(i, i - W + 1, DIAG);
        }
      }
    }
    for (let z = H - 1; z >= 0; z--) {
      for (let x = W - 1; x >= 0; x--) {
        const i = z * W + x;
        if (x < W - 1) relax(i, i + 1, 1);
        if (z < H - 1) {
          relax(i, i + W, 1);
          if (x < W - 1) relax(i, i + W + 1, DIAG);
          if (x > 0) relax(i, i + W - 1, DIAG);
        }
      }
    }
  }
}
