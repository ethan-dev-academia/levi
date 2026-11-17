import type { Character, QuestDef, QuestEngine } from "@levi/shared";

/**
 * Up to two pinned quests on screen: name + current step's objectives with
 * progress. Click opens the quest book.
 */
export class QuestTracker {
  private readonly root = document.createElement("div");

  constructor(host: HTMLElement, private readonly onOpen: () => void) {
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
    for (const q of pinned) {
      const box = document.createElement("div");
      box.className = "qt-quest";
      const name = document.createElement("div");
      name.className = "qt-name";
      name.textContent = q.name;
      box.append(name);
      const step = engine.step(q);
      for (const o of step?.objectives ?? []) {
        const p = engine.progress(q, o);
        const line = document.createElement("div");
        line.className = `qt-obj${p.have >= p.need ? " met" : ""}`;
        line.textContent = p.need > 1 ? `${o.text} (${p.have}/${p.need})` : o.text;
        box.append(line);
      }
      this.root.append(box);
    }
  }
}
