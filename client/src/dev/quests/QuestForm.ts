import {
  DISCIPLINE_NAMES,
  DISCIPLINES,
  QUEST_CATEGORIES,
  type Discipline,
  type Objective,
  type QuestDef,
  type QuestStep,
} from "@levi/shared";
import { h } from "../dom.js";
import {
  field,
  itemOptions,
  npcOptions,
  numInput,
  selectInput,
  textArea,
  textInput,
  type EditorLookups,
} from "./fields.js";

const OBJECTIVE_KINDS: ReadonlyArray<[Objective["kind"], string]> = [
  ["talk", "Talk to"], ["defeat", "Defeat"], ["collect", "Collect (hold)"], ["pickup", "Pick up"],
  ["reach", "Reach region"], ["use", "Use object"], ["trigger", "Trigger (dialogue/script)"],
];

let objCounter = 0;
function newObjective(kind: Objective["kind"], l: EditorLookups, existing: ReadonlySet<string>): Objective {
  let id = `${kind}-${++objCounter}`;
  while (existing.has(id)) id = `${kind}-${++objCounter}`;
  const base = { id, text: "Describe the objective" };
  switch (kind) {
    case "talk": return { ...base, kind, npc: [...l.npcs.keys()][0] ?? "npc" };
    case "defeat": return { ...base, kind, enemy: "enemy", qty: 1, boss: false };
    case "collect": return { ...base, kind, item: [...l.items.keys()][0] ?? "item", qty: 1, consume: true };
    case "pickup": return { ...base, kind, item: [...l.items.keys()][0] ?? "item", qty: 1 };
    case "reach": return { ...base, kind, region: l.regions()[0]?.id ?? "region" };
    case "use": return { ...base, kind, prop: [...l.propDefs.keys()][0] ?? "prop" };
    case "trigger": return { ...base, kind };
  }
}

/**
 * Quest form: basics, requirements, steps (each with typed objectives) and
 * rewards. Edits `q` in place; `changed` redraws.
 */
