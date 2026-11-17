import { z } from "zod";
import { DISCIPLINES } from "../progression/disciplines.js";

const ID = /^[a-z0-9_-]+$/;
const id = z.string().regex(ID).max(64);

/** Quest book sections. Act quests are the main story. */
export const QUEST_CATEGORIES = ["act", "skill", "world", "adventurer"] as const;
export type QuestCategory = (typeof QUEST_CATEGORIES)[number];

/**
 * One thing to do. Every objective has an id (for dialogue triggers and
 * progress) and a journal line.
 *  talk     – reach `node` in a conversation with `npc` (or finish any talk with them)
 *  defeat   – defeat `qty` of `enemy` (boss: a single named foe)
 *  collect  – hold `qty` of `item` (taken away when the step completes if `consume`)
 *  pickup   – pick `item` up off the ground (`qty` times)
 *  reach    – enter a map region
 *  use      – use a prop (chest, lever, sign...)
 *  trigger  – completed only by a dialogue/script effect
 */
const base = { id, text: z.string().min(1).max(200) };
export const ObjectiveSchema = z.discriminatedUnion("kind", [
  z.object({ ...base, kind: z.literal("talk"), npc: id, node: id.optional() }),
  z.object({ ...base, kind: z.literal("defeat"), enemy: id, qty: z.number().int().min(1).max(1000).default(1), boss: z.boolean().default(false) }),
  z.object({ ...base, kind: z.literal("collect"), item: id, qty: z.number().int().min(1).max(1000).default(1), consume: z.boolean().default(true) }),
  z.object({ ...base, kind: z.literal("pickup"), item: id, qty: z.number().int().min(1).max(1000).default(1) }),
  z.object({ ...base, kind: z.literal("reach"), region: id }),
  z.object({ ...base, kind: z.literal("use"), prop: id }),
  z.object({ ...base, kind: z.literal("trigger") }),
]);

export const QuestStepSchema = z.object({
  id,
  /** Journal entry while this step is active. */
  journal: z.string().max(800),
  /** All must be done to finish the step. */
  objectives: z.array(ObjectiveSchema).min(1).max(12),
});

export const QuestRequirementsSchema = z.object({
  quests: z.array(id).max(40).default([]),
  /** Highest of your three combat styles. */
  combatLevel: z.number().int().min(1).max(50).optional(),
  adventureLevel: z.number().int().min(1).max(50).optional(),
  skills: z.record(z.enum(DISCIPLINES), z.number().int().min(1).max(50)).default({}),
  flags: z.array(id).max(20).default([]),
});

export const QuestDefSchema = z
  .object({
    id,
    name: z.string().min(1).max(64),
    category: z.enum(QUEST_CATEGORIES).default("act"),
    /** Act number for act quests (0 = Falcon's Landing prologue). */
    act: z.number().int().min(0).max(20).default(0),
    summary: z.string().max(400).default(""),
    /** Where/who starts it (journal hint). */
    start: z.string().max(120).default(""),
    /** NPC who gives it (for the editor and journal). */
    giver: id.optional(),
    requirements: QuestRequirementsSchema.default({}),
    steps: z.array(QuestStepSchema).min(1).max(40),
    rewards: z
      .object({
        xp: z.record(z.enum(DISCIPLINES), z.number().int().min(1).max(1_000_000)).default({}),
        coins: z.number().int().min(0).max(10_000_000).default(0),
        items: z.array(z.object({ item: id, qty: z.number().int().min(1).max(100) })).default([]),
        /** Secret skills granted on completion. */
        skills: z.array(z.object({ style: z.enum(["ranger", "brawler", "mage"]), skill: id })).default([]),
        /** World flags set on completion (unlock regions, NPC lines, shops...). */
        unlocks: z.array(id).default([]),
      })
      .default({}),
    scriptHook: id.optional(),
  })
  .superRefine((q, ctx) => {
    const steps = new Set<string>();
    const objs = new Set<string>();
    for (const s of q.steps) {
      if (steps.has(s.id)) ctx.addIssue({ code: "custom", message: `duplicate step "${s.id}"` });
      steps.add(s.id);
      for (const o of s.objectives) {
        if (objs.has(o.id)) ctx.addIssue({ code: "custom", message: `duplicate objective "${o.id}"` });
        objs.add(o.id);
      }
    }
    if (q.requirements.quests.includes(q.id)) ctx.addIssue({ code: "custom", message: "a quest can't require itself" });
  });

export type Objective = z.infer<typeof ObjectiveSchema>;
export type QuestStep = z.infer<typeof QuestStepSchema>;
export type QuestRequirements = z.infer<typeof QuestRequirementsSchema>;
export type QuestDef = z.infer<typeof QuestDefSchema>;
