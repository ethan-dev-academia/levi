/**
 * Every levelled skill ("discipline"). Combat styles also define your class
 * for the moment: the style of the weapon you hold.
 */
export const COMBAT_STYLES = ["ranger", "brawler", "mage"] as const;
export type CombatStyle = (typeof COMBAT_STYLES)[number];

export const PEACEFUL_SKILLS = ["cooking", "fishing", "smithing", "mining", "crafting", "gathering"] as const;
export type PeacefulSkill = (typeof PEACEFUL_SKILLS)[number];

export const DISCIPLINES = [...COMBAT_STYLES, ...PEACEFUL_SKILLS, "dungeoneering", "adventuring"] as const;
export type Discipline = (typeof DISCIPLINES)[number];

/** Which general-XP pool may be spent on a discipline (dungeoneering takes both). */
export type XpGroup = "combat" | "peaceful";
export function acceptsGroup(d: Discipline, group: XpGroup): boolean {
  if (d === "adventuring") return false; // quests only
  if (d === "dungeoneering") return true;
  return group === "combat" ? (COMBAT_STYLES as readonly string[]).includes(d) : (PEACEFUL_SKILLS as readonly string[]).includes(d);
}

export const DISCIPLINE_NAMES: Readonly<Record<Discipline, string>> = {
  ranger: "Ranger", brawler: "Brawler", mage: "Mage",
  cooking: "Cooking", fishing: "Fishing", smithing: "Smithing", mining: "Mining", crafting: "Crafting", gathering: "Gathering",
  dungeoneering: "Dungeoneering",
  adventuring: "Adventuring",
};

export const MAX_LEVEL = 50;

/** Levels at which a combat style's skill tree offers a new tier. */
export const SKILL_MILESTONES = [1, 2, 3, 5, 10, 20, 30, 40, 50] as const;

/**
 * Total XP needed to reach `level` (level 1 = 0). Gentle exponential:
 * early levels come in minutes, 50 is a long-term goal (~245k XP).
 */
const XP_TABLE: readonly number[] = (() => {
  const t = [0, 0];
  let points = 0;
  for (let l = 1; l < MAX_LEVEL; l++) {
    points += Math.floor(l * 20 + 120 * 2 ** (l / 8));
    t.push(points);
  }
  return t;
})();

export function xpForLevel(level: number): number {
  return XP_TABLE[Math.max(1, Math.min(MAX_LEVEL, level))]!;
}

export function levelForXp(xp: number): number {
  let lvl = 1;
  while (lvl < MAX_LEVEL && xp >= XP_TABLE[lvl + 1]!) lvl++;
  return lvl;
}

/** Progress through the current level, 0..1 (1 at max level). */
export function levelProgress(xp: number): number {
  const l = levelForXp(xp);
  if (l >= MAX_LEVEL) return 1;
  const a = XP_TABLE[l]!;
  const b = XP_TABLE[l + 1]!;
  return (xp - a) / (b - a);
}

/** Skill-tree tiers available at a level. */
export function tiersReached(level: number): number[] {
  return SKILL_MILESTONES.filter((m) => m <= level);
}

// --- Adventuring: quest-only XP, quick curve, soft caps -----------------------------

/** Adventuring levels come quicker than other skills. */
export const ADVENTURE_CURVE_SCALE = 0.35;

/**
 * A soft cap: past `level`, until every quest in `quests` is done, each level
 * costs `penalty`× the usual XP. XP is always banked, so finishing the quests
 * applies the normal curve to everything you earned.
 */
export interface AdventureCap {
  level: number;
  quests: readonly string[];
  penalty: number;
}

/** Level for adventuring XP given the caps still in force. */
export function adventureLevelForXp(xp: number, caps: readonly AdventureCap[]): number {
  const scale = ADVENTURE_CURVE_SCALE;
  const active = [...caps].sort((a, b) => a.level - b.level)[0];
  let lvl = 1;
  while (lvl < MAX_LEVEL) {
    const next = lvl + 1;
    let need = XP_TABLE[next]! * scale;
    if (active && next > active.level) {
      const atCap = XP_TABLE[active.level]! * scale;
      need = atCap + (need - atCap) * active.penalty;
    }
    if (xp < need) break;
    lvl = next;
  }
  return lvl;
}

/** Your combat level: the highest of the three combat styles. */
export function combatLevel(levels: Readonly<Record<CombatStyle, number>>): number {
  return Math.max(levels.ranger, levels.brawler, levels.mage);
}
