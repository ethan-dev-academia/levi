import { z } from "zod";
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

export const UseItemIntentSchema = z.object({
  type: z.literal("useItem"),
  slot: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
}) satisfies z.ZodType<{ type: "useItem"; slot: ItemSlot }>;

export const IntentSchema = z.discriminatedUnion("type", [
  MoveIntentSchema,
  StopIntentSchema,
  CastIntentSchema,
  UseItemIntentSchema,
]);

export type MoveIntent = z.infer<typeof MoveIntentSchema>;
export type StopIntent = z.infer<typeof StopIntentSchema>;
export type CastIntent = z.infer<typeof CastIntentSchema>;
export type UseItemIntent = z.infer<typeof UseItemIntentSchema>;
export type Intent = z.infer<typeof IntentSchema>;
