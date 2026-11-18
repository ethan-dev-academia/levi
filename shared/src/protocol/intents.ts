import { z } from "zod";
import { COMBAT_STYLES, DISCIPLINES } from "../progression/disciplines.js";
import { EQUIP_SLOTS } from "../schemas/item.js";
import { PLAYER_NAME } from "../schemas/player.js";
import { ABILITY_SLOTS, type ItemSlot } from "./constants.js";

/**
 * Client → server messages. Clients send ONLY intent; the server owns
 * positions, cooldowns, damage and loot. Every inbound message is parsed
 * with IntentSchema before it reaches any system.
 */
const coord = z.number().finite().min(-1e5).max(1e5);

export const MoveIntentSchema = z.object({
  type: z.literal("move"),
  targetX: coord,
  targetZ: coord,
});

export const StopIntentSchema = z.object({ type: z.literal("stop") });

export const CastIntentSchema = z.object({
  type: z.literal("cast"),
  slot: z.enum(ABILITY_SLOTS),
  aimX: coord,
  aimZ: coord,
  /** Optional hovered entity for targeted abilities; server re-validates range/visibility. */
  targetId: z.string().max(64).optional(),
});

/** Auto-attack an enemy (by its spawn id): walk into range, then keep swinging. */
/** Spawn ids, plus zone mobs ("zone-id#3"). */
export const AttackIntentSchema = z.object({ type: z.literal("attack"), enemy: z.string().regex(/^[a-z0-9_-]+(#\d+)?$/).max(80) });

export const UseItemIntentSchema = z.object({
  type: z.literal("useItem"),
  slot: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
}) satisfies z.ZodType<{ type: "useItem"; slot: ItemSlot }>;

/**
 * Climb a building's stairs/ladder one storey. `dir` is a preference (which
 * half was clicked); the server picks the direction actually possible from
 * the player's storey and walks them there first.
 */
export const ClimbIntentSchema = z.object({
  type: z.literal("climb"),
  building: z.string().regex(/^[a-z0-9_-]+$/).max(64),
  stair: z.string().regex(/^[a-z0-9_-]+$/).max(64),
  dir: z.enum(["up", "down"]),
});

/** A bag / hotbar / equipment slot. */
export const SlotRefSchema = z.discriminatedUnion("area", [
  z.object({ area: z.literal("inv"), index: z.number().int().min(0).max(19) }),
  z.object({ area: z.literal("hot"), index: z.number().int().min(0).max(3) }),
  z.object({ area: z.literal("eq"), slot: z.enum(EQUIP_SLOTS) }),
]);
const SKILL_ID = z.string().regex(/^[a-z0-9_-]+$/).max(64);

export const MoveItemIntentSchema = z.object({ type: z.literal("moveItem"), from: SlotRefSchema, to: SlotRefSchema });
export const EquipIntentSchema = z.object({ type: z.literal("equip"), from: SlotRefSchema });
export const UnequipIntentSchema = z.object({ type: z.literal("unequip"), slot: z.enum(EQUIP_SLOTS) });
/** Use whatever is in a slot; tomes also name the discipline to train. */
export const UseSlotIntentSchema = z.object({ type: z.literal("useSlot"), from: SlotRefSchema, discipline: z.enum(DISCIPLINES).optional() });
export const UnlockSkillIntentSchema = z.object({ type: z.literal("unlockSkill"), style: z.enum(COMBAT_STYLES), skill: SKILL_ID });
export const ResetSkillsIntentSchema = z.object({ type: z.literal("resetSkills"), style: z.enum(COMBAT_STYLES) });
export const SetLoadoutIntentSchema = z.object({
  type: z.literal("setLoadout"), style: z.enum(COMBAT_STYLES), key: z.enum(ABILITY_SLOTS), skill: SKILL_ID.nullable(),
});
/** Take loot from a container prop (index -1 = take all). Server checks you're next to it. */
export const LootTakeIntentSchema = z.object({
  type: z.literal("lootTake"),
  prop: z.string().regex(/^[a-z0-9_-]+$/).max(64),
  index: z.number().int().min(-1).max(19),
});

const NPC_SPAWN = z.string().regex(/^[a-z0-9_-]+$/).max(64);
/** Start talking to an NPC (server checks you're next to it). */
export const TalkIntentSchema = z.object({ type: z.literal("talk"), npc: NPC_SPAWN });
/** Continue the conversation: pick a choice (index into the node's options) or -1 = "next". */
export const TalkNextIntentSchema = z.object({ type: z.literal("talkNext"), option: z.number().int().min(-1).max(5) });
export const TalkEndIntentSchema = z.object({ type: z.literal("talkEnd") });
/** Pick up a placed ground item. */
export const PickupIntentSchema = z.object({ type: z.literal("pickup"), item: NPC_SPAWN });
/** Pin/unpin a quest on the on-screen tracker (max 2). */
export const PinQuestIntentSchema = z.object({ type: z.literal("pinQuest"), quest: NPC_SPAWN, pinned: z.boolean() });

/** A one-off story moment finished playing (e.g. the arrival); the server only accepts known beats. */
export const STORY_BEATS = ["arrival"] as const;
export const BeatIntentSchema = z.object({ type: z.literal("beat"), beat: z.enum(STORY_BEATS) });

export const FriendIntentSchema = z.object({ type: z.enum(["addFriend", "removeFriend"]), name: z.string().regex(PLAYER_NAME) });

export const IntentSchema = z.discriminatedUnion("type", [
  MoveItemIntentSchema,
  EquipIntentSchema,
  UnequipIntentSchema,
  UseSlotIntentSchema,
  UnlockSkillIntentSchema,
  ResetSkillsIntentSchema,
  SetLoadoutIntentSchema,
  LootTakeIntentSchema,
  AttackIntentSchema,
  TalkIntentSchema,
  TalkNextIntentSchema,
  TalkEndIntentSchema,
  PickupIntentSchema,
  PinQuestIntentSchema,
  BeatIntentSchema,
  FriendIntentSchema.extend({ type: z.literal("addFriend") }),
  FriendIntentSchema.extend({ type: z.literal("removeFriend") }),
  MoveIntentSchema,
  StopIntentSchema,
  CastIntentSchema,
  UseItemIntentSchema,
  ClimbIntentSchema,
]);

export type MoveIntent = z.infer<typeof MoveIntentSchema>;
export type StopIntent = z.infer<typeof StopIntentSchema>;
export type CastIntent = z.infer<typeof CastIntentSchema>;
export type UseItemIntent = z.infer<typeof UseItemIntentSchema>;
export type ClimbIntent = z.infer<typeof ClimbIntentSchema>;
export type Intent = z.infer<typeof IntentSchema>;
