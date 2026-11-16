/** Authoritative simulation rate. */
export const TICK_RATE = 20;
export const TICK_MS = 1000 / TICK_RATE;
export const TICK_SEC = TICK_MS / 1000;

/** World units per second. */
export const PLAYER_MOVE_SPEED = 4.5;

export const ABILITY_SLOTS = ["Q", "W", "E", "R", "D", "F"] as const;
export type AbilitySlot = (typeof ABILITY_SLOTS)[number];

export const ITEM_SLOTS = [1, 2, 3, 4] as const;
export type ItemSlot = (typeof ITEM_SLOTS)[number];
