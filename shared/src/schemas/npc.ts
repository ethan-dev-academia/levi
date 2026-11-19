import { z } from "zod";
import { DISCIPLINES } from "../progression/disciplines.js";

const ID = /^[a-z0-9_-]+$/;
const id = z.string().regex(ID).max(64);
const HEX = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/**
 * Conditions gate dialogue entries and choices (and quest requirements use
 * the same building blocks). All conditions in a list must pass.
 */
export const ConditionSchema = z.discriminatedUnion("kind", [
  /** "started" = active or done; "notDone" = not started or still active. */
  z.object({ kind: z.literal("questStatus"), quest: id, status: z.enum(["notStarted", "active", "done", "started", "notDone"]) }),
  /** Quest is active and currently on this step. */
  z.object({ kind: z.literal("questStep"), quest: id, step: id }),
  z.object({ kind: z.literal("objectiveDone"), quest: id, objective: id }),
  z.object({ kind: z.literal("flag"), flag: id, set: z.boolean().default(true) }),
  z.object({ kind: z.literal("hasItem"), item: id, qty: z.number().int().min(1).max(1000).default(1) }),
  z.object({ kind: z.literal("coins"), min: z.number().int().min(0) }),
  /** "combat" = your highest combat style level. */
  z.object({ kind: z.literal("level"), skill: z.union([z.enum(DISCIPLINES), z.literal("combat")]), min: z.number().int().min(1).max(50) }),
]);

/** Things a dialogue line or choice can make happen (applied by the server). */
export const EffectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("startQuest"), quest: id }),
  /** Mark an objective complete (any kind: the generic "trigger"). */
  z.object({ kind: z.literal("objective"), quest: id, objective: id }),
  z.object({ kind: z.literal("giveItem"), item: id, qty: z.number().int().min(1).max(100).default(1) }),
  z.object({ kind: z.literal("takeItem"), item: id, qty: z.number().int().min(1).max(100).default(1) }),
  z.object({ kind: z.literal("coins"), amount: z.number().int().min(-1_000_000).max(1_000_000) }),
  z.object({ kind: z.literal("setFlag"), flag: id, value: z.boolean().default(true) }),
  /** Grant a secret skill. */
  z.object({ kind: z.literal("grantSkill"), style: z.enum(["ranger", "brawler", "mage"]), skill: id }),
]);

export const DialogueOptionSchema = z.object({
  text: z.string().min(1).max(200),
  /** Node to go to; null ends the conversation. */
  next: id.nullable(),
  /** Only offered when these pass. */
  when: z.array(ConditionSchema).default([]),
  effects: z.array(EffectSchema).default([]),
});

export const DialogueNodeSchema = z.object({
  id,
  speaker: z.enum(["npc", "player"]).default("npc"),
  text: z.string().min(1).max(600),
  /** Without options: where "next" goes (null = end). Ignored when options exist. */
  next: id.nullable().default(null),
  options: z.array(DialogueOptionSchema).max(6).default([]),
  /** Applied when this line is shown. */
  effects: z.array(EffectSchema).default([]),
  /**
   * While this line is shown, the camera pans out over the world to look at
   * this point (a city, a mountain...), then comes back when the line ends.
   */
  vista: z.object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() }).optional(),
  /** Editor layout only. */
  pos: z.object({ x: z.number(), y: z.number() }).optional(),
});

/** Ways into a conversation, tried top to bottom; the first whose conditions pass is used. */
export const DialogueEntrySchema = z.object({
  id,
  label: z.string().max(80).default(""),
  when: z.array(ConditionSchema).default([]),
  start: id,
});

export const NpcDefSchema = z
  .object({
    id,
    name: z.string().min(1).max(40),
    /** Shown under the name, e.g. "Warden of the Landing". */
    title: z.string().max(60).default(""),
    /**
     * Editor-only note telling apart the same person placed in different
     * spots ("Training Grounds"); players only see the name.
     */
    location: z.string().max(60).default(""),
    /**
     * Same person as another NPC: copy their model, palette and size. Each
     * placement still has its own id, dialogue and quests.
     */
    looksLike: id.optional(),
    model: id.default("humanoid"),
    /** Colour-slot overrides on the base body (skin, hair, top...). */
    palette: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/), HEX).default({}),
    scale: z.number().min(0.6).max(1.6).default(1),
    /** Things they say to no one in particular when you walk past (speech bubbles). */
    chatter: z.array(z.string().min(1).max(140)).max(12).default([]),
    entries: z.array(DialogueEntrySchema).max(40).default([]),
    nodes: z.array(DialogueNodeSchema).max(400).default([]),
  })
  .superRefine((n, ctx) => {
    const ids = new Set<string>();
    for (const node of n.nodes) {
      if (ids.has(node.id)) ctx.addIssue({ code: "custom", message: `duplicate node "${node.id}"` });
      ids.add(node.id);
    }
    const check = (to: string | null, where: string): void => {
      if (to !== null && !ids.has(to)) ctx.addIssue({ code: "custom", message: `${where}: no node "${to}"` });
    };
    for (const node of n.nodes) {
      check(node.next, `node ${node.id}`);
      node.options.forEach((o, i) => check(o.next, `node ${node.id} option ${i + 1}`));
    }
    for (const e of n.entries) check(e.start, `entry ${e.id}`);
  });

export type Condition = z.infer<typeof ConditionSchema>;
export type Effect = z.infer<typeof EffectSchema>;
export type DialogueOption = z.infer<typeof DialogueOptionSchema>;
export type DialogueNode = z.infer<typeof DialogueNodeSchema>;
export type DialogueEntry = z.infer<typeof DialogueEntrySchema>;
export type NpcDef = z.infer<typeof NpcDefSchema>;
