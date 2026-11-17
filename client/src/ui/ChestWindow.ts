import type { Intent, ItemStack } from "@levi/shared";
import type { ItemUi } from "./ItemUi.js";

export interface ChestSource {
  /** Current contents as this player sees them (null = chest gone). */
  contents(propId: string): Array<ItemStack | null> | null;
  send(intent: Intent): void;
}

/**
 * Loot window for an opened chest: a grid of slots (2 rows × 4), click a slot
 * to take it, or Take all. Purely a view: taking goes through intents and
 * the sim decides (adjacency, bag space).
 */
export class ChestWindow {
  private readonly root = document.createElement("div");
  private readonly title = document.createElement("h3");
  private readonly grid = document.createElement("div");
  private propId: string | null = null;

  constructor(
    host: HTMLElement,
    private readonly items: ItemUi,
    private readonly source: ChestSource,
  ) {
    this.root.className = "chest-window";
    this.root.hidden = true;
    this.grid.className = "chest-grid";
    const takeAll = document.createElement("button");
    takeAll.className = "menu-btn primary";
    takeAll.textContent = "Take all";
    takeAll.addEventListener("click", () => this.propId && this.source.send({ type: "lootTake", prop: this.propId, index: -1 }));
    const close = document.createElement("button");
    close.className = "menu-btn";
    close.textContent = "Close";
    close.addEventListener("click", () => this.close());
    const foot = document.createElement("div");
    foot.className = "chest-foot";
    foot.append(takeAll, close);
    this.root.append(this.title, this.grid, foot);
    this.root.addEventListener("pointerdown", (e) => e.stopPropagation());
    host.appendChild(this.root);
  }

  get openId(): string | null {
    return this.propId;
  }

  open(propId: string, name: string): void {
    this.propId = propId;
    this.title.textContent = name;
    this.root.hidden = false;
    this.refresh();
  }

  close(): void {
    this.propId = null;
    this.root.hidden = true;
  }

  /** Redraw after the character (or chest) changed. */
  refresh(): void {
    if (!this.propId) return;
    const contents = this.source.contents(this.propId);
    if (!contents) {
      this.close();
      return;
    }
    const id = this.propId;
    this.grid.replaceChildren();
    contents.forEach((stack, i) => {
      const slot = document.createElement("div");
      slot.className = "chest-slot";
      this.items.renderLoose(slot, stack, () => stack && this.source.send({ type: "lootTake", prop: id, index: i }));
      this.grid.append(slot);
    });
    if (contents.every((s) => !s)) {
      const empty = document.createElement("div");
      empty.className = "chest-empty";
      empty.textContent = "It's empty.";
      this.grid.append(empty);
    }
  }
}
