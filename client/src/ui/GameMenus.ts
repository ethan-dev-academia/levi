import {
  ABILITY_SLOTS,
  BASE_STATS,
  COMBAT_STYLES,
  DISCIPLINE_NAMES,
  INVENTORY_SIZE,
  levelForXp,
  levelProgress,
  MAX_LEVEL,
  PEACEFUL_SKILLS,
  PLAYER_NAME,
  QUEST_CATEGORIES,
  SKILL_MILESTONES,
  STAT_KEYS,
  STAT_LABELS,
  xpForLevel,
  type AbilitySlot,
  type Character,
  type CombatStyle,
  type Discipline,
  type EquipSlot,
  type Intent,
  type QuestCategory,
  type QuestDef,
  type QuestEngine,
  type AdventuringSkill,
  type SkillDef,
} from "@levi/shared";
import type { ItemUi } from "./ItemUi.js";
import { ICONS, type TabDef } from "./SidePanel.js";
import { skillIcon } from "./skillIcons.js";
import { playerQuestStatus } from "./QuestMapWindow.js";

export interface MenuDeps {
  character(): Character;
  inCombat(): boolean;
  combatSecondsLeft(): number;
  send(intent: Intent): void;
  items: ItemUi;
  quests: ReadonlyMap<string, QuestDef>;
  engine(): QuestEngine;
  /** Open a combat path's skill tree window. */
  openTree(style: CombatStyle): void;
  /** Adventuring's own skills (sprint...). */
  adventuringSkills: ReadonlyMap<string, AdventuringSkill>;
  /** Start dragging a skill onto the Q W E R D F bar. */
  dragSkill(skill: SkillDef, style: "adventuring", e: PointerEvent): void;
  /** Open the quest map window. */
  openQuestMap(): void;
  /** Display names of Acts ("Falcon's Landing"...). */
  actNames: ReadonlyMap<number, string>;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

const STYLE_NAME: Record<CombatStyle, string> = { ranger: "Ranger", brawler: "Brawler", mage: "Mage" };

function combatBanner(d: MenuDeps): HTMLElement | null {
  if (!d.inCombat()) return null;
  return el("div", "menu-lock", `In combat: gear, hotbar and skills are locked (${Math.ceil(d.combatSecondsLeft())}s)`);
}

// --- Bag -------------------------------------------------------------------------------------

function bagGrid(d: MenuDeps, c: Character): HTMLElement {
  const wrap = el("div", "bag");
  const used = c.save.inventory.filter(Boolean).length;
  const head = el("h4", "bag-head");
  head.append(el("span", "", "Bag"), el("span", "bag-count", `${used} / ${INVENTORY_SIZE}`));
  const grid = el("div", "bag-grid");
  for (let i = 0; i < INVENTORY_SIZE; i++) {
    const s = el("div", "bag-slot");
    d.items.renderSlot(s, { area: "inv", index: i }, c.save.inventory[i] ?? null);
    grid.append(s);
  }
  wrap.append(head, grid);
  return wrap;
}

// --- Character: equipment + stats ---------------------------------------------------------------

/** Armour in one column; weapon + off-hand on its left; talismans side by side on its right. */
const DOLL: ReadonlyArray<[EquipSlot, string]> = [
  ["head", "Head"], ["body", "Body"], ["legs", "Legs"], ["feet", "Feet"],
  ["weapon", "Weapon"], ["offhand", "Off-hand"], ["talisman1", "Talisman"], ["talisman2", "Talisman"],
];

function fmt(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0$/, "");
}

const SLOT_MAX = 78;
const SLOT_MIN = 40;

/**
 * Size bag slots as large as the sidebar allows without the tab scrolling:
 * as wide as the bag column permits, then shrunk to fit the height.
 */
export function fitCharacterTab(content: HTMLElement): void {
  const grid = content.querySelector<HTMLElement>(".bag .bag-grid");
  if (!grid?.parentElement) return;
  const gap = 6;
  let size = Math.max(SLOT_MIN, Math.min(SLOT_MAX, Math.floor((grid.parentElement.clientWidth - gap * 3) / 4)));
  grid.style.setProperty("--bag-slot", `${size}px`);
  const over = content.scrollHeight - content.clientHeight;
  if (over > 0) {
    size = Math.max(SLOT_MIN, size - Math.ceil(over / 5) - 1);
    grid.style.setProperty("--bag-slot", `${size}px`);
  }
}