export function questForm(q: QuestDef, isNew: boolean, l: EditorLookups, changed: () => void): HTMLElement {
  const root = h("div", { className: "qe-form" });
  const allObjectiveIds = (): Set<string> => new Set(q.steps.flatMap((s) => s.objectives.map((o) => o.id)));

  // --- Basics ---
  root.append(
    h("div", { className: "im-grid" },
      field("Name", textInput(q.name, (v) => (q.name = v))),
      field("Id (file name)", (() => { const i = textInput(q.id, (v) => (q.id = v.trim())); i.disabled = !isNew; return i; })()),
      field("Category", selectInput(q.category, QUEST_CATEGORIES.map((c): [string, string] => [c, c]), (v) => { q.category = v as QuestDef["category"]; changed(); })),
      field("Act", numInput(q.act, (v) => (q.act = Math.max(0, Math.min(20, Math.round(v ?? 0)))))),
      field("Giver (NPC)", selectInput(q.giver ?? "", npcOptions(l), (v) => { if (v) q.giver = v; else delete q.giver; }, "—")),
      field("Start hint", textInput(q.start, (v) => (q.start = v), "e.g. Warden Ilsa")),
    ),
    field("Summary", textArea(q.summary, (v) => (q.summary = v))),
  );

  // --- Requirements ---
  const r = q.requirements;
  const reqQuests = h("div", { className: "qe-checks" });
  for (const [id, name] of [...l.quests.values()].filter((x) => x.id !== q.id).map((x) => [x.id, x.name] as const)) {
    const cb = h("input", { type: "checkbox", checked: r.quests.includes(id) });
    cb.addEventListener("change", () => {
      r.quests = cb.checked ? [...r.quests, id] : r.quests.filter((x) => x !== id);
    });
    reqQuests.append(h("label", { className: "qe-check" }, cb, name));
  }
  const reqSkills = h("div", { className: "im-grid" });
  for (const d of DISCIPLINES) {
    reqSkills.append(field(DISCIPLINE_NAMES[d], numInput(r.skills[d], (v) => {
      if (!v) delete r.skills[d];
      else r.skills[d] = Math.max(1, Math.min(50, Math.round(v)));
    }), "im-field small"));
  }
  root.append(
    h("h3", {}, "Requirements"),
    h("div", { className: "dev-empty" }, "Quests that must be complete first:"),
    reqQuests,
    h("div", { className: "im-grid" },
      field("Combat level (highest style)", numInput(r.combatLevel, (v) => { if (v) r.combatLevel = Math.round(v); else delete r.combatLevel; })),
      field("Adventuring level", numInput(r.adventureLevel, (v) => { if (v) r.adventureLevel = Math.round(v); else delete r.adventureLevel; })),
    ),
    field("Flags needed (comma separated)", textInput(r.flags.join(", "), (v) => (r.flags = v.split(",").map((s) => s.trim()).filter(Boolean)))),
    h("details", { className: "qe-more" }, h("summary", {}, "Skill levels…"), reqSkills),
  );

  // --- Steps ---
  root.append(h("h3", {}, "Steps"));
  q.steps.forEach((step, si) => root.append(stepCard(q, step, si, l, changed, allObjectiveIds)));
  root.append(h("button", { className: "dev-btn", onclick: () => {
    let n = q.steps.length + 1;
    while (q.steps.some((s) => s.id === `step-${n}`)) n++;
    q.steps.push({ id: `step-${n}`, journal: "What the player writes in their journal.", objectives: [newObjective("talk", l, allObjectiveIds())] });
    changed();
  } }, "+ Step"));

  // --- Rewards ---
  const rw = q.rewards;
  const xp = h("div", { className: "im-grid" });
  for (const d of ["adventuring", ...DISCIPLINES.filter((x) => x !== "adventuring")] as Discipline[]) {
    xp.append(field(`${DISCIPLINE_NAMES[d]} XP`, numInput(rw.xp[d], (v) => {
      if (!v) delete rw.xp[d];
      else rw.xp[d] = Math.max(1, Math.round(v));
    }), "im-field small"));
  }
  const items = h("div", { className: "qe-rows" });
  rw.items.forEach((it, i) => {
    items.append(h("div", { className: "qe-row" },
      selectInput(it.item, itemOptions(l), (v) => { it.item = v; }),
      numInput(it.qty, (v) => (it.qty = Math.max(1, Math.round(v ?? 1)))),
      h("button", { className: "qe-x", onclick: () => { rw.items.splice(i, 1); changed(); } }, "×")));
  });
  items.append(h("button", { className: "dev-btn qe-add", onclick: () => { rw.items.push({ item: [...l.items.keys()][0] ?? "item", qty: 1 }); changed(); } }, "+ Item"));
  root.append(
    h("h3", {}, "Rewards"),
    field("Coins", numInput(rw.coins, (v) => (rw.coins = Math.max(0, Math.round(v ?? 0))))),
    xp,
    h("div", { className: "qe-rows-title" }, "Items"),
    items,
    field("Unlock flags (comma separated)", textInput(rw.unlocks.join(", "), (v) => (rw.unlocks = v.split(",").map((s) => s.trim()).filter(Boolean)))),
  );
  return root;
}

