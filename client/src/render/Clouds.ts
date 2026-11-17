import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { Region } from "@levi/shared";

/** Small deterministic PRNG so a region always gets the same clouds. */
function rng(seedText: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seedText.length; i++) h = Math.imul(h ^ seedText.charCodeAt(i), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

/**
 * Faceted cloud banks dressing every "sky" region: a ring below the island
 * (sells the height) and a few drifting above, kept clear of the island
 * itself. One merged mesh, one draw call.
 */
export class Clouds {
  readonly group = new THREE.Group();
  private readonly material = new THREE.MeshLambertMaterial({
    color: 0xffffff,
    emissive: 0x8a96a3,
    flatShading: true,
  });
  private mesh: THREE.Mesh | null = null;
  private t = 0;

  constructor() {
    this.group.name = "clouds";
  }

  rebuild(regions: readonly Region[]): void {
    if (this.mesh) {
      this.group.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh = null;
    }
    const parts: THREE.BufferGeometry[] = [];
    for (const r of regions) {
      if (r.kind !== "sky" || r.altitude === undefined) continue;
      const rand = rng(r.id);
      const { x0, z0, x1, z1 } = r.bounds;
      const cxm = (x0 + x1) / 2;
      const czm = (z0 + z1) / 2;
      const hw = (x1 - x0) / 2;
      const hd = (z1 - z0) / 2;
      const count = Math.min(90, Math.max(14, Math.round(((x1 - x0) + (z1 - z0)) / 9)));

      for (let i = 0; i < count; i++) {
        const angle = rand() * Math.PI * 2;
        const below = rand() < 0.72;
        // Ellipse just outside the region; clouds below may tuck further under.
        const ring = below ? 0.7 + rand() * 0.9 : 1.15 + rand() * 0.8;
        const px = cxm + Math.cos(angle) * hw * ring;
        const pz = czm + Math.sin(angle) * hd * ring;
        const py = below ? r.altitude - 18 - rand() * 40 : r.altitude + 14 + rand() * 30;
        const blobs = 3 + Math.floor(rand() * 4);
        const size = 3 + rand() * 6;
        for (let b = 0; b < blobs; b++) {
          const g = new THREE.IcosahedronGeometry(size * (0.55 + rand() * 0.6), 0);
          g.scale(1.4, 0.55, 1);
          g.rotateY(rand() * Math.PI);
          g.translate(px + (rand() - 0.5) * size * 2.6, py + (rand() - 0.5) * size * 0.5, pz + (rand() - 0.5) * size * 1.8);
          parts.push(g);
        }
      }
    }
    if (parts.length === 0) return;
    const merged = mergeGeometries(parts);
    for (const p of parts) p.dispose();
    if (!merged) return;
    this.mesh = new THREE.Mesh(merged, this.material);
    this.group.add(this.mesh);
  }

  /** Gentle bob so the sky feels alive. */
  update(dt: number): void {
    this.t += dt;
    this.group.position.y = Math.sin(this.t * 0.25) * 0.8;
  }

  dispose(): void {
    this.mesh?.geometry.dispose();
    this.material.dispose();
  }
}
