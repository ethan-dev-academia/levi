import type { Vec2 } from "../math/vec2.js";

/** Minimal moving-entity state on the 2D gameplay plane. */
export interface Mover {
  x: number;
  z: number;
  /** Remaining waypoints; index 0 is the current target. */
  path: Vec2[];
  /** Last non-zero movement direction (unit vector), for sprite facing. */
  dirX: number;
  dirZ: number;
}

/**
 * Advance a mover along its path by up to `maxDist` world units.
 * Pure 2D; runs identically on server (authoritative) and client (prediction).
 * Returns true while still moving.
 */
export function advanceAlongPath(m: Mover, maxDist: number): boolean {
  let remaining = maxDist;
  while (remaining > 0 && m.path.length > 0) {
    const target = m.path[0]!;
    const dx = target.x - m.x;
    const dz = target.z - m.z;
    const d = Math.hypot(dx, dz);
    if (d > 1e-6) {
      m.dirX = dx / d;
      m.dirZ = dz / d;
    }
    if (d <= remaining) {
      m.x = target.x;
      m.z = target.z;
      remaining -= d;
      m.path.shift();
    } else {
      m.x += (dx / d) * remaining;
      m.z += (dz / d) * remaining;
      remaining = 0;
    }
  }
  return m.path.length > 0;
}
