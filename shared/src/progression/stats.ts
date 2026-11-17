import { z } from "zod";

/**
 * Character stats. Base values never grow with level: power comes from gear
 * and talismans, so every style starts as a fresh adventure.
 */
export const STAT_KEYS = [
  "maxHp", "maxMana", "maxEnergy",
  "hpRegen", "manaRegen", "energyRegen",
  "armour", "attackDamage", "magicDamage",
  "critChance", "critMultiplier", "cooldownReduction",
] as const;
export type StatKey = (typeof STAT_KEYS)[number];
export type Stats = Record<StatKey, number>;

/** Partial stat bonuses on an item. */
export const StatBlockSchema = z.object(
  Object.fromEntries(STAT_KEYS.map((k) => [k, z.number().finite().min(-10000).max(10000).optional()])) as Record<
    StatKey,
    z.ZodOptional<z.ZodNumber>
  >,
);
export type StatBlock = { [K in StatKey]?: number | undefined };

export const BASE_STATS: Readonly<Stats> = {
  maxHp: 100, maxMana: 100, maxEnergy: 100,
  hpRegen: 1, manaRegen: 2, energyRegen: 4, // per second
  armour: 0, attackDamage: 0, magicDamage: 0,
  critChance: 5, critMultiplier: 1.5, cooldownReduction: 0,
};

/** Hard caps so stacking gear can't break combat. */
const CAPS: Partial<Stats> = { critChance: 75, cooldownReduction: 40 };

export const STAT_LABELS: Readonly<Record<StatKey, string>> = {
  maxHp: "Max health", maxMana: "Max mana", maxEnergy: "Max energy",
  hpRegen: "Health regen /s", manaRegen: "Mana regen /s", energyRegen: "Energy regen /s",
  armour: "Armour", attackDamage: "Attack damage", magicDamage: "Magic damage",
  critChance: "Crit chance %", critMultiplier: "Crit multiplier", cooldownReduction: "Cooldown reduction %",
};

/** Base + every equipped bonus, clamped. */
export function sumStats(bonuses: readonly StatBlock[]): Stats {
  const out = { ...BASE_STATS };
  for (const b of bonuses) for (const k of STAT_KEYS) out[k] += b[k] ?? 0;
  for (const k of STAT_KEYS) {
    const cap = CAPS[k];
    if (cap !== undefined) out[k] = Math.min(cap, out[k]);
    if (k.startsWith("max")) out[k] = Math.max(1, out[k]);
    else out[k] = Math.max(k === "critMultiplier" ? 1 : 0, out[k]);
  }
  return out;
}

/** Fraction of incoming damage that gets through armour (never zero: you can only take so many hits). */
export function armourMultiplier(armour: number): number {
  return 100 / (100 + Math.max(0, armour));
}
