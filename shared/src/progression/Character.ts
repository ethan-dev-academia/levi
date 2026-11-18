import type { AbilitySlot } from "../protocol/constants.js";
import {
  EQUIP_SLOTS,
  isGearKind,
  itemStyle,
  STACK_LIMIT,
  WEAPON_STYLE,
  type EquipSlot,
  type ItemDef,
  type ItemStack,
} from "../schemas/item.js";
import { HOTBAR_SIZE, INVENTORY_SIZE, PLAYER_SAVE_VERSION, type PlayerSave } from "../schemas/player.js";
import type { AdventuringSkill, SkillDef, SkillTree } from "../schemas/skillTree.js";
import {
  acceptsGroup,
  adventureLevelForXp,
  combatLevel,
  COMBAT_STYLES,
  DISCIPLINE_NAMES,
  DISCIPLINES,
  levelForXp,
  SKILL_MILESTONES,
  type AdventureCap,
  type CombatStyle,
  type Discipline,
  type SkillSource,
} from "./disciplines.js";
import { sumStats, type Stats } from "./stats.js";

/** Static content the rules need. */
export interface GameData {
  items: ReadonlyMap<string, ItemDef>;
  trees: ReadonlyMap<CombatStyle, SkillTree>;
  /** Adventuring soft caps (content/progression.json). */
  adventureCaps?: readonly AdventureCap[];
  /** Adventuring's skills (sprint...), unlocked by Adventuring level. */
  adventuringSkills?: ReadonlyMap<string, AdventuringSkill>;
}

export type SlotRef = { area: "inv"; index: number } | { area: "hot"; index: number } | { area: "eq"; slot: EquipSlot };
export type Result = { ok: true; msg?: string } | { ok: false; msg: string };

const ok = (msg?: string): Result => (msg === undefined ? { ok: true } : { ok: true, msg });
const fail = (msg: string): Result => ({ ok: false, msg });
const COMBAT_LOCK = "You can't change your gear, hotbar or skills during combat.";
const MAX_XP = 1_000_000_000;

export const RESOURCE_OF: Readonly<Record<CombatStyle, "mana" | "energy">> = { ranger: "energy", brawler: "energy", mage: "mana" };

/** A brand-new character (server-side in Step 2). */
export function newCharacter(name: string, map: string, spawn: { x: number; z: number }, now: number): PlayerSave {
  const empty = <T>(n: number): Array<T | null> => Array.from({ length: n }, () => null);
  return {
    version: PLAYER_SAVE_VERSION,
    name,
    createdAt: now,
    location: { map, x: spawn.x, z: spawn.z, storey: 0 },
    vitals: { hp: 100, mana: 100, energy: 100 },
    inventory: empty<ItemStack>(INVENTORY_SIZE),
    hotbar: empty<ItemStack>(HOTBAR_SIZE),
    equipment: Object.fromEntries(EQUIP_SLOTS.map((s) => [s, null])) as PlayerSave["equipment"],
    xp: Object.fromEntries(DISCIPLINES.map((d) => [d, 0])) as PlayerSave["xp"],
    skills: { ranger: [], brawler: [], mage: [] },
    loadouts: { ranger: {}, brawler: {}, mage: {} },
    bar: {},
    quests: {},
    worldFlags: [],
    friends: [],
    containers: {},
    coins: 0,
    pickedUp: [],
    discovered: [],
    pinned: [],
    nextUid: 1,
  };
}

/**
 * All progression rules over one PlayerSave: bag, hotbar, equipment, stats,
 * XP, skill trees and loadouts. Pure and deterministic, shared by server and
 * client; every mutation validates first and reports a player-facing reason.
 */
export class Character {
  private statsCache: Stats | null = null;

  constructor(
    readonly save: PlayerSave,
    private readonly data: GameData,
  ) {
    for (const s of COMBAT_STYLES) this.ensureBasic(s);
    this.clampVitals();
  }

  // --- Derived --------------------------------------------------------------------

  def(id: string): ItemDef | undefined {
    return this.data.items.get(id);
  }

  level(d: Discipline): number {
    if (d === "adventuring") {
      const done = (q: string): boolean => this.save.quests[q]?.stage === "done";
      const active = (this.data.adventureCaps ?? []).filter((c) => !c.quests.every(done));
      return adventureLevelForXp(this.save.xp.adventuring, active);
    }
    return levelForXp(this.save.xp[d]);
  }

  /** Highest of the three combat styles. */
  get combatLevel(): number {
    return combatLevel({ ranger: this.level("ranger"), brawler: this.level("brawler"), mage: this.level("mage") });
  }

