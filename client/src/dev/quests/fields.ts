import {
  DISCIPLINE_NAMES,
  DISCIPLINES,
  type Condition,
  type Effect,
  type ItemDef,
  type NpcDef,
  type PropDef,
  type QuestDef,
} from "@levi/shared";
import { h } from "../dom.js";

/** Lookups the quest/NPC forms need for their dropdowns. */
export interface EditorLookups {
  quests: ReadonlyMap<string, QuestDef>;
  npcs: ReadonlyMap<string, NpcDef>;
  items: ReadonlyMap<string, ItemDef>;
  propDefs: ReadonlyMap<string, PropDef>;
  regions(): ReadonlyArray<{ id: string; name: string }>;
}

/** Stop game hotkeys while typing in editor inputs. */
export function guard<T extends HTMLElement>(el: T): T {
  el.addEventListener("keydown", (e) => e.stopPropagation());
  return el;
}

export function field(label: string, control: HTMLElement, className = "im-field"): HTMLElement {
  return h("label", { className }, label, control);
}

export function textInput(value: string, set: (v: string) => void, placeholder = ""): HTMLInputElement {
  const i = guard(h("input", { type: "text", value, placeholder }));
  i.addEventListener("input", () => set(i.value));
  return i;
}

export function textArea(value: string, set: (v: string) => void, rows = 2): HTMLTextAreaElement {
  const t = guard(h("textarea", { value, rows }));
  t.addEventListener("input", () => set(t.value));
  return t;
}

export function numInput(value: number | undefined, set: (v: number | undefined) => void, step = "1"): HTMLInputElement {
  const i = guard(h("input", { type: "number", step, value: value === undefined ? "" : String(value) }));
  i.addEventListener("input", () => set(i.value === "" ? undefined : Number(i.value)));
  return i;
}

/** <select> from [value, label] pairs; `none` adds an empty first option. */
export function selectInput(value: string, options: ReadonlyArray<readonly [string, string]>, set: (v: string) => void, none?: string): HTMLSelectElement {
  const s = h("select", {});
  if (none !== undefined) s.append(h("option", { value: "" }, none));
  for (const [v, label] of options) s.append(h("option", { value: v, selected: v === value }, label));
  if (value && !options.some(([v]) => v === value)) s.append(h("option", { value, selected: true }, `${value} (missing)`));
  s.addEventListener("change", () => set(s.value));
  return s;
}

export const questOptions = (l: EditorLookups): Array<[string, string]> => [...l.quests.values()].map((q) => [q.id, q.name]);
export const npcOptions = (l: EditorLookups): Array<[string, string]> => [...l.npcs.values()].map((n) => [n.id, n.name]);
export const itemOptions = (l: EditorLookups): Array<[string, string]> =>
  [...l.items.values()].sort((a, b) => a.name.localeCompare(b.name)).map((i) => [i.id, i.name]);
export const stepOptions = (l: EditorLookups, quest: string): Array<[string, string]> =>
  (l.quests.get(quest)?.steps ?? []).map((s, i) => [s.id, `${i + 1}. ${s.id}`]);
export const objectiveOptions = (l: EditorLookups, quest: string): Array<[string, string]> =>
  (l.quests.get(quest)?.steps ?? []).flatMap((s) => s.objectives.map((o): [string, string] => [o.id, `${s.id} › ${o.text}`]));

// --- Conditions ----------------------------------------------------------------------------

const CONDITION_KINDS: ReadonlyArray<[Condition["kind"], string]> = [
  ["questStatus", "Quest status"], ["questStep", "Quest on step"], ["objectiveDone", "Objective done"],
  ["flag", "Flag"], ["hasItem", "Has item"], ["coins", "Coins ≥"], ["level", "Level ≥"],
];

function blankCondition(kind: Condition["kind"], l: EditorLookups): Condition {
  const q = [...l.quests.keys()][0] ?? "quest";
  switch (kind) {
    case "questStatus": return { kind, quest: q, status: "active" };
    case "questStep": return { kind, quest: q, step: l.quests.get(q)?.steps[0]?.id ?? "step" };
    case "objectiveDone": return { kind, quest: q, objective: l.quests.get(q)?.steps[0]?.objectives[0]?.id ?? "objective" };
    case "flag": return { kind, flag: "some-flag", set: true };
    case "hasItem": return { kind, item: [...l.items.keys()][0] ?? "item", qty: 1 };
    case "coins": return { kind, min: 1 };
    case "level": return { kind, skill: "combat", min: 1 };
  }
}

