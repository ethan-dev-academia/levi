import * as THREE from "three";

const SEGMENTS = 72;

/** Terrain-hugging circle showing the brush footprint. */
export class BrushCursor {
  readonly line: THREE.LineLoop<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  private readonly positions = new Float32Array(SEGMENTS * 3);

  constructor() {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(this.positions, 3));
    this.line = new THREE.LineLoop(geom, new THREE.LineBasicMaterial({ color: 0xffe14a, fog: false, depthTest: false }));
    this.line.renderOrder = 10;
    this.line.frustumCulled = false;
    this.line.visible = false;
  }

  setColor(hex: number): void {
    this.line.material.color.setHex(hex);
  }

  /** `heightAt` should return the visible surface (water level over void). */
  update(heightAt: (x: number, z: number) => number, x: number, z: number, radius: number): void {
    const p = this.positions;
    for (let i = 0; i < SEGMENTS; i++) {
      const a = (i / SEGMENTS) * Math.PI * 2;
      const px = x + Math.cos(a) * radius;
      const pz = z + Math.sin(a) * radius;
      p[i * 3] = px;
      p[i * 3 + 1] = heightAt(px, pz) + 0.08;
      p[i * 3 + 2] = pz;
    }
    this.line.geometry.attributes["position"]!.needsUpdate = true;
    this.line.visible = true;
  }

  hide(): void {
    this.line.visible = false;
  }
}