  /** Your class right now: the style of the weapon you hold (unarmed = brawler). */
  get style(): CombatStyle {
    const w = this.save.equipment.weapon;
    const wt = w ? this.def(w.item)?.weaponType : undefined;
    return wt ? WEAPON_STYLE[wt] : "brawler";
  }

  /** Concentration: which second bar you fight with. */
  get resource(): "mana" | "energy" {
    return RESOURCE_OF[this.style];
  }

  get stats(): Stats {
    if (!this.statsCache) {
      const blocks = EQUIP_SLOTS.map((s) => this.save.equipment[s]).flatMap((st) => (st ? [this.def(st.item)?.stats ?? {}] : []));
      this.statsCache = sumStats(blocks);
    }
    return this.statsCache;
  }

  /** Item definitions changed (dev editing): recompute derived stats. */
  invalidate(): void {
    this.gearChanged();
  }

  private gearChanged(): void {
    this.statsCache = null;
    this.clampVitals();
  }

  clampVitals(): void {
    const st = this.stats;
    const v = this.save.vitals;
    v.hp = Math.min(v.hp, st.maxHp);
    v.mana = Math.min(v.mana, st.maxMana);
    v.energy = Math.min(v.energy, st.maxEnergy);
  }

  /** Constant-rate regeneration (rates come from gear). */
  regen(dt: number): void {
    const st = this.stats;
    const v = this.save.vitals;
    v.hp = Math.min(st.maxHp, v.hp + st.hpRegen * dt);
    v.mana = Math.min(st.maxMana, v.mana + st.manaRegen * dt);
    v.energy = Math.min(st.maxEnergy, v.energy + st.energyRegen * dt);
  }

  // --- Slots ----------------------------------------------------------------------

  get(ref: SlotRef): ItemStack | null {
    if (ref.area === "eq") return this.save.equipment[ref.slot];
    const list = ref.area === "inv" ? this.save.inventory : this.save.hotbar;
    return list[ref.index] ?? null;
  }

  private put(ref: SlotRef, stack: ItemStack | null): void {
    if (ref.area === "eq") this.save.equipment[ref.slot] = stack;
    else (ref.area === "inv" ? this.save.inventory : this.save.hotbar)[ref.index] = stack;
  }

  private validRef(ref: SlotRef): boolean {
    if (ref.area === "eq") return (EQUIP_SLOTS as readonly string[]).includes(ref.slot);
    const n = ref.area === "inv" ? INVENTORY_SIZE : HOTBAR_SIZE;
    return Number.isInteger(ref.index) && ref.index >= 0 && ref.index < n;
  }

  stackable(def: ItemDef): boolean {
    return !isGearKind(def.kind);
  }

  /** Can this item be worn in that equipment slot (ignoring level requirements)? */
  fits(def: ItemDef, slot: EquipSlot): boolean {
    if (!isGearKind(def.kind) || !def.slot) return false;
    return def.slot === "talisman" ? slot === "talisman1" || slot === "talisman2" : def.slot === slot;
  }

  /** Unmet level requirement, as a message. */
  private requirement(def: ItemDef): string | null {
    for (const [d, lvl] of Object.entries(def.requires) as Array<[Discipline, number]>) {
      if (this.level(d) < lvl) return `You need ${DISCIPLINE_NAMES[d]} level ${lvl} to use the ${def.name}.`;
    }
    return null;
  }

  /** Give items: tops up matching stacks, then fills empty bag slots. Returns how many didn't fit. */
  addItem(id: string, qty: number): number {
    const def = this.def(id);
    if (!def || qty <= 0) return qty;
    let left = qty;
    const bag = this.save.inventory;
    if (this.stackable(def)) {
      for (const s of bag) {
        if (left === 0) break;
        if (s && s.item === id && s.qty < STACK_LIMIT) {
          const n = Math.min(left, STACK_LIMIT - s.qty);
          s.qty += n;
          left -= n;
        }
      }
    }
    for (let i = 0; i < bag.length && left > 0; i++) {
      if (bag[i]) continue;
      if (this.stackable(def)) {
        const n = Math.min(left, STACK_LIMIT);
        bag[i] = { item: id, qty: n };
        left -= n;
      } else {
        bag[i] = { item: id, qty: 1, uid: this.save.nextUid++ };
        left -= 1;
      }
    }
    return left;
  }