/** Editable list of conditions ("only when…"). Mutates `list`; calls `changed` to redraw. */
export function conditionList(list: Condition[], l: EditorLookups, changed: () => void, title = "Only when"): HTMLElement {
  const box = h("div", { className: "qe-rows" }, h("div", { className: "qe-rows-title" }, list.length ? title : `${title}: always`));
  list.forEach((c, i) => {
    const set = (next: Condition): void => {
      list[i] = next;
      changed();
    };
    const kind = selectInput(c.kind, CONDITION_KINDS, (k) => set(blankCondition(k as Condition["kind"], l)));
    const row = h("div", { className: "qe-row" }, kind);
    switch (c.kind) {
      case "questStatus":
        row.append(selectInput(c.quest, questOptions(l), (v) => set({ ...c, quest: v })),
          selectInput(c.status, [["notStarted", "not started"], ["active", "active"], ["done", "done"], ["started", "started (active or done)"], ["notDone", "not done yet"]], (v) => set({ ...c, status: v as typeof c.status })));
        break;
      case "questStep":
        row.append(selectInput(c.quest, questOptions(l), (v) => set({ ...c, quest: v, step: l.quests.get(v)?.steps[0]?.id ?? "" })),
          selectInput(c.step, stepOptions(l, c.quest), (v) => set({ ...c, step: v })));
        break;
      case "objectiveDone":
        row.append(selectInput(c.quest, questOptions(l), (v) => set({ ...c, quest: v, objective: objectiveOptions(l, v)[0]?.[0] ?? "" })),
          selectInput(c.objective, objectiveOptions(l, c.quest), (v) => set({ ...c, objective: v })));
        break;
      case "flag":
        row.append(textInput(c.flag, (v) => (c.flag = v.trim())), selectInput(c.set ? "1" : "0", [["1", "is set"], ["0", "is not set"]], (v) => set({ ...c, set: v === "1" })));
        break;
      case "hasItem":
        row.append(selectInput(c.item, itemOptions(l), (v) => set({ ...c, item: v })), numInput(c.qty, (v) => (c.qty = Math.max(1, Math.round(v ?? 1)))));
        break;
      case "coins":
        row.append(numInput(c.min, (v) => (c.min = Math.max(0, Math.round(v ?? 0)))));
        break;
      case "level":
        row.append(selectInput(c.skill, [["combat", "Combat (highest)"], ...DISCIPLINES.map((d): [string, string] => [d, DISCIPLINE_NAMES[d]])], (v) => set({ ...c, skill: v as typeof c.skill })),
          numInput(c.min, (v) => (c.min = Math.max(1, Math.min(50, Math.round(v ?? 1))))));
        break;
    }
    row.append(h("button", { className: "qe-x", title: "Remove", onclick: () => { list.splice(i, 1); changed(); } }, "×"));
    box.append(row);
  });
  box.append(h("button", { className: "dev-btn qe-add", onclick: () => { list.push(blankCondition("questStatus", l)); changed(); } }, "+ Condition"));
  return box;
}

// --- Effects --------------------------------------------------------------------------------

const EFFECT_KINDS: ReadonlyArray<[Effect["kind"], string]> = [
  ["startQuest", "Start quest"], ["objective", "Complete objective"], ["giveItem", "Give item"],
  ["takeItem", "Take item"], ["coins", "Coins ±"], ["setFlag", "Set flag"], ["grantSkill", "Grant secret skill"],
];

function blankEffect(kind: Effect["kind"], l: EditorLookups): Effect {
  const q = [...l.quests.keys()][0] ?? "quest";
  switch (kind) {
    case "startQuest": return { kind, quest: q };
    case "objective": return { kind, quest: q, objective: objectiveOptions(l, q)[0]?.[0] ?? "objective" };
    case "giveItem": return { kind, item: [...l.items.keys()][0] ?? "item", qty: 1 };
    case "takeItem": return { kind, item: [...l.items.keys()][0] ?? "item", qty: 1 };
    case "coins": return { kind, amount: 10 };
    case "setFlag": return { kind, flag: "some-flag", value: true };
    case "grantSkill": return { kind, style: "mage", skill: "sunfall-verdict" };
  }
}

