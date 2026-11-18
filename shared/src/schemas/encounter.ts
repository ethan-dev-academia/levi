import { z } from "zod";

const ID = /^[a-z0-9_-]+$/;
const id = z.string().regex(ID).max(64);
const n = z.number().finite();
const point = z.object({ x: n, z: n });

/** Which quest objective a beat of the encounter completes (and which step means "this beat is next"). */
const QuestHookSchema = z.object({ quest: id, step: id, objective: id });

export const ENCOUNTER_PHASES = ["crash", "fight", "rescue", "farewell"] as const;
export type EncounterPhase = (typeof ENCOUNTER_PHASES)[number];

export const BARK_SPEAKERS = ["falcon", "alpha", "you"] as const;
export type BarkSpeaker = (typeof BARK_SPEAKERS)[number];

/** A line that appears on its own at a moment of a phase (no clicking). */
export const BarkSchema = z.object({
  phase: z.enum(ENCOUNTER_PHASES),
  /** Seconds into the phase. */
  at: n.min(0),
  speaker: z.enum(BARK_SPEAKERS),
  text: z.string().min(1).max(300),
});

/**
 * A scripted story fight: cutscene beats, a bullet-hell boss, and the quest
 * steps each beat completes. The beats themselves (timings, patterns) live in
 * the encounter code; this file holds the places, numbers and lines.
 */
export const EncounterDefSchema = z.object({
  id,
  /** Enemy definition used for the boss (name, level, model, HP). */
  boss: id,
  /** Shown under the boss's name on the boss bar. */
  bossTitle: z.string().max(60).default(""),
  /** The placed NPC who takes part (hidden while the encounter plays it). */
  falconNpc: id,
  /** World flag set when the arena forms; arena props show while it's set. */
  arenaFlag: id,
  quests: z.object({
    crash: QuestHookSchema,
    fight: QuestHookSchema,
    rescue: QuestHookSchema,
    farewell: QuestHookSchema,
  }),
  /** The crash starts when you're this close to the lookout with its step active. */
  lookout: point,
  triggerRadius: n.min(1).max(60).default(14),
  /** Where the boss lands. */
  impact: point,
  arena: z.object({ x: n, z: n, radius: n.min(4).max(40) }),
  playerLand: point,
  falconLand: point,
  /** Where Falcon is thrown when the boss swats him aside. */
  falconRest: point,
  bossHome: point,
  /** HP at which Falcon dives in. */
  rescueHp: n.min(1).default(40),
  bulletDamage: n.min(0).default(8),
  /** Seconds of invulnerability after a bullet hits. */
  hitGrace: n.min(0).max(5).default(0.55),
  /** Where you wake after the teleport. */
  exit: point,
  exitMessage: z.string().max(300).default(""),
  speakers: z.object({ falcon: z.string(), alpha: z.string(), you: z.string() }).default({ falcon: "Falcon", alpha: "Alpha", you: "You" }),
  barks: z.array(BarkSchema).max(64).default([]),
});

export type Bark = z.infer<typeof BarkSchema>;
export type EncounterDef = z.infer<typeof EncounterDefSchema>;
