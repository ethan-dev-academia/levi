import { armourMultiplier } from "../progression/stats.js";

/** Shortest distance from point P to segment AB. */
export function distToSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / len2)) : 0;
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

export function inCircle(px: number, pz: number, cx: number, cz: number, r: number, pad = 0): boolean {
  return Math.hypot(px - cx, pz - cz) <= r + pad;
}

/** Inside a rectangle starting at (ox, oz), running `length` along (dx, dz), `width` wide. */
export function inLine(px: number, pz: number, ox: number, oz: number, dx: number, dz: number, length: number, width: number, pad = 0): boolean {
  const rx = px - ox;
  const rz = pz - oz;
  const along = rx * dx + rz * dz;
  const across = Math.abs(rx * -dz + rz * dx);
  return along >= -pad && along <= length + pad && across <= width / 2 + pad;
}

/** Inside a cone of half-angle `angleDeg` and radius `length` from (ox, oz) facing (dx, dz). */
export function inCone(px: number, pz: number, ox: number, oz: number, dx: number, dz: number, length: number, angleDeg: number, pad = 0): boolean {
  const rx = px - ox;
  const rz = pz - oz;
  const d = Math.hypot(rx, rz);
  if (d > length + pad) return false;
  if (d < 1e-6 || d <= pad) return true;
  const cos = (rx * dx + rz * dz) / d;
  return cos >= Math.cos((angleDeg * Math.PI) / 180) - pad / d;
}

export interface HitRoll {
  amount: number;
  crit: boolean;
}

/**
 * Final damage: base + share of a stat, maybe crit, then reduced by armour.
 * Always at least 1 so every hit registers.
 */
export function rollDamage(
  base: number,
  ratio: number,
  stat: number,
  critChance: number,
  critMultiplier: number,
  targetArmour: number,
  rand: () => number,
): HitRoll {
  const raw = base + ratio * stat;
  const crit = rand() * 100 < critChance;
  const amount = Math.max(1, Math.round(raw * (crit ? critMultiplier : 1) * armourMultiplier(targetArmour)));
  return { amount, crit };
}
