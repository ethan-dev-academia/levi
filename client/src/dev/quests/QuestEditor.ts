import { EnemyDefSchema, NpcDefSchema, QuestDefSchema, type EnemyDef, type ModelDef, type NpcDef, type QuestDef, type QuestEngine, type Character } from "@levi/shared";
import { h } from "../dom.js";
import { deleteContent, guard, saveContent, type EditorLookups } from "./fields.js";
import { NpcEditor } from "./NpcEditor.js";
import { questForm } from "./QuestForm.js";
import { enemyForm } from "./EnemyForm.js";

export interface QuestEditorDeps {
  quests: Map<string, QuestDef>;
  npcs: Map<string, NpcDef>;
  lookups: EditorLookups;
  model(id: string): ModelDef | undefined;
  modelIds(): string[];
  engine(): QuestEngine;
  character(): Character;
  /** Quests changed (quest book, tracker). */
  onQuestsChanged(): void;
  /** NPC definitions changed (rebuild NPCs in the world). */
  onNpcsChanged(): void;
  enemies: Map<string, EnemyDef>;
  /** Models an enemy body can use. */
  enemyModelIds(): string[];
  onEnemiesChanged(): void;
  report(msg: string): void;
}

type Tab = "quests" | "npcs" | "enemies";

/**
 * F2: the quest editor. Quests (steps, objectives, requirements, rewards)
 * and NPCs (appearance + dialogue graph). Saving writes content/quests and
 * content/npcs and updates the running game.
 */
export class QuestEditor {
  readonly root: HTMLElement;
  private tab: Tab = "quests";
  private selected: string | null = null;
  /** Working copy of the selected definition (unsaved edits live here). */
  private work: QuestDef | NpcDef | EnemyDef | null = null;
  private isNew = false;
  private readonly list = h("div", { className: "qe-list" });
  private readonly main = h("div", { className: "qe-main" });
  private readonly tabs = h("div", { className: "qe-tabs" });
  private readonly search = guard(h("input", { type: "search", placeholder: "Search…" }));
  private readonly errors = h("pre", { className: "im-errors" });