function characterTab(d: MenuDeps): TabDef {
  return {
    id: "character",
    title: "Character",
    icon: ICONS.equipment,
    render(root) {
      const c = d.character();
      const lock = combatBanner(d);
      if (lock) root.append(lock);
      const doll = el("div", "doll");
      for (const [slot, label] of DOLL) {
        const s = el("div", `doll-slot ds-${slot}`);
        d.items.renderSlot(s, { area: "eq", slot }, c.save.equipment[slot], label);
        doll.append(s);
      }
      const style = c.style;
      const conc = el("div", `concentration ${c.resource}`);
      conc.append(el("span", "", "Concentration"), el("b", "", `${STYLE_NAME[style]} · ${c.resource === "mana" ? "Mana" : "Energy"}`));
      const coins = el("div", "coins");
      coins.append(el("span", "coin-icon"), el("span", "", "Coins"), el("b", "", c.save.coins.toLocaleString()));
      const charRow = el("div", "char-row");
      charRow.append(conc, coins);
      // Equipment with its info (concentration, coins, stats) alongside; the bag always below.
      const info = el("div", "char-info");
      const top = el("div", "char-top");
      top.append(doll, info);
      root.append(top, bagGrid(d, c));
      info.append(charRow);
      const st = c.stats;
      const list = el("div", "stat-list compact");
      for (const k of STAT_KEYS) {
        const row = el("div", `kv${st[k] !== BASE_STATS[k] ? " boosted" : ""}`);
        row.append(el("span", "", STAT_LABELS[k]), el("b", "", fmt(st[k])));
        list.append(row);
      }
      list.title = "Stats come from gear and talismans. Your weapon sets your class.";
      info.append(list);
      fitCharacterTab(root);
    },
  };
}

// --- Skills (levels + trees) ------------------------------------------------------------------

function skillsTab(d: MenuDeps): TabDef {
  const levelRow = (c: Character, dis: Discipline, onOpen?: () => void): HTMLElement => {
    const lvl = levelForXp(c.save.xp[dis]);
    const row = el(onOpen ? "button" : "div", `skill-row${onOpen ? " clickable" : ""}`);
    const xp = c.save.xp[dis];
    row.title = lvl >= MAX_LEVEL ? `${xp.toLocaleString()} XP (max level)` : `${xp.toLocaleString()} / ${xpForLevel(lvl + 1).toLocaleString()} XP`;
    const top = el("div", "skill-top");
    top.append(el("span", "", DISCIPLINE_NAMES[dis]), el("b", "", `${lvl}`));
    const bar = el("div", "skill-bar");
    const fill = el("div", "skill-fill");
    fill.style.width = `${Math.round(levelProgress(xp) * 100)}%`;
    bar.append(fill);
    row.append(top, bar);
    if (onOpen) {
      row.append(el("span", "skill-open", "Skill tree ›"));
      row.addEventListener("click", onOpen);
    }
    return row;
  };

  return {
    id: "skills",
    title: "Skills",
    icon: ICONS.skills,
    render(root) {
      const c = d.character();
      root.append(el("h4", "", "Combat · click to open the skill tree"));
      for (const s of COMBAT_STYLES) root.append(levelRow(c, s, () => d.openTree(s)));
      root.append(el("h4", "", "Peacetime"));
      for (const s of PEACEFUL_SKILLS) root.append(levelRow(c, s));
      root.append(el("h4", "", "Adventure"));
      root.append(levelRow(c, "dungeoneering"));
      const adv = levelRow(c, "adventuring");
      adv.title += " · Only from quests";
      root.append(adv);
      // Adventuring's skills: no weapon needed. Drag onto the bar or pick a key.
      const advLevel = c.level("adventuring");
      for (const s of d.adventuringSkills.values()) {
        const unlocked = c.isUnlocked("adventuring", s.id);
        const row = el("div", `adv-skill${unlocked ? "" : " locked"}`);
        const icon = el("div", "adv-skill-icon");
        icon.append(skillIcon(s, "adventuring"));
        icon.title = unlocked ? "Drag onto your bar" : "";
        if (unlocked) icon.addEventListener("pointerdown", (e) => d.dragSkill(s, "adventuring", e));
        const body = el("div", "adv-skill-body");
        const key = c.keyOf("adventuring", s.id);
        body.append(
          el("b", "", s.name),
          el("span", "adv-skill-meta", unlocked ? `${s.cost} ${c.poolFor("adventuring")} · ${s.cooldown}s cooldown${key ? ` · on ${key}` : ""}` : `Adventuring level ${s.tier} (you're ${advLevel})`),
          el("span", "adv-skill-desc", s.description),
        );
        if (unlocked) {
          const keys = el("div", "sd-keys");
          for (const k of ABILITY_SLOTS) {
            const on = key === k;
            const b = el("button", `sd-key${on ? " on" : ""}`, k);
            b.addEventListener("click", () => d.send({ type: "setLoadout", style: "adventuring", key: k, skill: on ? null : s.id }));
            keys.append(b);
          }
          body.append(keys);
        }
        row.append(icon, body);
        root.append(row);
      }
    },
  };
}

