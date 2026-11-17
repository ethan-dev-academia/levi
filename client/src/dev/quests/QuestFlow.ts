import type { QuestDef } from "@levi/shared";
import { questGraph, questGraphLegend } from "../../ui/questGraph.js";
import { h } from "../dom.js";

export interface QuestFlowDeps {
  quests: ReadonlyMap<string, QuestDef>;
  /** Your character's progress on a quest (for the status dot). */
  status(id: string): "notStarted" | "active" | "done";
  open(id: string): void;
  selected: string | null;
}

/**
 * F2 → Flow view: every quest (of the ticked categories) as a progression
 * chart. Click a card to edit it. Flags requirements that point nowhere.
 */
export function questFlow(deps: QuestFlowDeps, filter: Set<QuestDef["category"]>): HTMLElement {
  const quests = [...deps.quests.values()].filter((q) => filter.has(q.category));
  const byId = new Map(quests.map((q) => [q.id, q]));
  const view = questGraph({
    quests,
    status: (id) => {
      const s = deps.status(id);
      return s === "notStarted" ? "locked" : s;
    },
    selected: deps.selected,
    onPick: deps.open,
    meta: (q) => `${q.category}${q.giver ? ` · ${q.giver}` : ""} · ${q.steps.length} step${q.steps.length > 1 ? "s" : ""}`,
    tooltip: (q) => {
      const rq = q.requirements.quests.filter((r) => byId.has(r));
      return `${q.name}\n${q.summary || "(no summary)"}${rq.length ? `\n\nRequires: ${rq.map((r) => byId.get(r)?.name ?? r).join(", ")}` : ""}`;
    },
    actLabel: (a) => `Act ${a}`,
  });
  view.classList.add("dev");
  const broken = quests.flatMap((q) => q.requirements.quests.filter((r) => !deps.quests.has(r)).map((r) => `${q.name} → missing "${r}"`));
  const root = h("div", { className: "qf-root" }, questGraphLegend("Drag to pan · wheel to zoom · hover to trace a chain · click to edit"));
  if (broken.length) root.append(h("div", { className: "qf-broken" }, `Missing requirements: ${broken.join("; ")}`));
  root.append(view);
  return root;
}
