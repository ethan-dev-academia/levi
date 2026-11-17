import { z } from "zod";
import { ABILITY_SLOTS } from "../protocol/constants.js";
import { ItemStackSchema } from "./item.js";

const ID = /^[a-z0-9_-]+$/;

export const INVENTORY_SIZE = 20;
export const HOTBAR_SIZE = 4;
export const PLAYER_SAVE_VERSION = 3;

const slot = ItemStackSchema.nullable();
const xp = z.number().int().min(0).default(0);
const skillList = z.array(z.string().regex(ID).max(64)).max(64).default([]);
const loadout = z.record(z.enum(ABILITY_SLOTS), z.string().regex(ID).max(64)).default({});

/** Display names: letters, digits, spaces, 1–12 chars (OSRS-like). */
export const PLAYER_NAME = /^[A-Za-z0-9][A-Za-z0-9 ]{0,11}$/;

/**
 * Everything persisted about a character. Owned by the server (the local
 * sim stands in for now); validated on every load.
 */
export const PlayerSaveSchema = z.object({
  version: z.literal(PLAYER_SAVE_VERSION),
  name: z.string().regex(PLAYER_NAME),
  createdAt: z.number().int().min(0),
  location: z.object({
    map: z.string().regex(ID),
    x: z.number().finite(),
    z: z.number().finite(),
    storey: z.number().int().min(0).max(7).default(0),
    building: z.string().regex(ID).optional(),
  }),
  vitals: z.object({ hp: z.number().min(0), mana: z.number().min(0), energy: z.number().min(0) }),
  inventory: z.array(slot).length(INVENTORY_SIZE),
  hotbar: z.array(slot).length(HOTBAR_SIZE),
  equipment: z.object({
    head: slot, body: slot, legs: slot, feet: slot,
    weapon: slot, offhand: slot, talisman1: slot, talisman2: slot,
  }),
  /** Total XP per discipline. */
  xp: z.object({
    ranger: xp, brawler: xp, mage: xp,
    cooking: xp, fishing: xp, smithing: xp, mining: xp, crafting: xp, gathering: xp,
    dungeoneering: xp, adventuring: xp,
  }),
  /** Unlocked skill-tree nodes per combat style. */
  skills: z.object({ ranger: skillList, brawler: skillList, mage: skillList }),
  /** Q W E R D F assignment per combat style (your kit follows your weapon). */
  loadouts: z.object({ ranger: loadout, brawler: loadout, mage: loadout }),
  /**
   * The one Q W E R D F bar: each key holds a skill from any path. Skills
   * whose path doesn't match your weapon show but can't be used.
   */
  bar: z.record(z.enum(ABILITY_SLOTS), z.object({ style: z.enum(["ranger", "brawler", "mage"]), skill: z.string().regex(ID).max(64) })).default({}),
  /** Quest progress: active stage index, or "done". */
  quests: z.record(z.string().regex(ID), z.object({ stage: z.union([z.number().int().min(0), z.literal("done")]), progress: z.record(z.string(), z.number().int()).default({}) })).default({}),
  /** World unlocks earned through the story (regions, shops, NPCs...). */
  worldFlags: z.array(z.string().regex(ID)).default([]),
  friends: z.array(z.string().regex(PLAYER_NAME)).max(200).default([]),
  /** Coins: a wallet, not a bag item. */
  coins: z.number().int().min(0).max(2_000_000_000).default(0),
  /** Ground items this player already picked up ("map:groundId"). */
  pickedUp: z.array(z.string().max(160)).max(100_000).default([]),
  /** Quests pinned to the on-screen tracker (max 2). */
  pinned: z.array(z.string().regex(ID)).max(2).default([]),
  /** What's left in each container this player has opened ("map:propId"). */
  containers: z.record(z.string().max(160), z.array(ItemStackSchema.nullable()).max(20)).default({}),
  /** Next unique id for gear instances. */
  nextUid: z.number().int().min(1).default(1),
});

export type PlayerSave = z.infer<typeof PlayerSaveSchema>;