const CATEGORY_LABEL: Record<QuestCategory, string> = { act: "Act", skill: "Skill", world: "World", adventurer: "Adventurer" };

type BookSection = "all" | QuestCategory;

/** Quest book view state (module-level so the quest map can point the book at a quest). */
const book: { section: BookSection; open: string | null } = { section: "all", open: null };

/** Show a quest in the book: switches to All and expands it (call before opening the Quests tab). */
export function focusQuestInBook(id: string): void {
  book.section = "all";
  book.open = id;
}

function questsTab(d: MenuDeps): TabDef {
  return {
    id: "quests",
    title: "Quests",
    icon: ICONS.quests,
    render(root) {
      const c = d.character();
      const eng = d.engine();
      const all = [...d.quests.values()];
      const status = (q: QuestDef): "done" | "active" | "available" | "locked" => playerQuestStatus(eng, q);
      const rerender = (): void => {
        root.querySelectorAll(":scope > :not(h3)").forEach((n) => n.remove());
        this.render(root);
      };

      // Sections: All (default) or one category, each with done / total.
      const tabs = el("div", "qb-tabs");
      for (const sec of ["all", ...QUEST_CATEGORIES] as const) {
        const list = sec === "all" ? all : all.filter((q) => q.category === sec);
        const done = list.filter((q) => status(q) === "done").length;
        const b = el("button", `qb-tab${sec === book.section ? " active" : ""}`);
        b.append(el("span", "", sec === "all" ? "All" : CATEGORY_LABEL[sec]), el("small", "", `${done}/${list.length}`));
        b.addEventListener("click", () => { book.section = sec; book.open = null; rerender(); });
        tabs.append(b);
      }
      const mapBtn = el("button", "menu-btn qb-map", "Quest map");
      mapBtn.addEventListener("click", () => d.openQuestMap());
      const bar = el("div", "qb-bar");
      bar.append(el("div", "menu-foot qb-pins", `Pinned ${c.save.pinned.length}/2 · ★ pins a quest to your screen`), mapBtn);
      root.append(tabs, bar);

      const inSection = all.filter((q) => book.section === "all" || q.category === book.section);
      if (inSection.length === 0) root.append(el("div", "menu-foot", "No quests here yet."));
      // Grouped by act. Act quests are the act's key story beats and come first.
      const order = { active: 0, available: 1, done: 2, locked: 3 } as const;
      const acts = [...new Set(inSection.map((q) => q.act))].sort((a, b) => a - b);
      for (const act of acts) {
        const inAct = inSection.filter((q) => q.act === act);
        const doneN = inAct.filter((q) => status(q) === "done").length;
        const shown = inAct.filter((q) => status(q) !== "locked");
        // Acts you haven't reached yet stay a mystery.
        if (shown.length === 0 && doneN === 0) continue;
        const head = el("div", "qb-act");
        head.append(el("span", "", `Act ${act}${d.actNames.get(act) ? ` · ${d.actNames.get(act)}` : ""}`), el("b", "", `${doneN}/${inAct.length}`));
        root.append(head);
        shown.sort((a, b) => (a.category === "act" ? 0 : 1) - (b.category === "act" ? 0 : 1) || order[status(a)] - order[status(b)] || a.name.localeCompare(b.name));
        for (const q of shown) {
          const s = status(q);
          const row = el("div", `quest-row ${s}${q.category === "act" ? " key" : ""}`);
          const pinned = c.save.pinned.includes(q.id);
          const pin = el("button", `q-pin${pinned ? " on" : ""}`, pinned ? "★" : "☆");
          pin.title = s !== "active" ? "Only active quests can be pinned" : pinned ? "Unpin" : "Pin to screen";
          pin.disabled = s !== "active";
          pin.addEventListener("click", (e) => {
            e.stopPropagation();
            d.send({ type: "pinQuest", quest: q.id, pinned: !pinned });
          });
          const name = el("span", "q-name", q.name);
          if (q.category === "act") name.prepend(el("span", "q-key", "◆"));
          row.append(el("span", "q-dot"), name);
          if (book.section === "all" && q.category !== "act") row.append(el("span", "q-cat", CATEGORY_LABEL[q.category]));
          row.append(pin);
          row.title = q.category === "act" ? "Act quest: a key part of this act's story" : "";
          row.addEventListener("click", () => { book.open = book.open === q.id ? null : q.id; rerender(); });
          root.append(row);
          if (book.open === q.id) root.append(questDetail(d, c, eng, q, s));
        }
        const hidden = inAct.length - shown.length;
        if (hidden > 0) root.append(el("div", "qb-hidden", `${hidden} more to discover`));
      }
    },
  };
}

