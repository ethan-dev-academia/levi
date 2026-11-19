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
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
  });
  private mesh: THREE.Mesh | null = null;
  private t = 0;
  /** Big clouds sailing slowly across the sky; they wrap around their area. */
  private drifters: Array<{ mesh: THREE.Mesh; speed: number; x0: number; x1: number; baseY: number; clear: number }> = [];
  private readonly templates: THREE.BufferGeometry[] = [];

  /** `ground` is the surface height under a point; clouds never sit on (or in) it. */
  constructor(private readonly ground: (x: number, z: number) => number) {
    this.group.name = "clouds";
  }

  /** Highest ground under a cloud of radius `r` centred at (x, z). */
  private groundUnder(x: number, z: number, r: number): number {
    let h = this.ground(x, z);
    for (let a = 0; a < 6; a++) {
      const t = (a / 6) * Math.PI * 2;
      h = Math.max(h, this.ground(x + Math.cos(t) * r, z + Math.sin(t) * r));
    }
    return h;
  }

  /** Would a static blob at height y touch the ground? (Ground far above it is a floating island's top: fine.) */
  private touches(x: number, y: number, z: number, r: number): boolean {
    const h = this.groundUnder(x, z, r);
    return h > y - r * 0.5 - 6 && h < y + 28;
  }

  /** A few cloud shapes the drifters share. */
  private template(i: number): THREE.BufferGeometry {
    while (this.templates.length <= i) {
      const rand = rng(`drift-${this.templates.length}`);
      const parts: THREE.BufferGeometry[] = [];
      const blobs = 5 + Math.floor(rand() * 5);
      for (let b = 0; b < blobs; b++) {
        const g = new THREE.IcosahedronGeometry(0.5 + rand() * 0.45, 0);
        g.scale(1.5, 0.5, 1);
        g.rotateY(rand() * Math.PI);
        g.translate((rand() - 0.5) * 2.8, (rand() - 0.5) * 0.35, (rand() - 0.5) * 1.6);
        parts.push(g);
      }
      this.templates.push(mergeGeometries(parts)!);
      for (const p of parts) p.dispose();
    }
    return this.templates[i]!;
  }

  rebuild(regions: readonly Region[]): void {
    if (this.mesh) {
      this.group.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh = null;
    }
    for (const d of this.drifters) this.group.remove(d.mesh);
    this.drifters = [];
    const parts: THREE.BufferGeometry[] = [];
    const drift = (r: Region, count: number, yLow: number, yHigh: number, margin: number, size: [number, number]): void => {
      const rand = rng(`${r.id}-drift`);
      const { x0, z0, x1, z1 } = r.bounds;
      for (let i = 0; i < count; i++) {
        const mesh = new THREE.Mesh(this.template(i % 8), this.material);
        const s = size[0] + rand() * (size[1] - size[0]);
        mesh.scale.set(s, s * (0.7 + rand() * 0.5), s * (0.8 + rand() * 0.5));
        mesh.rotation.y = (rand() - 0.5) * 0.6;
        const baseY = yLow + rand() * (yHigh - yLow);
        mesh.position.set(x0 - margin + rand() * (x1 - x0 + margin * 2), baseY, z0 - margin + rand() * (z1 - z0 + margin * 2));
        const d = { mesh, speed: 0.6 + rand() * 1.4, x0: x0 - margin, x1: x1 + margin, baseY, clear: s * 1.6 };
        mesh.position.y = this.drifterY(d);
        this.group.add(mesh);
        this.drifters.push(d);
      }
    };
    for (const r of regions) {
      if (r.kind !== "sky" || r.altitude === undefined) continue;
      const rand = rng(r.id);
      const { x0, z0, x1, z1 } = r.bounds;
      const cxm = (x0 + x1) / 2;
      const czm = (z0 + z1) / 2;
      const hw = (x1 - x0) / 2;
      const hd = (z1 - z0) / 2;
      const count = Math.min(260, Math.max(40, Math.round(((x1 - x0) + (z1 - z0)) / 3.5)));

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
          const bx = px + (rand() - 0.5) * size * 2.6, by = py + (rand() - 0.5) * size * 0.5, bz = pz + (rand() - 0.5) * size * 1.8;
          if (this.touches(bx, by, bz, size * 1.4)) {
            g.dispose();
            continue;
          }
          g.translate(bx, by, bz);
          parts.push(g);
        }
      }
      // A sea of cloud far below: the island floats over it.
      const seaCount = Math.round(((x1 - x0) + (z1 - z0)) / 4);
      for (let i = 0; i < seaCount; i++) {
        const px = cxm + (rand() - 0.5) * (x1 - x0 + 520);
        const pz = czm + (rand() - 0.5) * (z1 - z0 + 520);
        const py = r.altitude - 50 - rand() * 22;
        const size = 9 + rand() * 14;
        for (let b = 0; b < 3; b++) {
          const g = new THREE.IcosahedronGeometry(size * (0.6 + rand() * 0.5), 0);
          g.scale(1.6, 0.32, 1.2);
          g.rotateY(rand() * Math.PI);
          const bx = px + (rand() - 0.5) * size * 2, by = py + (rand() - 0.5) * 2, bz = pz + (rand() - 0.5) * size * 1.4;
          // The sea of cloud only fills open sky: never over land or water below.
          if (this.groundUnder(bx, bz, size * 1.6) > by - 8) {
            g.dispose();
            continue;
          }
          g.translate(bx, by, bz);
          parts.push(g);
        }
      }
      drift(r, 34, r.altitude + 32, r.altitude + 62, 160, [7, 15]);
    }
    // High weather drifting over the lands below.
    for (const r of regions) {
      if (r.kind !== "island") continue;
      const area = (r.bounds.x1 - r.bounds.x0) * (r.bounds.z1 - r.bounds.z0);
      drift(r, Math.min(160, Math.round(area / 18000)), 62, 110, 80, [10, 22]);
    }
    if (parts.length === 0) return;
    const merged = mergeGeometries(parts);
    for (const p of parts) p.dispose();
    if (!merged) return;
    this.mesh = new THREE.Mesh(merged, this.material);
    this.group.add(this.mesh);
  }

  /** A drifter's height here: its cruising height, lifted well clear of the land below. */
  private drifterY(d: { mesh: THREE.Mesh; baseY: number; clear: number }): number {
    const p = d.mesh.position;
    const h = this.groundUnder(p.x, p.z, d.clear * 1.5);
    // Ground far above (a floating island's top seen from below) doesn't count.
    return h > d.baseY + 40 ? d.baseY : Math.max(d.baseY, h + d.clear + 18);
  }

  /** Hide the high drifting clouds (a camera flying through them is just a white screen). */
  /** 1 = as normal, 0 = gone (a cutscene that wants the view). */
  setFade(f: number): void {
    this.material.opacity = 0.55 * f;
    this.group.visible = f > 0.01;
  }

  setDriftersVisible(v: boolean): void {
    for (const d of this.drifters) d.mesh.visible = v;
  }

  /** Gentle bob, and the drifters sail east on the wind. */
  update(dt: number): void {
    this.t += dt;
    if (this.mesh) this.mesh.position.y = Math.sin(this.t * 0.25) * 0.8;
    for (const d of this.drifters) {
      const p = d.mesh.position;
      p.x += d.speed * dt;
      if (p.x > d.x1) p.x = d.x0;
      // Rise over hills and mountains instead of sinking into them.
      const want = this.drifterY(d);
      p.y += (want - p.y) * Math.min(1, dt * 0.8);
    }
  }

  dispose(): void {
    this.mesh?.geometry.dispose();
    this.material.dispose();
  }
}
