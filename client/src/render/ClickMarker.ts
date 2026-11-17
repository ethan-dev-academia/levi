import * as THREE from "three";
import type { Heightmap } from "@levi/shared";
import { placeOnGround } from "./terrainAlign.js";

const LIFETIME = 0.45;

/** Ground ring that pops and shrinks where the player right-clicks to move. */
export class ClickMarker {
  readonly mesh: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  private age = LIFETIME;

  constructor() {
    const geom = new THREE.RingGeometry(0.3, 0.42, 20);
    geom.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(
      geom,
      new THREE.MeshBasicMaterial({ color: 0xffe14a, transparent: true, depthWrite: false, fog: false }),
    );
    this.mesh.visible = false;
  }

  /** On the terrain, or flat at `y` (building floors). */
  show(hm: Heightmap, x: number, z: number, y?: number): void {
    if (y === undefined) placeOnGround(this.mesh, hm, x, z, 0.06);
    else {
      this.mesh.position.set(x, y + 0.06, z);
      this.mesh.quaternion.identity();
    }
    this.age = 0;
    this.mesh.visible = true;
  }

  update(dt: number): void {
    if (!this.mesh.visible) return;
    this.age += dt;
    const t = this.age / LIFETIME;
    if (t >= 1) {
      this.mesh.visible = false;
      return;
    }
    const s = 1.4 - t * 0.8;
    this.mesh.scale.set(s, 1, s);
    this.mesh.material.opacity = 1 - t * t;
  }
}