  /** Take up to `qty` of an item (bag first, then hotbar). Returns how many were removed. */
  removeItem(id: string, qty: number): number {
    let left = qty;
    for (const list of [this.save.inventory, this.save.hotbar]) {
      for (let i = 0; i < list.length && left > 0; i++) {
        const s = list[i];
        if (!s || s.item !== id) continue;
        const n = Math.min(left, s.qty);
        s.qty -= n;
        left -= n;
        if (s.qty <= 0) list[i] = null;
      }
    }
    return qty - left;
  }

  /** Add (or with a negative amount, spend) coins; never below zero. */
  addCoins(amount: number): void {
    this.save.coins = Math.max(0, Math.min(2_000_000_000, this.save.coins + Math.round(amount)));
  }

  /** Total of an item across bag and hotbar. */
  count(id: string): number {
    let n = 0;
    for (const s of [...this.save.inventory, ...this.save.hotbar]) if (s?.item === id) n += s.qty;
    return n;
  }

  /** Drag `from` onto `to`: move, merge stacks, or swap. */
  move(from: SlotRef, to: SlotRef, inCombat: boolean): Result {
    if (!this.validRef(from) || !this.validRef(to)) return fail("Invalid slot.");
    if (JSON.stringify(from) === JSON.stringify(to)) return ok();
    const touchesLocked = from.area !== "inv" || to.area !== "inv";
    if (inCombat && touchesLocked) return fail(COMBAT_LOCK);
    const a = this.get(from);
    if (!a) return fail("There's nothing there.");
    const b = this.get(to);
    const da = this.def(a.item);
    if (!da) return fail("Unknown item.");

    if (to.area === "eq") {
      if (!this.fits(da, to.slot)) return fail(`The ${da.name} doesn't go there.`);
      const req = this.requirement(da);
      if (req) return fail(req);
    }
    if (from.area === "eq" && b) {
      const db = this.def(b.item);
      if (!db || !this.fits(db, from.slot)) return fail("Those can't swap places.");
      const req = this.requirement(db);
      if (req) return fail(req);
    }

    if (b && b.item === a.item && this.stackable(da)) {
      const n = Math.min(a.qty, STACK_LIMIT - b.qty);
      if (n <= 0) return fail("That stack is full.");
      b.qty += n;
      a.qty -= n;
      if (a.qty === 0) this.put(from, null);
    } else {
      this.put(to, a);
      this.put(from, b);
    }
    if (from.area === "eq" || to.area === "eq") this.gearChanged();
    return ok();
  }

  /** Equip from the bag/hotbar into the right slot (swapping out what's there). */
  equip(from: SlotRef, inCombat: boolean): Result {
    const a = this.get(from);
    const d = a ? this.def(a.item) : undefined;
    if (!a || !d) return fail("There's nothing there.");
    if (!isGearKind(d.kind) || !d.slot) return fail(`You can't wear the ${d.name}.`);
    let slot: EquipSlot;
    if (d.slot === "talisman") slot = !this.save.equipment.talisman1 ? "talisman1" : !this.save.equipment.talisman2 ? "talisman2" : "talisman1";
    else slot = d.slot;
    const r = this.move(from, { area: "eq", slot }, inCombat);
    return r.ok ? ok(`You equip the ${d.name}.`) : r;
  }

  /** Take off into the first free bag slot. */
  unequip(slot: EquipSlot, inCombat: boolean): Result {
    if (inCombat) return fail(COMBAT_LOCK);
    const s = this.save.equipment[slot];
    if (!s) return fail("Nothing is equipped there.");
    const free = this.save.inventory.findIndex((x) => !x);
    if (free < 0) return fail("Your bag is full.");
    return this.move({ area: "eq", slot }, { area: "inv", index: free }, false);
  }

  /** Use a consumable / tome. Tomes need the discipline to train. */
  use(ref: SlotRef, discipline?: Discipline): Result {
    if (!this.validRef(ref)) return fail("Invalid slot.");
    const s = this.get(ref);
    const d = s ? this.def(s.item) : undefined;
    if (!s || !d) return fail("There's nothing there.");
    if (!d.use) return isGearKind(d.kind) ? fail(`Equip the ${d.name} to use it.`) : fail(`You can't use the ${d.name}.`);
    const req = this.requirement(d);
    if (req) return fail(req);

    let msg: string;
    if (d.use.kind === "restore") {
      const st = this.stats;
      const v = this.save.vitals;
      if (v.hp >= st.maxHp && v.mana >= st.maxMana && v.energy >= st.maxEnergy) return fail("You're already at full strength.");
      v.hp = Math.min(st.maxHp, v.hp + d.use.hp);
      v.mana = Math.min(st.maxMana, v.mana + d.use.mana);
      v.energy = Math.min(st.maxEnergy, v.energy + d.use.energy);
      msg = `You use the ${d.name}.`;
    } else {
      if (!discipline) return fail("Choose a skill to put this experience into.");
      if (!acceptsGroup(discipline, d.use.group)) {
        return fail(`${d.name} only trains ${d.use.group === "combat" ? "combat" : "peacetime"} skills (or Dungeoneering).`);
      }
      const gained = this.addXp(discipline, d.use.amount);
      msg = `You study the ${d.name}: +${d.use.amount} ${DISCIPLINE_NAMES[discipline]} XP.${gained > 0 ? ` Level up!` : ""}`;
    }
    s.qty -= 1;
    if (s.qty <= 0) this.put(ref, null);
    return ok(msg);
  }

