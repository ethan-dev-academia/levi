import * as THREE from "three";
import type { MapData, WalkGrid } from "@levi/shared";
import { cellColor } from "./terrainPalette.js";
import { CHUNK_CELLS } from "./TerrainMesh.js";

/** Cells per horizon quad (divides a chunk, so seams line up with chunk edges). */
const STRIDE = 4;
/** Next to the detailed chunks it dips this far, so it never pokes through them. */
const SINK = 0.6;

/**
 * The whole map as one coarse mesh, drawn past the detailed chunks so the
 * land reaches the horizon (and a cutscene can look across a continent).
 * Open sea, voids and sky islands are left out; inside the ring of detailed
 * chunks the shader cuts it away.
 */
export class HorizonTerrain {
  readonly mesh: THREE.Mesh;
  private readonly inner = new THREE.Vector4(0, 0, 0, 0);
  private readonly inner2 = new THREE.Vector4(0, 0, 0, 0);

  constructor(data: MapData, walk: WalkGrid) {
    const { hm, def } = data;
    const nx = Math.floor(def.cols / STRIDE);
    const nz = Math.floor(def.rows / STRIDE);
    const vx = nx + 1;
    const pos = new Float32Array(vx * (nz + 1) * 3);
    const col = new Float32Array(vx * (nz + 1) * 3);
    const c = new THREE.Color();
    for (let j = 0; j <= nz; j++) {
      for (let i = 0; i <= nx; i++) {
        const k = (j * vx + i) * 3;
        const gx = i * STRIDE;
        const gz = j * STRIDE;
        pos[k] = gx * def.cellSize;
        pos[k + 1] = hm.vertex(gx, gz);
        pos[k + 2] = gz * def.cellSize;
        cellColor(data, walk, Math.min(def.cols - 1, gx), Math.min(def.rows - 1, gz), c);
        col[k] = c.r;
        col[k + 1] = c.g;
        col[k + 2] = c.b;
      }
    }
    const sky = def.regions.filter((r) => r.kind === "sky");
    const index: number[] = [];
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const cx = i * STRIDE + STRIDE / 2;
        const cz = j * STRIDE + STRIDE / 2;
        if (sky.some((r) => cx >= r.bounds.x0 && cx < r.bounds.x1 && cz >= r.bounds.z0 && cz < r.bounds.z1)) continue;
        if (data.isHole(cx, cz)) continue;
        const a = j * vx + i, b = a + 1, d = a + vx, e = d + 1;
        const top = Math.max(pos[a * 3 + 1]!, pos[b * 3 + 1]!, pos[d * 3 + 1]!, pos[e * 3 + 1]!);
        if (top < def.waterLevel - 3) continue; // deep sea: the water plane covers it (shallows stay, so coasts are smooth)
        index.push(a, d, b, e, b, d);
      }
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geom.setAttribute("color", new THREE.BufferAttribute(col, 3));
    geom.setIndex(index);
    geom.computeBoundingSphere();

    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    const inner = this.inner;
    const inner2 = this.inner2;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms["uInner"] = { value: inner };
      shader.uniforms["uInner2"] = { value: inner2 };
      shader.vertexShader = shader.vertexShader
        .replace(
          "void main() {",
          "varying vec2 vHzXZ;\nuniform vec4 uInner;\nuniform vec4 uInner2;\n" +
            "float hzOut(vec4 r, vec2 p) { vec2 d = max(r.xy - p, p - r.zw); return max(d.x, d.y); }\nvoid main() {",
        )
        .replace(
          "#include <begin_vertex>",
          "#include <begin_vertex>\n  vHzXZ = (modelMatrix * vec4(transformed, 1.0)).xz;\n" +
            // Dip only next to the detailed ground (fading out over 48 units), so the far land sits true.
            `  float hzNear = min(hzOut(uInner, vHzXZ), hzOut(uInner2, vHzXZ));\n  transformed.y -= ${SINK.toFixed(2)} * (1.0 - smoothstep(0.0, 48.0, hzNear));`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "void main() {",
          "uniform vec4 uInner;\nuniform vec4 uInner2;\nvarying vec2 vHzXZ;\n" +
            "bool hzIn(vec4 r) { return vHzXZ.x > r.x && vHzXZ.x < r.z && vHzXZ.y > r.y && vHzXZ.y < r.w; }\n" +
            "void main() {\n  if (hzIn(uInner) || hzIn(uInner2)) discard;",
        );
    };
    this.mesh = new THREE.Mesh(geom, mat);
    this.mesh.name = "horizon";
    this.mesh.frustumCulled = false;
  }

  /** Cut holes where the detailed terrain is built: `ring` chunks around each focus chunk (-1 = none). Up to two. */
  update(holes: ReadonlyArray<{ x: number; z: number; ring: number }>, cellSize: number): void {
    const size = CHUNK_CELLS * cellSize;
    [this.inner, this.inner2].forEach((v, i) => {
      const h = holes[i];
      if (!h || h.ring < 0) {
        v.set(0, 0, 0, 0);
        return;
      }
      const fx = Math.floor(h.x / size);
      const fz = Math.floor(h.z / size);
      v.set((fx - h.ring) * size, (fz - h.ring) * size, (fx + h.ring + 1) * size, (fz + h.ring + 1) * size);
    });
  }
}
