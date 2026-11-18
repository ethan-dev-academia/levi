import { z } from "zod";
import { COMBAT_STYLES, SKILL_MILESTONES } from "../progression/disciplines.js";

const ID = /^[a-z0-9_-]+$/;

/**
 * How a skill behaves. Parameters are data so designers can tune them; the
 * combat system (next step) interprets each `kind`.
 */
export const CastSchema = z.object({
  kind: z.enum(["basic", "line", "multi", "cone", "circle", "charge", "shield", "dash", "buff", "aura", "summon", "sprint"]),
  /** World units. */
  range: z.number().min(0).max(40).default(0),
  width: z.number().min(0).max(10).default(0),
  radius: z.number().min(0).max(15).default(0),
  /** Cone half-angle in degrees. */
  angle: z.number().min(0).max(180).default(0),
  /** Projectiles / hits / pulses. */
  count: z.number().int().min(1).max(30).default(1),
  /** Base damage plus a share of attack or magic damage. */
  damage: z.number().min(0).max(10000).default(0),
  scaling: z.enum(["attack", "magic", "none"]).default("none"),
  ratio: z.number().min(0).max(10).default(0),
  /** Line skillshots: keep going through every enemy (melee sweeps). */
  pierce: z.boolean().default(false),
  /** Shield absorb / buff strength (sprint: % faster). */
  amount: z.number().min(0).max(10000).default(0),
  /** Seconds (charge time, buff duration...). */
  duration: z.number().min(0).max(60).default(0),
});

export const SkillDefSchema = z.object({
  id: z.string().regex(ID).max(64),
  name: z.string().min(1).max(48),
  /** Level milestone (tier) this node sits on. */
  tier: z.number().int().refine((t) => (SKILL_MILESTONES as readonly number[]).includes(t), "tier must be a skill milestone"),
  /** Any one of these must be unlocked first (default: any node of the previous tier). */
  requires: z.array(z.string().regex(ID)).default([]),
  /** Resource cost: mages spend mana, rangers/brawlers spend energy. */
  cost: z.number().min(0).max(1000).default(0),
  cooldown: z.number().min(0).max(600).default(0),
  cast: CastSchema,
  description: z.string().max(300),
  /** Short flavour line. */
  lore: z.string().max(200).default(""),
});

/** A secret skill has no tier; it's granted, never bought. */
export const SecretSkillSchema = SkillDefSchema.extend({ tier: z.number().int().min(0).max(0).default(0) });

/** content/skills/<style>.json: one tree per combat style. */
export const SkillTreeSchema = z
  .object({
    style: z.enum(COMBAT_STYLES),
    name: z.string().min(1).max(48),
    /** Short description of the path. */
    blurb: z.string().max(300).default(""),
    skills: z.array(SkillDefSchema).min(1).max(64),
    /**
     * Secret skills: outside the level tree, granted by quests (usually Act
     * boss kills). Players see "???" until they have one.
     */
    secrets: z.array(SecretSkillSchema).max(32).default([]),
  })
  .superRefine((t, ctx) => {
    const ids = new Set<string>();
    for (const s of t.skills) {
      if (ids.has(s.id)) ctx.addIssue({ code: "custom", message: `duplicate skill "${s.id}"` });
      ids.add(s.id);
    }
    const first = t.skills.filter((s) => s.tier === 1);
    if (first.length !== 1 || first[0]!.cast.kind !== "line") ctx.addIssue({ code: "custom", message: "tier 1 must be exactly one line skillshot" });
    for (const s of t.secrets) {
      if (ids.has(s.id)) ctx.addIssue({ code: "custom", message: `secret "${s.id}" reuses an id` });
      ids.add(s.id);
    }
    for (const s of t.skills) {
      const prevTier = SKILL_MILESTONES[SKILL_MILESTONES.indexOf(s.tier as (typeof SKILL_MILESTONES)[number]) - 1];
      for (const r of s.requires) {
        const req = t.skills.find((x) => x.id === r);
        if (!req) ctx.addIssue({ code: "custom", message: `${s.id}: unknown requirement "${r}"` });
        else if (req.tier !== prevTier) ctx.addIssue({ code: "custom", message: `${s.id}: "${r}" is not on the previous tier` });
      }
    }
  });

/**
 * Adventuring skills: usable whatever weapon you hold (sprint...). `tier` is
 * the Adventuring level that unlocks it. Costs come out of your current pool
 * (mana for mages, energy otherwise). Listed in content/progression/adventuring.json.
 */
export const AdventuringSkillSchema = SkillDefSchema.extend({
  tier: z.number().int().min(1).max(60),
  /** Key it starts on for new heroes (and once for existing ones). */
  defaultKey: z.enum(["Q", "W", "E", "R", "D", "F"]).optional(),
});
export type AdventuringSkill = z.infer<typeof AdventuringSkillSchema>;
export type Cast = z.infer<typeof CastSchema>;
export type SkillDef = z.infer<typeof SkillDefSchema>;
export type SkillTree = z.infer<typeof SkillTreeSchema>;
