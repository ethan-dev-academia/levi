import { z } from "zod";

const ID = /^[a-z0-9_-]+$/;
const cell = z.number().int().min(0).max(65535);

/**
 * A kind of placeable object (content/props/*.json): furniture, barrels,
 * signs... Its look is a regular model (content/models).
 */
export const PropDefSchema = z.object({
  id: z.string().regex(ID).max(64),
  name: z.string().min(1).max(64),
  /** Model id in content/models. */
  model: z.string().regex(ID).max(64),
  /** Occupies its cell for walking. */
  solid: z.boolean().default(true),
  /** Right-click shows the placed instance's text (signs, notes, plaques). */
  readable: z.boolean().default(false),
  /** Holds loot the player can take (chests). Number of slots in its window. */
  container: z.object({ slots: z.number().int().min(1).max(20) }).optional(),
  /** Editor palette grouping. */
  category: z.enum(["furniture", "storage", "decor", "signage"]).default("decor"),
});

/** One slot of designer-set loot: item id and how many (gear: always 1). */
export const LootSlotSchema = z.object({
  item: z.string().regex(ID).max(64),
  qty: z.number().int().min(1).max(10),
});
export type LootSlot = z.infer<typeof LootSlotSchema>;

/** One placed prop, snapped to a cell centre and quarter-turn rotations. */
export const PropInstanceSchema = z.object({
  id: z.string().regex(ID).max(64),
  prop: z.string().regex(ID).max(64),
  x: cell,
  z: cell,
  /** Quarter turns clockwise from facing +Z (south). */
  rot: z.number().int().min(0).max(3).default(0),
  storey: z.number().int().min(0).max(7).default(0),
  /** Building whose storey this stands on (required above the ground floor). */
  building: z.string().regex(ID).max(64).optional(),
  /** Copied from the def at placement so the map alone knows what blocks. */
  solid: z.boolean().default(true),
  /** Text for readable props. */
  text: z.string().max(1000).optional(),
  /** Containers: the loot each player finds inside (their own copy). */
  loot: z.array(LootSlotSchema.nullable()).max(20).optional(),
});

/** Cell step a prop with `rot` quarter turns faces (rot 0 = +Z / south). Matches the renderer. */
export function propFacing(rot: number): [number, number] {
  return [[0, 1], [-1, 0], [0, -1], [1, 0]][rot & 3] as [number, number];
}

/** The cell directly in front of a prop (where you stand to use a chest). */
export function propFrontCell(p: Pick<PropInstance, "x" | "z" | "rot">): [number, number] {
  const [dx, dz] = propFacing(p.rot);
  return [p.x + dx, p.z + dz];
}

export type PropDef = z.infer<typeof PropDefSchema>;
export type PropInstance = z.infer<typeof PropInstanceSchema>;