function stepCard(q: QuestDef, step: QuestStep, si: number, l: EditorLookups, changed: () => void, ids: () => Set<string>): HTMLElement {
  const move = (d: number): void => {
    const j = si + d;
    if (j < 0 || j >= q.steps.length) return;
    [q.steps[si], q.steps[j]] = [q.steps[j]!, q.steps[si]!];
    changed();
  };
  const card = h(
    "div",
    { className: "qe-step" },
    h("div", { className: "qe-step-head" },
      h("b", {}, `Step ${si + 1}`),
      textInput(step.id, (v) => (step.id = v.trim())),
      h("button", { className: "qe-x", title: "Move up", onclick: () => move(-1) }, "↑"),
      h("button", { className: "qe-x", title: "Move down", onclick: () => move(1) }, "↓"),
      h("button", { className: "qe-x", title: "Delete step", onclick: () => { if (q.steps.length > 1 && confirm(`Delete step ${si + 1}?`)) { q.steps.splice(si, 1); changed(); } } }, "×")),
    field("Journal", textArea(step.journal, (v) => (step.journal = v))),
  );
  step.objectives.forEach((o, oi) => card.append(objectiveRow(step, o, oi, l, changed, ids)));
  card.append(h("button", { className: "dev-btn qe-add", onclick: () => { step.objectives.push(newObjective("talk", l, ids())); changed(); } }, "+ Objective"));
  return card;
}

function objectiveRow(step: QuestStep, o: Objective, oi: number, l: EditorLookups, changed: () => void, ids: () => Set<string>): HTMLElement {
  const set = (next: Objective): void => {
    step.objectives[oi] = next;
    changed();
  };
  const head = h("div", { className: "qe-row" },
    selectInput(o.kind, OBJECTIVE_KINDS, (k) => {
      const fresh = newObjective(k as Objective["kind"], l, ids());
      set({ ...fresh, id: o.id, text: o.text } as Objective);
    }),
    textInput(o.id, (v) => (o.id = v.trim()), "id"),
    h("button", { className: "qe-x", onclick: () => { if (step.objectives.length > 1) { step.objectives.splice(oi, 1); changed(); } } }, "×"));
  const detail = h("div", { className: "qe-row" });
  switch (o.kind) {
    case "talk": {
      const nodes = (l.npcs.get(o.npc)?.nodes ?? []).map((n): [string, string] => [n.id, `${n.id}: ${n.text.slice(0, 30)}`]);
      detail.append(selectInput(o.npc, npcOptions(l), (v) => set({ ...o, npc: v })),
        selectInput(o.node ?? "", nodes, (v) => { const { node: _n, ...rest } = o; set(v ? { ...rest, node: v } : rest); }, "(conversation ends)"));
      break;
    }
    case "defeat":
      detail.append(textInput(o.enemy, (v) => (o.enemy = v.trim()), "enemy id"), numInput(o.qty, (v) => (o.qty = Math.max(1, Math.round(v ?? 1)))),
        h("label", { className: "qe-check" }, (() => { const c = h("input", { type: "checkbox", checked: o.boss }); c.addEventListener("change", () => (o.boss = c.checked)); return c; })(), "Boss"));
      break;
    case "collect":
      detail.append(selectInput(o.item, itemOptions(l), (v) => (o.item = v)), numInput(o.qty, (v) => (o.qty = Math.max(1, Math.round(v ?? 1)))),
        h("label", { className: "qe-check" }, (() => { const c = h("input", { type: "checkbox", checked: o.consume }); c.addEventListener("change", () => (o.consume = c.checked)); return c; })(), "Take on finish"));
      break;
    case "pickup":
      detail.append(selectInput(o.item, itemOptions(l), (v) => (o.item = v)), numInput(o.qty, (v) => (o.qty = Math.max(1, Math.round(v ?? 1)))));
      break;
    case "reach":
      detail.append(selectInput(o.region, l.regions().map((r): [string, string] => [r.id, r.name]), (v) => (o.region = v)));
      break;
    case "use":
      detail.append(selectInput(o.prop, [...l.propDefs.values()].map((p): [string, string] => [p.id, p.name]), (v) => (o.prop = v)));
      break;
    case "trigger":
      detail.append(h("span", { className: "dev-empty" }, "Completed by a dialogue effect: “Complete objective”."));
      break;
  }
  return h("div", { className: "qe-obj" }, head, field("Journal line", textInput(o.text, (v) => (o.text = v))), detail);
}
