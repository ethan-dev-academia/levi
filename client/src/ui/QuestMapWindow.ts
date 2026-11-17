import type { QuestDef, QuestEngine } from "@levi/shared";
import { questGraph, questGraphLegend, type QuestNodeStatus } from "./questGraph.js";

export interface QuestMapDeps {
  quests: ReadonlyMap<string, QuestDef>;
  engine(): QuestEngine;
  actNames: ReadonlyMap<number, string>;
  /** A card was clicked: show that quest in the quest book. */
  pick(id: string): void;
}

/** What a player may see of a quest: finished, in progress, or ready to start. Anything further is hidden. */
export function playerQuestStatus(eng: QuestEngine, q: QuestDef): QuestNodeStatus {
  const st = eng.status(q.id);
  if (st === "done" || st === "active") return st;
  return eng.missing(q).length === 0 ? "available" : "locked";
}

/**
 * The player's quest map: their journey as a chart, but only what they've
 * done, what they're doing and what they could start now. The road ahead
 * stays hidden until they get there.
 */
export class QuestMapWindow {
  private readonly root = document.createElement("div");

  constructor(host: HTMLElement, private readonly deps: QuestMapDeps) {
    this.root.className = "quest-map-window";
    this.root.hidden = true;
    this.root.addEventListener("pointerdown", (e) => e.stopPropagation());
    host.append(this.root);
    window.addEventListener("keydown", (e) => {
      if (e.code === "Escape" && this.isOpen) this.close();
    });
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  open(): void {
    this.root.hidden = false;
    this.render();
  }

  close(): void {
    this.root.hidden = true;
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  refresh(): void {
    if (this.isOpen) this.render();
  }

  private render(): void {
    const eng = this.deps.engine();
    const all = [...this.deps.quests.values()];
    const status = new Map(all.map((q) => [q.id, playerQuestStatus(eng, q)]));
    const visible = all.filter((q) => status.get(q.id) !== "locked");
    const done = all.filter((q) => status.get(q.id) === "done").length;

    const head = document.createElement("header");
    head.className = "qm-head";
    const title = document.createElement("h2");
    title.textContent = "Quest Map";
    const sub = document.createElement("div");
    sub.className = "qm-sub";
    sub.textContent = `${done} of ${all.length} quests complete. The road ahead reveals itself as you walk it.`;
    const titles = document.createElement("div");
    titles.append(title, sub);
    const close = document.createElement("button");
    close.className = "menu-btn";
    close.textContent = "Close";
    close.addEventListener("click", () => this.close());
    head.append(titles, close);

    const actLabel = (a: number): string => {
      const inAct = all.filter((q) => q.act === a);
      const d = inAct.filter((q) => status.get(q.id) === "done").length;
      const name = this.deps.actNames.get(a);
      return `Act ${a}${name ? ` · ${name}` : ""}  ·  ${d}/${inAct.length}`;
    };
    const body = visible.length
      ? questGraph({
          quests: visible,
          status: (id) => status.get(id) ?? "locked",
          selected: null,
          onPick: (id) => this.deps.pick(id),
          meta: (q) => (q.category === "act" ? "Act quest" : `${q.category[0]!.toUpperCase()}${q.category.slice(1)} quest`) + (status.get(q.id) === "available" ? " · ready to start" : ""),
          tooltip: (q) => (status.get(q.id) === "available" ? `${q.name}\n${q.start ? `Start: ${q.start}` : "Ready to start"}` : `${q.name}\n${q.summary}`),
          actLabel,
        })
      : Object.assign(document.createElement("div"), { className: "qm-empty", textContent: "No quests yet." });
    this.root.replaceChildren(head, questGraphLegend("Drag to pan · wheel to zoom · click a quest to open it"), body);
  }
}
