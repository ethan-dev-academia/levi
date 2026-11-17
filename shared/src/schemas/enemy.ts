import { z } from "zod";

const ID = /^[a-z0-9_-]+$/;
const id = z.string().regex(ID).max(64);
const HEX = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/**
 * An enemy attack is never an instant hit: it marks an area on the ground
 * (red), waits `windup` seconds, then strikes whoever is still inside.
 *  circle on "target": lands where the player stood when it started (wide area)
 *  circle on "self":   around the enemy (close area / slam)
 *  line / cone:        from the enemy toward the player
 */
export const EnemyAttackSchema = z.object({
  id,
  name: z.string().min(1).max(40),
  shape: z.enum(["circle", "line", "cone"]),
  /** Where a circle is centred. Lines and cones always start at the enemy. */
  anchor: z.enum(["target", "self"]).default("self"),
  /** Starts the attack when the player is this close (world units). */
  range: z.number().min(0.5).max(30).default(2),
  radius: z.number().min(0.3).max(15).default(1.5),
  length: z.number().min(0.5).max(30).default(4),
  width: z.number().min(0.2).max(10).default(1.2),
  /** Cone half-angle, degrees. */
  angle: z.number().min(5).max(180).default(40),
  windup: z.number().min(0.2).max(10).default(1),
  damage: z.number().min(0).max(100000).default(5),
  cooldown: z.number().min(0).max(120).default(3),
  /**
   * During the windup: "fixed"/"auto" = committed, locked where it started
   * (default); "follow" = the enemy keeps chasing and the area moves with it.
   */
  tracking: z.enum(["auto", "follow", "fixed"]).default("auto"),
});

/**
 * Attacks commit: once the red area appears it stays where it started and
 * the enemy holds still until it strikes. Only "follow" (opt-in) tracks.
 */
export function attackFollows(a: { tracking: "auto" | "follow" | "fixed" }): boolean {
  return a.tracking === "follow";
}

export const EnemyDefSchema = z.object({
  id,
  name: z.string().min(1).max(40),
  level: z.number().int().min(1).max(200).default(1),
  /** Body model (humanoid, enemy-rat, ...) and its colour overrides. */
  model: id.default("humanoid"),
  palette: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/), HEX).default({}),
  scale: z.number().min(0.2).max(4).default(1),
  stats: z
    .object({
      maxHp: z.number().min(1).max(1_000_000).default(30),
      armour: z.number().min(0).max(10000).default(0),
      /** World units per second. */
      moveSpeed: z.number().min(0).max(20).default(3),
    })
    .default({}),
  /** Notices you within this distance. */
  aggroRange: z.number().min(0).max(40).default(6),
  /** Gives up and goes home if you get this far from its spot. */
  leashRange: z.number().min(1).max(80).default(16),
  attacks: z.array(EnemyAttackSchema).max(8).default([]),
  /** XP for the kill, given to the combat style of the killing blow. */
  xp: z.number().int().min(0).max(1_000_000).default(10),
  /** Seconds until it comes back after dying. */
  respawn: z.number().min(1).max(3600).default(20),
  /** Training dummy: never moves, attacks or dies; gives a little XP per hit. */
  dummy: z.boolean().default(false),
});

export type EnemyAttack = z.infer<typeof EnemyAttackSchema>;
export type EnemyDef = z.infer<typeof EnemyDefSchema>;