  // --- Containers (chests) ------------------------------------------------------------

  /**
   * This player's view of a container: the designer's loot until they first
   * take something, then their own saved remainder.
   */
  containerView(key: string, template: ReadonlyArray<{ item: string; qty: number } | null>, slots: number): Array<ItemStack | null> {
    const own = this.save.containers[key];
    if (own) return own;
    return Array.from({ length: slots }, (_, i) => {
      const t = template[i];
      return t && this.def(t.item) ? { item: t.item, qty: t.qty } : null;
    });
  }

  /** Move one container slot (or all, index = -1) into the bag. */
  takeFromContainer(key: string, template: ReadonlyArray<{ item: string; qty: number } | null>, slots: number, index: number): Result {
    const view = this.containerView(key, template, slots).map((s) => (s ? { ...s } : null));
    const indices = index < 0 ? view.map((_, i) => i) : [index];
    let took = 0;
    let blocked = false;
    for (const i of indices) {
      const s = view[i];
      if (!s) continue;
      const left = this.addItem(s.item, s.qty);
      took += s.qty - left;
      if (left > 0) {
        s.qty = left;
        blocked = true;
        if (index >= 0) break;
      } else view[i] = null;
    }
    if (took === 0) return fail(blocked ? "Your bag is full." : "There's nothing there.");
    this.save.containers[key] = view;
    return ok(blocked ? "Your bag is full; some items were left behind." : undefined);
  }

  // --- XP -------------------------------------------------------------------------

  /** Returns levels gained. */
  addXp(d: Discipline, amount: number): number {
    const before = this.level(d);
    this.save.xp[d] = Math.min(MAX_XP, this.save.xp[d] + Math.max(0, Math.floor(amount)));
    return this.level(d) - before;
  }

  // --- Skill trees ------------------------------------------------------------------

  tree(style: CombatStyle): SkillTree | undefined {
    return this.data.trees.get(style);
  }

  private ensureBasic(style: CombatStyle): void {
    const basic = this.tree(style)?.skills.find((s) => s.tier === 1);
    const list = this.save.skills[style];
    if (basic && !list.includes(basic.id)) list.unshift(basic.id);
  }

  /** A skill of a path, tree or secret. */
  findSkill(style: SkillSource, id: string): SkillDef | undefined {
    if (style === "adventuring") return this.data.adventuringSkills?.get(id);
    const t = this.tree(style);
    return t?.skills.find((s) => s.id === id) ?? t?.secrets.find((s) => s.id === id);
  }

  /** Give a secret skill (quest reward / dialogue). */
  grantSkill(style: CombatStyle, id: string): Result {
    const s = this.tree(style)?.secrets.find((x) => x.id === id);
    if (!s) return fail("Unknown skill.");
    if (this.isUnlocked(style, id)) return ok();
    this.save.skills[style].push(id);
    return ok(`You have learned a secret art: ${s.name}!`);
  }

  isUnlocked(style: SkillSource, id: string): boolean {
    if (style === "adventuring") {
      const s = this.data.adventuringSkills?.get(id);
      return !!s && this.level("adventuring") >= s.tier;
    }
    return this.save.skills[style].includes(id);
  }

  /** Why a node can't be unlocked right now (null = it can). */
  unlockBlocker(style: CombatStyle, node: SkillDef): string | null {
    if (this.isUnlocked(style, node.id)) return "Already unlocked.";
    const lvl = this.level(style);
    if (lvl < node.tier) return `Requires ${DISCIPLINE_NAMES[style]} level ${node.tier}.`;
    const tree = this.tree(style)!;
    const unlocked = this.save.skills[style];
    if (tree.skills.some((s) => s.tier === node.tier && unlocked.includes(s.id))) return "You've already chosen a skill at this tier. Reset the tree to choose differently.";
    const prevTier = SKILL_MILESTONES[SKILL_MILESTONES.indexOf(node.tier as (typeof SKILL_MILESTONES)[number]) - 1];
    if (prevTier !== undefined) {
      const needs = node.requires.length > 0 ? node.requires : tree.skills.filter((s) => s.tier === prevTier).map((s) => s.id);
      if (!needs.some((id) => unlocked.includes(id))) {
        const names = needs.map((id) => tree.skills.find((s) => s.id === id)?.name ?? id);
        return `Unlock ${names.join(" or ")} first.`;
      }
    }
    return null;
  }