  constructor(host: HTMLElement, private readonly deps: QuestEditorDeps) {
    this.search.addEventListener("input", () => this.renderList());
    this.root = h(
      "div",
      { className: "item-manager quest-editor", hidden: true },
      h("header", {}, h("h2", {}, "Quest editor (F2)"), this.tabs, this.search,
        h("button", { className: "dev-btn primary", onclick: () => this.create() }, "+ New"),
        h("button", { className: "dev-btn", onclick: () => this.close() }, "Close")),
      h("div", { className: "im-body" }, this.list, this.main),
    );
    this.root.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.root.addEventListener("keydown", (e) => e.stopPropagation());
    host.append(this.root);
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  open(): void {
    this.root.hidden = false;
    this.render();
  }

  close(): void {
    this.root.hidden = true;
  }

  private render(): void {
    this.tabs.replaceChildren(
      ...(["quests", "npcs", "enemies"] as const).map((t) =>
        h("button", { className: `dev-btn${this.tab === t ? " active" : ""}`, onclick: () => { this.tab = t; this.selected = null; this.work = null; this.render(); } },
          t === "quests" ? `Quests (${this.deps.quests.size})` : t === "npcs" ? `NPCs (${this.deps.npcs.size})` : `Enemies (${this.deps.enemies.size})`),
      ),
    );
    this.renderList();
    this.renderMain();
  }

  private renderList(): void {
    const q = this.search.value.trim().toLowerCase();
    this.list.replaceChildren();
    if (this.tab === "quests") {
      const all = [...this.deps.quests.values()].filter((x) => !q || x.name.toLowerCase().includes(q) || x.id.includes(q));
      const order = { act: 0, skill: 1, world: 2, adventurer: 3 } as const;
      all.sort((a, b) => order[a.category] - order[b.category] || a.act - b.act || a.name.localeCompare(b.name));
      let group = "";
      for (const quest of all) {
        const g = quest.category === "act" ? `Act ${quest.act}` : quest.category[0]!.toUpperCase() + quest.category.slice(1);
        if (g !== group) {
          group = g;
          this.list.append(h("div", { className: "qe-list-head" }, g));
        }
        const st = this.deps.engine().status(quest.id);
        this.list.append(this.listRow(quest.id, quest.name, st === "done" ? "✓" : st === "active" ? "●" : ""));
      }
    } else if (this.tab === "enemies") {
      for (const e of [...this.deps.enemies.values()].filter((x) => !q || x.name.toLowerCase().includes(q) || x.id.includes(q)).sort((a, b) => a.level - b.level || a.name.localeCompare(b.name))) {
        this.list.append(this.listRow(e.id, e.name, e.dummy ? "dummy" : `Lv ${e.level}`));
      }
    } else {
      const matches = (x: NpcDef): boolean => !q || x.name.toLowerCase().includes(q) || x.id.includes(q) || x.title.toLowerCase().includes(q) || x.location.toLowerCase().includes(q);
      for (const n of [...this.deps.npcs.values()].filter(matches).sort((a, b) => a.name.localeCompare(b.name) || a.location.localeCompare(b.location))) {
        this.list.append(this.listRow(n.id, n.name, n.location || n.title));
      }
    }
  }

  private listRow(id: string, name: string, note: string): HTMLElement {
    const row = h("div", { className: `qe-list-row${id === this.selected ? " active" : ""}` }, h("span", {}, name), h("small", {}, note));
    row.addEventListener("click", () => {
      this.selected = id;
      this.isNew = false;
      const src = this.tab === "quests" ? this.deps.quests.get(id) : this.tab === "enemies" ? this.deps.enemies.get(id) : this.deps.npcs.get(id);
      this.work = src ? structuredClone(src) : null;
      this.render();
    });
    return row;
  }

  private create(): void {
    if (this.tab === "quests") {
      let n = 1;
      while (this.deps.quests.has(`new-quest-${n}`)) n++;
      this.work = QuestDefSchema.parse({
        id: `new-quest-${n}`, name: "New Quest", category: "act", act: 0,
        steps: [{ id: "step-1", journal: "What the player writes in their journal.", objectives: [{ id: "talk-1", kind: "trigger", text: "Do the thing" }] }],
      });
    } else if (this.tab === "enemies") {
      let n = 1;
      while (this.deps.enemies.has(`new-enemy-${n}`)) n++;
      this.work = EnemyDefSchema.parse({ id: `new-enemy-${n}`, name: "New Enemy", attacks: [{ id: "attack-1", name: "Swipe", shape: "cone", range: 2, length: 2.4 }] });
    } else {
      let n = 1;
      while (this.deps.npcs.has(`new-npc-${n}`)) n++;
      this.work = NpcDefSchema.parse({
        id: `new-npc-${n}`, name: "New NPC",
        entries: [{ id: "default", label: "Default", start: "hello" }],
        nodes: [{ id: "hello", text: "Hello there.", pos: { x: 0, y: 0 } }],
      });
    }
    this.selected = this.work.id;
    this.isNew = true;
    this.render();
  }

  private renderMain(): void {
    this.main.replaceChildren();
    this.errors.textContent = "";
    const w = this.work;
    if (!w) {
      this.main.append(h("div", { className: "dev-empty qe-empty" },
        this.tab === "quests"
          ? "Pick a quest on the left, or + New. Quests are steps of objectives; NPC dialogue effects (“Complete objective”, “Start quest”) drive them."
          : this.tab === "enemies"
            ? "Pick an enemy, or + New. Place them in the world with F1 → Build → Enemy."
            : "Pick an NPC, or + New. Place NPCs in the world with F1 → Build → NPC."));
      return;
    }
    const actions = h("div", { className: "im-actions qe-actions" },
      h("button", { className: "dev-btn primary", onclick: () => void this.save() }, this.isNew ? "Create" : "Save"),
      ...(this.isNew ? [] : [h("button", { className: "dev-btn", onclick: () => this.duplicate() }, "Duplicate"), h("button", { className: "dev-btn danger", onclick: () => void this.remove() }, "Delete")]));
    if (this.tab === "quests") {
      const q = w as QuestDef;
      if (!this.isNew) {
        const eng = this.deps.engine();
        actions.append(
          h("span", { className: "qe-test-label" }, `You: ${eng.status(q.id)}`),
          h("button", { className: "dev-btn", title: "Start this quest on your character (ignores requirements)", onclick: () => this.testStart(q.id) }, "Start for me"),
          h("button", { className: "dev-btn", title: "Complete your current step", onclick: () => this.testSkip(q.id) }, "Skip step"),
          h("button", { className: "dev-btn", title: "Forget this quest on your character", onclick: () => this.testReset(q.id) }, "Reset for me"),
        );
      }
      this.main.append(actions, this.errors, questForm(q, this.isNew, this.deps.lookups, () => this.renderMain()));
    } else if (this.tab === "enemies") {
      this.main.append(actions, this.errors, enemyForm(w as EnemyDef, this.isNew, this.deps.enemyModelIds(), () => this.renderMain()));
    } else {
      const editor = new NpcEditor(w as NpcDef, this.isNew, { lookups: this.deps.lookups, model: this.deps.model, modelIds: this.deps.modelIds, engine: this.deps.engine }, () => this.renderMain());
      this.main.append(actions, this.errors, editor.root);
    }
  }

  private async save(): Promise<void> {
    const w = this.work;
    if (!w) return;
    if (this.tab === "quests") {
      const r = QuestDefSchema.safeParse(w);
      if (!r.success) return void (this.errors.textContent = r.error.issues.map((i) => `${i.path.join(".") || "quest"}: ${i.message}`).join("\n"));
      if (this.isNew && this.deps.quests.has(r.data.id)) return void (this.errors.textContent = `A quest "${r.data.id}" already exists.`);
      const err = await saveContent("quest", r.data);
      if (err) return void (this.errors.textContent = err);
      this.deps.quests.set(r.data.id, r.data);
      this.deps.onQuestsChanged();
      this.deps.report(`Saved quest ${r.data.name} → content/quests/${r.data.id}.json`);
      this.selected = r.data.id;
      this.work = structuredClone(r.data);
    } else if (this.tab === "enemies") {
      const r = EnemyDefSchema.safeParse(w);
      if (!r.success) return void (this.errors.textContent = r.error.issues.map((i) => `${i.path.join(".") || "enemy"}: ${i.message}`).join("\n"));
      if (this.isNew && this.deps.enemies.has(r.data.id)) return void (this.errors.textContent = `An enemy "${r.data.id}" already exists.`);
      const err = await saveContent("enemy", r.data);
      if (err) return void (this.errors.textContent = err);
      this.deps.enemies.set(r.data.id, r.data);
      this.deps.onEnemiesChanged();
      this.deps.report(`Saved enemy ${r.data.name} → content/enemies/${r.data.id}.json`);
      this.selected = r.data.id;
      this.work = structuredClone(r.data);
    } else {
      const r = NpcDefSchema.safeParse(w);
      if (!r.success) return void (this.errors.textContent = r.error.issues.map((i) => `${i.path.join(".") || "npc"}: ${i.message}`).join("\n"));
      if (this.isNew && this.deps.npcs.has(r.data.id)) return void (this.errors.textContent = `An NPC "${r.data.id}" already exists.`);
      const err = await saveContent("npc", r.data);
      if (err) return void (this.errors.textContent = err);
      this.deps.npcs.set(r.data.id, r.data);
      this.deps.onNpcsChanged();
      this.deps.report(`Saved NPC ${r.data.name} → content/npcs/${r.data.id}.json`);
      this.selected = r.data.id;
      this.work = structuredClone(r.data);
    }
    this.isNew = false;
    this.render();
  }

  private duplicate(): void {
    const w = this.work;
    if (!w) return;
    const map: Map<string, unknown> = this.tab === "quests" ? this.deps.quests : this.tab === "enemies" ? this.deps.enemies : this.deps.npcs;
    let n = 2;
    while (map.has(`${w.id}-${n}`)) n++;
    this.work = { ...structuredClone(w), id: `${w.id}-${n}`, name: `${w.name} ${n}` };
    this.selected = this.work.id;
    this.isNew = true;
    this.render();
  }

  private async remove(): Promise<void> {
    const w = this.work;
    if (!w || !confirm(`Delete ${w.name} (${w.id})? This deletes its file.`)) return;
    const err = await deleteContent(this.tab === "quests" ? "quest" : this.tab === "enemies" ? "enemy" : "npc", w.id);
    if (err) return void (this.errors.textContent = err);
    if (this.tab === "quests") {
      this.deps.quests.delete(w.id);
      this.deps.onQuestsChanged();
    } else if (this.tab === "enemies") {
      this.deps.enemies.delete(w.id);
      this.deps.onEnemiesChanged();
    } else {
      this.deps.npcs.delete(w.id);
      this.deps.onNpcsChanged();
    }
    this.deps.report(`Deleted ${w.name}.`);
    this.selected = null;
    this.work = null;
    this.render();
  }

  // --- Testing on your own character -------------------------------------------------------------

  private testStart(id: string): void {
    const save = this.deps.character().save;
    if (!save.quests[id]) save.quests[id] = { stage: 0, progress: {} };
    this.deps.onQuestsChanged();
    this.deps.report(`Started ${id} on your character.`);
    this.render();
  }

  private testSkip(id: string): void {
    const q = this.deps.quests.get(id);
    const eng = this.deps.engine();
    const step = q ? eng.step(q) : null;
    if (!q || !step) return this.deps.report("That quest isn't active on your character.");
    for (const o of step.objectives) {
      if (o.kind === "collect") this.deps.character().addItem(o.item, o.qty);
      eng.completeObjective(id, o.id);
    }
    this.deps.onQuestsChanged();
    this.render();
  }

  private testReset(id: string): void {
    const save = this.deps.character().save;
    delete save.quests[id];
    save.pinned = save.pinned.filter((p) => p !== id);
    this.deps.onQuestsChanged();
    this.deps.report(`Reset ${id} on your character.`);
    this.render();
  }
}
