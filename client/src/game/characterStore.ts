import { Character, newCharacter, PlayerSaveSchema, type GameData, type PlayerSave } from "@levi/shared";

/**
 * Stand-in for the server's player database until Step 2: the character is
 * kept in this browser's localStorage, schema-validated on every load.
 * (The server will own this; clients will never be trusted with it.)
 */
const KEY = "levi.character.v1";
let savingDisabled = false;

/** Stop writing saves (used right before a reset-and-reload). */
export function disableSaving(): void {
  savingDisabled = true;
}

export function loadSave(): PlayerSave | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const r = PlayerSaveSchema.safeParse(JSON.parse(raw));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

export function storeSave(save: PlayerSave): void {
  if (savingDisabled) return;
  try {
    localStorage.setItem(KEY, JSON.stringify(save));
  } catch {
    // Storage full / blocked: progress just won't persist this session.
  }
}

export function clearSave(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}

/** Quests every new character starts with (the story opener). */
export const STARTING_QUESTS: readonly string[] = ["a-feather-on-the-wind"];

/** A fresh adventurer: empty-handed. Gear and supplies come from the world (chests, quests). */
export function createCharacter(data: GameData, map: string, spawn: { x: number; z: number }): Character {
  const c = new Character(newCharacter("Adventurer", map, spawn, Date.now()), data);
  // A plain staff in hand, its first skill (the line skillshot) on Q.
  c.addItem("basic-staff", 1);
  const staff = c.save.inventory.findIndex((s) => s?.item === "basic-staff");
  if (staff >= 0) c.equip({ area: "inv", index: staff }, false);
  const first = data.trees.get("mage")?.skills.find((s) => s.tier === 1);
  if (first) c.setLoadout("mage", "Q", first.id, false);
  // The opening story quest is waiting in the journal.
  for (const id of STARTING_QUESTS) c.save.quests[id] = { stage: 0, progress: {} };
  return c;
}
