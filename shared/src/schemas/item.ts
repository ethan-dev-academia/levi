import { z } from "zod";
import { COMBAT_STYLES, DISCIPLINES } from "../progression/disciplines.js";
import { StatBlockSchema } from "../progression/stats.js";

const ID = /^[a-z0-9_-]+$/;

/** Where gear goes. Talismans fit either talisman slot. */
export const EQUIP_SLOTS = ["head", "body", "legs", "feet", "weapon", "offhand", "talisman1", "talisman2"] as const;
export type EquipSlot = (typeof EQUIP_SLOTS)[number];
export const GEAR_SLOT_KINDS = ["head", "body", "legs", "feet", "weapon", "offhand", "talisman"] as const;
export type GearSlotKind = (typeof GEAR_SLOT_KINDS)[number];

export const WEAPON_TYPES = ["bow", "gun", "dagger", "sword", "staff", "wand"] as const;
export type WeaponType = (typeof WEAPON_TYPES)[number];
/** A weapon's type decides the wielder's combat style ("class"). */
export const WEAPON_STYLE = {
  bow: "ranger", gun: "ranger", dagger: "brawler", sword: "brawler", staff: "mage", wand: "mage",
} as const satisfies Record<WeaponType, (typeof COMBAT_STYLES)[number]>;

export const ITEM_KINDS = ["weapon", "armour", "talisman", "consumable", "material", "ammo", "tome", "quest"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];
const GEAR_KINDS: readonly ItemKind[] = ["weapon", "armour", "talisman"];
export const isGearKind = (k: ItemKind): boolean => GEAR_KINDS.includes(k);

/** Item rarity: drives the slot background colour everywhere items are shown. */
export const RARITIES = ["common", "uncommon", "rare", "epic", "legendary"] as const;
export type Rarity = (typeof RARITIES)[number];

/** Max per slot for anything that stacks. Gear never stacks. */
export const STACK_LIMIT = 10;

/** Built-in icon glyphs (client draws them; no hand-drawn art needed). */
export const ITEM_ICONS = [
  "sword", "dagger", "bow", "gun", "staff", "wand", "helm", "chest", "legs", "boots", "shield", "orb",
  "talisman", "potion", "bread", "fish", "ore", "log", "herb", "tome", "arrow", "key", "scroll", "gem",
  "envelope", "feather", "bottle", "map",
] as const;

/** Pixel-art palette index characters: "." = transparent, then 0-9, a-f. */
export const ART_CHARS = "0123456789abcdef";
export const ART_SIZES = [8, 12, 16, 24, 32] as const;

/**
 * Vector pixel art: a size×size grid of palette indices, drawn as merged SVG
 * rects so it stays crisp at any scale. One string per row.
 */
export const ItemArtSchema = z
  .object({
    size: z.number().int().refine((n) => (ART_SIZES as readonly number[]).includes(n), "size must be 8, 12, 16, 24 or 32"),
    palette: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).min(1).max(16),
    rows: z.array(z.string().max(32)),
  })
  .superRefine((a, ctx) => {
    if (a.rows.length !== a.size) ctx.addIssue({ code: "custom", message: `art needs ${a.size} rows` });
    a.rows.forEach((r, y) => {
      if (r.length !== a.size) ctx.addIssue({ code: "custom", message: `art row ${y} must be ${a.size} long` });
      for (const ch of r) {
        if (ch === ".") continue;
        const i = ART_CHARS.indexOf(ch);
        if (i < 0 || i >= a.palette.length) {
          ctx.addIssue({ code: "custom", message: `art row ${y}: "${ch}" is not a palette colour` });
          break;
        }
      }
    });
  });
export type ItemArt = z.infer<typeof ItemArtSchema>;

const ItemUseSchema = z.discriminatedUnion("kind", [
  /** Instantly restores vitals. */
  z.object({
    kind: z.literal("restore"),
    hp: z.number().min(0).max(10000).default(0),
    mana: z.number().min(0).max(10000).default(0),
    energy: z.number().min(0).max(10000).default(0),
  }),
  /** General XP: the player picks a discipline from the group (dungeoneering accepts both). */
  z.object({ kind: z.literal("xp"), group: z.enum(["combat", "peaceful"]), amount: z.number().int().min(1).max(1_000_000) }),
]);

export const ItemDefSchema = z
  .object({
    id: z.string().regex(ID).max(64),
    name: z.string().min(1).max(64),
    description: z.string().max(400).default(""),
    kind: z.enum(ITEM_KINDS),
    /** Gear only: where it's worn. */
    slot: z.enum(GEAR_SLOT_KINDS).optional(),
    weaponType: z.enum(WEAPON_TYPES).optional(),
    /** Class hue. Weapons take it from their type. Omit = neutral. */
    style: z.enum(COMBAT_STYLES).optional(),
    tier: z.number().int().min(1).max(10).default(1),
    rarity: z.enum(RARITIES).default("common"),
    stats: StatBlockSchema.default({}),
    /** Minimum discipline levels to equip / use. */
    requires: z.record(z.enum(DISCIPLINES), z.number().int().min(1).max(50)).default({}),
    use: ItemUseSchema.optional(),
    icon: z.enum(ITEM_ICONS),
    /** Hand-made pixel art; replaces the glyph when present. */
    art: ItemArtSchema.optional(),
    /** Icon tint. */
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#c9c2b0"),
    value: z.number().int().min(0).default(1),
  })
  .superRefine((d, ctx) => {
    if (isGearKind(d.kind) && !d.slot) ctx.addIssue({ code: "custom", message: `${d.id}: gear needs a slot` });
    if (d.kind === "weapon" && (!d.weaponType || d.slot !== "weapon")) ctx.addIssue({ code: "custom", message: `${d.id}: weapons need weaponType and slot "weapon"` });
    if (d.kind === "talisman" && d.slot !== "talisman") ctx.addIssue({ code: "custom", message: `${d.id}: talismans use slot "talisman"` });
    if ((d.kind === "consumable" || d.kind === "tome") && !d.use) ctx.addIssue({ code: "custom", message: `${d.id}: ${d.kind} needs a use` });
  });

export type ItemDef = z.infer<typeof ItemDefSchema>;

/** Effective class hue of an item. */
export function itemStyle(d: ItemDef): (typeof COMBAT_STYLES)[number] | undefined {
  return d.weaponType ? WEAPON_STYLE[d.weaponType] : d.style;
}

/**
 * What a player actually holds. Stackables: qty 1..10. Gear: qty 1 with a
 * unique `uid` and room for per-instance enchantments / reforges.
 */
export const ItemStackSchema = z.object({
  item: z.string().regex(ID).max(64),
  qty: z.number().int().min(1).max(STACK_LIMIT),
  uid: z.number().int().min(1).optional(),
  mods: z
    .object({
      enchantments: z.array(z.string().regex(ID).max(64)).max(8).default([]),
      reforge: z.string().regex(ID).max(64).optional(),
    })
    .optional(),
});
export type ItemStack = z.infer<typeof ItemStackSchema>;
