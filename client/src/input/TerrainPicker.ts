import * as THREE from "three";
import { clamp, getTerrainHeight, type Heightmap, type Vec2 } from "@levi/shared";

const STEP = 0.25;
const MAX_DIST = 400;
const REFINE_ITERS = 10;

/**
 * Screen → ground (X, Z) by marching the camera ray against the shared
 * height function. Mesh-independent, so it stays correct while sculpting.
 */
export class TerrainPicker {
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private readonly p = new THREE.Vector3();

  constructor(
    private readonly camera: THREE.Camera,
    private readonly hm: Heightmap,
  ) {}

  /** ndc in [-1, 1]. Returns null if the ray never meets the terrain. */
  pick(ndcX: number, ndcY: number): Vec2 | null {
    this.ndc.set(ndcX, ndcY);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const { origin, direction } = this.raycaster.ray;

    const above = (t: number): boolean => {
      this.p.copy(direction).multiplyScalar(t).add(origin);
      return this.p.y > getTerrainHeight(this.hm, this.p.x, this.p.z);
    };
    if (!above(0)) return null;

    let lo = 0;
    let hi = -1;
    for (let t = STEP; t <= MAX_DIST; t += STEP) {
      if (!above(t)) { hi = t; break; }
      lo = t;
    }
    if (hi < 0) return null;

    for (let i = 0; i < REFINE_ITERS; i++) {
      const mid = (lo + hi) / 2;
      if (above(mid)) lo = mid; else hi = mid;
    }
    this.p.copy(direction).multiplyScalar(hi).add(origin);
    return {
      x: clamp(this.p.x, 0, this.hm.width),
      z: clamp(this.p.z, 0, this.hm.depth),
    };
  }
}