  unlockSkill(style: CombatStyle, id: string, inCombat: boolean): Result {
    if (inCombat) return fail(COMBAT_LOCK);
    const node = this.tree(style)?.skills.find((s) => s.id === id);
    if (!node) return fail("Unknown skill.");
    const why = this.unlockBlocker(style, node);
    if (why) return fail(why);
    this.save.skills[style].push(id);
    return ok(`You learn ${node.name}.`);
  }

  /** Forget every choice in a tree (the basic attack stays). */
  resetTree(style: CombatStyle, inCombat: boolean): Result {
    if (inCombat) return fail(COMBAT_LOCK);
    this.save.skills[style] = [];
    for (const k of Object.keys(this.save.bar) as AbilitySlot[]) if (this.save.bar[k]?.style === style) delete this.save.bar[k];
    this.ensureBasic(style);
    return ok(`Your ${DISCIPLINE_NAMES[style]} skills have been reset.`);
  }

  /** Put an unlocked skill on a key (null clears). A skill sits on one key at most. */
  setLoadout(style: SkillSource, key: AbilitySlot, skill: string | null, inCombat: boolean): Result {
    if (inCombat) return fail(COMBAT_LOCK);
    const bar = this.save.bar;
    if (skill === null) {
      delete bar[key];
      return ok();
    }
    const node = this.findSkill(style, skill);
    if (!node || !this.isUnlocked(style, skill)) return fail("You haven't learned that skill.");
    for (const k of Object.keys(bar) as AbilitySlot[]) if (bar[k]?.skill === skill && bar[k]?.style === style) delete bar[k];
    bar[key] = { style, skill };
    return ok(`${node.name} is now on ${key}.`);
  }

  /** What's on a key (any path), with whether your weapon lets you use it. */
  barSlot(key: AbilitySlot): { skill: SkillDef; style: SkillSource; usable: boolean } | undefined {
    const e = this.save.bar[key];
    const skill = e ? this.findSkill(e.style, e.skill) : undefined;
    return e && skill && this.isUnlocked(e.style, skill.id) ? { skill, style: e.style, usable: e.style === "adventuring" || e.style === this.style } : undefined;
  }

  /**
   * Put Adventuring skills on their default keys, once each (new heroes and
   * older saves alike; unbinding one later is respected). Returns whether the bar changed.
   */
  ensureAdventuringKit(): boolean {
    let changed = false;
    for (const s of this.data.adventuringSkills?.values() ?? []) {
      const flag = `kit-${s.id}`;
      if (!s.defaultKey || this.save.worldFlags.includes(flag) || !this.isUnlocked("adventuring", s.id)) continue;
      this.save.worldFlags.push(flag);
      if (this.keyOf("adventuring", s.id)) continue;
      const key = !this.save.bar[s.defaultKey] ? s.defaultKey : (["D", "F", "R", "E", "W", "Q"] as const).find((k) => !this.save.bar[k]);
      if (!key) continue;
      this.save.bar[key] = { style: "adventuring", skill: s.id };
      changed = true;
    }
    return changed;
  }

  /** The pool a bar skill spends: its path's, or (Adventuring skills) whatever your weapon uses. */
  poolFor(source: SkillSource): "mana" | "energy" {
    const style = source === "adventuring" ? this.style : source;
    return style === "mage" ? "mana" : "energy";
  }

  /** Key a skill sits on, if any. */
  keyOf(style: SkillSource, skill: string): AbilitySlot | undefined {
    return (Object.keys(this.save.bar) as AbilitySlot[]).find((k) => this.save.bar[k]?.style === style && this.save.bar[k]?.skill === skill);
  }

  /** Usable skill on a key (matches your weapon's path). */
  skillOn(key: AbilitySlot): SkillDef | undefined {
    const s = this.barSlot(key);
    return s?.usable ? s.skill : undefined;
  }

  /** Class hue of a held item. */
  hueOf(stack: ItemStack | null): CombatStyle | undefined {
    const d = stack ? this.def(stack.item) : undefined;
    return d ? itemStyle(d) : undefined;
  }
}
