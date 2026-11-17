import * as THREE from "three";
import { getTerrainHeight, type Heightmap, type Region } from "@levi/shared";

const STEP = 2;

/** Dashed-looking, terrain-hugging outlines of every region (dev only). */
export class RegionOverlay {
  readonly group = new THREE.Group();
  private readonly regionMat = new THREE.LineBasicMaterial({ color: 0xb89cff, fog: false, depthTest: false });
  private readonly previewMat = new THREE.LineBasicMaterial({ color: 0xffe14a, fog: false, depthTest: false });
  private preview: THREE.LineLoop | null = null;

  constructor(
    private readonly hm: Heightmap,
    private readonly waterLevel: () => number,
  ) {
    this.group.renderOrder = 9;
    this.group.visible = false;
  }

  private outline(b: Region["bounds"], mat: THREE.LineBasicMaterial): THREE.LineLoop {
    const pts: number[] = [];
    const push = (x: number, z: number): void => {
      pts.push(x, Math.max(getTerrainHeight(this.hm, x, z), this.waterLevel()) + 0.4, z);
    };
    for (let x = b.x0; x < b.x1; x += STEP) push(x, b.z0);
    for (let z = b.z0; z < b.z1; z += STEP) push(b.x1, z);
    for (let x = b.x1; x > b.x0; x -= STEP) push(x, b.z1);
    for (let z = b.z1; z > b.z0; z -= STEP) push(b.x0, z);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    const line = new THREE.LineLoop(g, mat);
    line.frustumCulled = false;
    line.renderOrder = 9;
    return line;
  }

  rebuild(regions: readonly Region[]): void {
    for (const child of [...this.group.children]) {
      if (child === this.preview) continue;
      this.group.remove(child);
      (child as THREE.LineLoop).geometry.dispose();
    }
    for (const r of regions) this.group.add(this.outline(r.bounds, this.regionMat));
  }

  setPreview(bounds: Region["bounds"] | null): void {
    if (this.preview) {
      this.group.remove(this.preview);
      this.preview.geometry.dispose();
      this.preview = null;
    }
    if (bounds && bounds.x1 > bounds.x0 && bounds.z1 > bounds.z0) {
      this.preview = this.outline(bounds, this.previewMat);
      this.group.add(this.preview);
    }
  }
}