/** Editable list of effects ("then…"). */
export function effectList(list: Effect[], l: EditorLookups, changed: () => void, title = "Then"): HTMLElement {
  const box = h("div", { className: "qe-rows effects" }, h("div", { className: "qe-rows-title" }, list.length ? title : `${title}: nothing happens`));
  list.forEach((e, i) => {
    const set = (next: Effect): void => {
      list[i] = next;
      changed();
    };
    const row = h("div", { className: "qe-row" }, selectInput(e.kind, EFFECT_KINDS, (k) => set(blankEffect(k as Effect["kind"], l))));
    switch (e.kind) {
      case "startQuest":
        row.append(selectInput(e.quest, questOptions(l), (v) => set({ ...e, quest: v })));
        break;
      case "objective":
        row.append(selectInput(e.quest, questOptions(l), (v) => set({ ...e, quest: v, objective: objectiveOptions(l, v)[0]?.[0] ?? "" })),
          selectInput(e.objective, objectiveOptions(l, e.quest), (v) => set({ ...e, objective: v })));
        break;
      case "giveItem":
      case "takeItem":
        row.append(selectInput(e.item, itemOptions(l), (v) => set({ ...e, item: v })), numInput(e.qty, (v) => (e.qty = Math.max(1, Math.round(v ?? 1)))));
        break;
      case "coins":
        row.append(numInput(e.amount, (v) => (e.amount = Math.round(v ?? 0))));
        break;
      case "setFlag":
        row.append(textInput(e.flag, (v) => (e.flag = v.trim())), selectInput(e.value ? "1" : "0", [["1", "on"], ["0", "off"]], (v) => set({ ...e, value: v === "1" })));
        break;
      case "grantSkill":
        row.append(selectInput(e.style, [["mage", "Mage"], ["ranger", "Ranger"], ["brawler", "Brawler"]], (v) => set({ ...e, style: v as typeof e.style })),
          textInput(e.skill, (v) => (e.skill = v.trim()), "secret skill id"));
        break;
    }
    row.append(h("button", { className: "qe-x", title: "Remove", onclick: () => { list.splice(i, 1); changed(); } }, "×"));
    box.append(row);
  });
  box.append(h("button", { className: "dev-btn qe-add", onclick: () => { list.push(blankEffect("startQuest", l)); changed(); } }, "+ Effect"));
  return box;
}

/** Short human summary of an effect (for graph labels). */
export function describeEffect(e: Effect, l: EditorLookups): string {
  switch (e.kind) {
    case "startQuest": return `▶ ${l.quests.get(e.quest)?.name ?? e.quest}`;
    case "objective": return `✓ ${e.quest}/${e.objective}`;
    case "giveItem": return `+${e.qty} ${l.items.get(e.item)?.name ?? e.item}`;
    case "takeItem": return `−${e.qty} ${l.items.get(e.item)?.name ?? e.item}`;
    case "coins": return `${e.amount >= 0 ? "+" : ""}${e.amount} coins`;
    case "setFlag": return `${e.value ? "⚑" : "⚐"} ${e.flag}`;
    case "grantSkill": return `★ ${e.skill}`;
  }
}

/** Post a content file to the dev server; returns an error string or null. */
export async function saveContent(kind: "npc" | "quest" | "enemy", data: unknown): Promise<string | null> {
  return post("/__dev/save-content", { kind, data });
}

export async function deleteContent(kind: "npc" | "quest" | "enemy", id: string): Promise<string | null> {
  return post("/__dev/delete-content", { kind, id });
}

async function post(url: string, body: unknown): Promise<string | null> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (res.ok) return null;
  const text = await res.text();
  try {
    const j = JSON.parse(text) as { error?: unknown };
    return Array.isArray(j.error) ? j.error.join("\n") : String(j.error ?? text);
  } catch {
    return text;
  }
}
