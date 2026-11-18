import type { Character, QuestDef, QuestEngine } from "@levi/shared";

/**
 * The pinned quests on screen (the newest pins itself): name, what to do
 * now in a sentence, and the current step's objectives with progress. A
 * quest glows briefly when it moves on. Click opens the quest book.
 */
export class QuestTracker {
  private readonly root = document.createElement("div");
  /** Last drawn state per quest, to notice progress. */
  private readonly last = new Map<string, string>();
  /** When each quest last moved on (ms), so the glow survives redraws. */
  private readonly changedAt = new Map<string, number>();

  constructor(
    host: HTMLElement,
    private readonly onOpen: () => void,
    /** Click an objective: show where it is on the world map. */
    private readonly onLocate: (questId: string) => void = () => {},
  ) {
    this.root.className = "quest-tracker";
    this.root.hidden = true;
    this.root.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.root.addEventListener("click", () => this.onOpen());
    host.append(this.root);
  }

  render(c: Character, engine: QuestEngine, quests: ReadonlyMap<string, QuestDef>): void {
    this.root.replaceChildren();
    const pinned = c.save.pinned.map((id) => quests.get(id)).filter((q): q is QuestDef => !!q && engine.status(q.id) === "active");
    this.root.hidden = pinned.length === 0;
    pinned.forEach((q, i) => {
      const box = document.createElement("div");
      box.className = `qt-quest${i === 0 ? " primary" : ""}`;
      const name = document.createElement("div");
      name.className = "qt-name";
      name.textContent = q.name;
      box.append(name);
      const step = engine.step(q);
      if (step && i === 0) {
        const hint = document.createElement("div");
        hint.className = "qt-hint";
        hint.textContent = step.journal.split(/(?<=[.!?])\s/)[0] ?? "";
        box.append(hint);
      }
      const sig: string[] = [step?.id ?? ""];
      for (const o of step?.objectives ?? []) {
        const p = engine.progress(q, o);
        sig.push(`${p.have}`);
        const line = document.createElement("div");
        line.className = `qt-obj${p.have >= p.need ? " met" : ""}`;
        line.textContent = p.need > 1 ? `${o.text} (${p.have}/${p.need})` : o.text;
        line.title = "Show on the map";
        line.addEventListener("click", (e) => {
          e.stopPropagation();
          this.onLocate(q.id);
        });
        box.append(line);
      }
      const key = sig.join("|");
      const before = this.last.get(q.id);
      const now = performance.now();
      if (before !== undefined && before !== key) this.changedAt.set(q.id, now);
      this.last.set(q.id, key);
      const since = now - (this.changedAt.get(q.id) ?? -1e9);
      if (since < 1600) {
        box.classList.add("pulse");
        box.style.animationDelay = `-${Math.round(since)}ms`;
      }
      this.root.append(box);
    });
  }
}