function questDetail(d: MenuDeps, c: Character, eng: QuestEngine, q: QuestDef, s: string): HTMLElement {
  const box = el("div", "quest-detail");
  // The summary only shows once you've started the quest: before that it spoils the story.
  if (q.summary && (s === "active" || s === "done")) box.append(el("div", "qd-summary", q.summary));
  // Requirements, each ticked or not.
  const r = q.requirements;
  const reqs: Array<[string, boolean]> = [
    ...r.quests.map((id): [string, boolean] => [`Complete "${d.quests.get(id)?.name ?? id}"`, eng.status(id) === "done"]),
    ...(r.combatLevel ? [[`Combat level ${r.combatLevel}`, c.combatLevel >= r.combatLevel] as [string, boolean]] : []),
    ...(r.adventureLevel ? [[`Adventuring level ${r.adventureLevel}`, c.level("adventuring") >= r.adventureLevel] as [string, boolean]] : []),
    ...(Object.entries(r.skills) as Array<[Discipline, number]>).map(([k, v]): [string, boolean] => [`${DISCIPLINE_NAMES[k]} level ${v}`, c.level(k) >= v]),
  ];
  if (reqs.length && s !== "done") {
    box.append(el("div", "qd-label", "Requirements"));
    for (const [text, met] of reqs) box.append(el("div", `qd-req${met ? " met" : ""}`, text));
  }
  if (s === "available" || s === "locked") {
    if (q.start) box.append(el("div", "qd-start", `Start: ${q.start}`));
  } else if (s === "active") {
    const st = c.save.quests[q.id]!;
    const idx = st.stage as number;
    // Journal so far: finished steps crossed out, then the current one.
    q.steps.slice(0, idx).forEach((step) => box.append(el("div", "qd-journal past", step.journal)));
    const step = q.steps[idx];
    if (step) {
      box.append(el("div", "qd-journal", step.journal));
      for (const o of step.objectives) {
        const p = eng.progress(q, o);
        box.append(el("div", `qd-obj${p.have >= p.need ? " met" : ""}`, p.need > 1 ? `${o.text} (${p.have}/${p.need})` : o.text));
      }
    }
  } else {
    box.append(el("div", "qd-done", "Completed."));
  }
  const rw = q.rewards;
  const rewards = [
    ...Object.entries(rw.xp).map(([k, v]) => `${v} ${DISCIPLINE_NAMES[k as Discipline]} XP`),
    ...(rw.coins ? [`${rw.coins} coins`] : []),
    ...rw.items.map((i) => `${i.qty > 1 ? `${i.qty}× ` : ""}${c.def(i.item)?.name ?? i.item}`),
  ];
  if (rewards.length) box.append(el("div", "qd-rewards", `Rewards: ${rewards.join(", ")}`));
  return box;
}

// --- Friends -----------------------------------------------------------------------------------

function friendsTab(d: MenuDeps): TabDef {
  return {
    id: "friends",
    title: "Friends",
    icon: ICONS.friends,
    render(root) {
      const c = d.character();
      const form = el("form", "friend-form");
      const input = el("input");
      input.placeholder = "Player name";
      input.maxLength = 12;
      const add = el("button", "menu-btn", "Add");
      form.append(input, add);
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const name = input.value.trim();
        if (!PLAYER_NAME.test(name)) {
          input.classList.add("bad");
          return;
        }
        d.send({ type: "addFriend", name });
      });
      input.addEventListener("keydown", (e) => e.stopPropagation()); // typing doesn't trigger game keys
      root.append(form);
      if (c.save.friends.length === 0) root.append(el("div", "menu-foot", "No friends yet."));
      for (const f of c.save.friends) {
        const row = el("div", "friend-row");
        const rm = el("button", "friend-rm", "×");
        rm.title = `Remove ${f}`;
        rm.addEventListener("click", () => d.send({ type: "removeFriend", name: f }));
        row.append(el("span", "f-dot"), el("span", "f-name", f), el("span", "f-status", "Offline"), rm);
        root.append(row);
      }
      root.append(el("div", "menu-foot", "Online status arrives with multiplayer."));
    },
  };
}

/** All gameplay tabs, in strip order. */
export function gameTabs(d: MenuDeps, controls: TabDef): TabDef[] {
  return [characterTab(d), skillsTab(d), questsTab(d), friendsTab(d), controls];
}
