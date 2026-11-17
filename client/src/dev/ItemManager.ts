import {
  COMBAT_STYLES,
  DISCIPLINE_NAMES,
  DISCIPLINES,
  GEAR_SLOT_KINDS,
  isGearKind,
  ITEM_ICONS,
  ITEM_KINDS,
  ItemDefSchema,
  RARITIES,
  STACK_LIMIT,
  STAT_KEYS,
  STAT_LABELS,
  WEAPON_TYPES,
  type ItemDef,
  type LootSlot,
} from "@levi/shared";
import type { ItemUi } from "../ui/ItemUi.js";
import { itemGraphic } from "../ui/itemIcons.js";
import { ArtEditor } from "./ArtEditor.js";
import { h } from "./dom.js";

/** Editor-only organisation (content/dev/item-groups.json); the game never reads it. */
export interface ItemGroup {
  id: string;
  name: string;
  items: string[];
}

export interface ItemManagerDeps {
  /** Live item registry (the same map the game reads). */
  items: Map<string, ItemDef>;
  itemUi: ItemUi;
  /** Content changed: re-derive stats, redraw menus. */
  onChanged(): void;
  give(id: string, qty: number): void;
  report(msg: string): void;
  /** Where an item is referenced (chests, quests), for delete warnings. */
  usages(id: string): string[];
}

interface LootMode {
  title: string;
  slots: number;
  loot: Array<LootSlot | null>;
  onSave(loot: Array<LootSlot | null>): void;
  onRemove?(): void;
}

const KIND_ORDER = Object.fromEntries(ITEM_KINDS.map((k, i) => [k, i])) as Record<string, number>;

/** Serialise a def back to its tidy JSON form (drops defaults that are empty). */
function cleanDef(d: ItemDef): Record<string, unknown> {
  const out: Record<string, unknown> = { ...d };
  if (Object.keys(d.stats).length === 0) delete out["stats"];
  if (Object.keys(d.requires).length === 0) delete out["requires"];
  return out;
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

/**
 * F1 item manager (JEI-style): every item as an icon grid with search and
 * filters, plus a full editor that writes content/items/<id>.json. The same
 * window doubles as the chest loot picker.
 */
export class ItemManager {
  readonly root: HTMLElement;
  private readonly search: HTMLInputElement;
  private readonly kindFilter: HTMLSelectElement;
  private readonly list: HTMLElement;
  private readonly side: HTMLElement;
  private readonly heading: HTMLElement;
  private selected: string | null = null;
  /** Unsaved new item (not yet in the registry). */
  private draft: ItemDef | null = null;
  private loot: LootMode | null = null;
  private lootSel = -1;
  /** Working copy of the item being edited (survives page switches). */
  private work: (ItemDef & Record<string, unknown>) | null = null;
  private page: "details" | "art" = "details";
  private groups: ItemGroup[] = [];
  /** "all", "none" (ungrouped) or a group id. */
  private groupFilter = "all";
  private readonly groupList: HTMLElement;
  /** Multi-selection for bulk grouping (Ctrl/Shift-click). */
  private readonly multi = new Set<string>();
  private anchor: string | null = null;
  /** Modifier keys of the click being handled (captured on the tile). */
  private clickMods = { toggle: false, range: false };
  private readonly selBar: HTMLElement;
  private groupsLoaded = false;

  constructor(host: HTMLElement, private readonly deps: ItemManagerDeps) {
    this.search = h("input", { type: "search", placeholder: "Search items…" });
    this.search.addEventListener("input", () => this.renderList());
    this.kindFilter = h("select", {});
    this.kindFilter.append(h("option", { value: "" }, "All kinds"), ...ITEM_KINDS.map((k) => h("option", { value: k }, k)));
    this.kindFilter.addEventListener("change", () => this.renderList());
    for (const el of [this.search, this.kindFilter]) el.addEventListener("keydown", (e) => e.stopPropagation());
    this.heading = h("h2", {}, "Items");
    this.list = h("div", { className: "im-list" });
    this.groupList = h("div", { className: "im-groups" });
    this.selBar = h("div", { className: "im-selbar", hidden: true });
    this.side = h("div", { className: "im-side" });
    const close = h("button", { className: "dev-btn", onclick: () => this.close() }, "Close");
    const create = h("button", { className: "dev-btn primary", onclick: () => this.newItem() }, "+ New item");
    this.root = h(
      "div",
      { className: "item-manager", hidden: true },
      h("header", {}, this.heading, this.search, this.kindFilter, create, close),
      h("div", { className: "im-body" }, this.groupList, h("div", { className: "im-main" }, this.selBar, this.list), this.side),
    );
    this.root.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.root.addEventListener("keydown", (e) => e.stopPropagation());
    host.appendChild(this.root);
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  /** Browse / edit every item. */
  openManager(): void {
    void this.loadGroups();
    this.loot = null;
    this.heading.textContent = "Item manager";
    this.root.hidden = false;
    this.renderList();
    this.renderSide();
  }

  /** Pick loot for a chest: clicking items fills its slots. */
  openLoot(mode: LootMode): void {
    void this.loadGroups();
    this.loot = { ...mode, loot: Array.from({ length: mode.slots }, (_, i) => mode.loot[i] ?? null) };
    this.lootSel = -1;
    this.heading.textContent = mode.title;
    this.root.hidden = false;
    this.renderList();
    this.renderSide();
  }

  close(): void {
    this.root.hidden = true;
    this.loot = null;
    this.draft = null;
  }

  // --- Item grid -------------------------------------------------------------------------

  private sorted(): ItemDef[] {
    const q = this.search.value.trim().toLowerCase();
    const kind = this.kindFilter.value;
    return [...this.deps.items.values()]
      .filter((d) => (!kind || d.kind === kind) && (!q || d.name.toLowerCase().includes(q) || d.id.includes(q)))
      .filter((d) => this.inFilter(d.id))
      .sort((a, b) => (KIND_ORDER[a.kind]! - KIND_ORDER[b.kind]!) || a.name.localeCompare(b.name));
  }

  private renderList(): void {
    this.renderGroups();
    this.list.replaceChildren();
    const items = this.sorted();
    for (const d of items) {
      const tile = h("div", {
        className: `im-tile${d.id === this.selected ? " selected" : ""}${this.multi.has(d.id) ? " multi" : ""}`,
        draggable: !this.loot,
      });
      // Capture phase runs before the slot's own click: remember the modifiers.
      tile.addEventListener("click", (e) => (this.clickMods = { toggle: e.ctrlKey || e.metaKey, range: e.shiftKey }), true);
      tile.addEventListener("dragstart", (e) => {
        // Dragging a selected tile carries the whole selection.
        const ids = this.multi.has(d.id) ? [...this.multi] : [d.id];
        e.dataTransfer?.setData("text/levi-item", JSON.stringify(ids));
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      });
      const slot = h("div", { className: "im-icon" });
      this.deps.itemUi.renderLoose(slot, { item: d.id, qty: 1 }, () => this.pick(d.id));
      tile.append(slot, h("span", { className: "im-label" }, d.name));
      this.list.append(tile);
    }
    if (items.length === 0) this.list.append(h("div", { className: "dev-empty" }, "No items match."));
    this.renderSelBar();
  }

  /** Bulk bar: shown while several items are selected. */
  private renderSelBar(): void {
    const n = this.multi.size;
    this.selBar.hidden = !!this.loot;
    if (this.loot) return;
    const move = h("select", {});
    move.append(h("option", { value: "" }, "Move to…"), h("option", { value: "__none" }, "Ungrouped"), ...this.groups.map((g) => h("option", { value: g.id }, g.name)));
    move.disabled = n === 0;
    move.addEventListener("change", () => {
      if (!move.value) return;
      this.setGroups([...this.multi], move.value === "__none" ? null : move.value);
    });
    this.selBar.replaceChildren(
      h("span", { className: "im-selcount" }, n ? `${n} selected` : "Ctrl-click / Shift-click to select several"),
      move,
      h("button", { className: "dev-btn", onclick: () => { for (const d of this.sorted()) this.multi.add(d.id); this.renderList(); } }, "Select all shown"),
      h("button", { className: "dev-btn", disabled: n === 0, onclick: () => { this.multi.clear(); this.renderList(); } }, "Clear"),
    );
  }

  /** Ctrl toggles one, Shift selects a range; a plain click selects just that item. */
  private selectClick(id: string): boolean {
    const { toggle, range } = this.clickMods;
    this.clickMods = { toggle: false, range: false };
    if (range && this.anchor) {
      const ids = this.sorted().map((d) => d.id);
      const a = ids.indexOf(this.anchor);
      const b = ids.indexOf(id);
      if (a >= 0 && b >= 0) for (let i = Math.min(a, b); i <= Math.max(a, b); i++) this.multi.add(ids[i]!);
      this.renderList();
      return true;
    }
    if (toggle) {
      if (this.multi.has(id)) this.multi.delete(id);
      else this.multi.add(id);
      // Include the item open in the editor when starting a multi-selection.
      if (this.selected && this.multi.size === 1 && this.selected !== id) this.multi.add(this.selected);
      this.anchor = id;
      this.renderList();
      return true;
    }
    this.multi.clear();
    this.anchor = id;
    return false;
  }

  private pick(id: string): void {
    if (!this.loot && this.selectClick(id)) return;
    if (this.loot) {
      const def = this.deps.items.get(id)!;
      const slots = this.loot.loot;
      // Top up an existing stack of the same stackable item first.
      const same = !isGearKind(def.kind) ? slots.findIndex((s) => s?.item === id && s.qty < STACK_LIMIT) : -1;
      if (same >= 0) slots[same]!.qty += 1;
      else {
        const free = slots.findIndex((s) => !s);
        if (free < 0) {
          this.deps.report("The chest is full: remove something first.");
          return;
        }
        slots[free] = { item: id, qty: 1 };
        this.lootSel = free;
      }
      this.renderSide();
      return;
    }
    this.draft = null;
    this.work = null;
    this.selected = id;
    this.renderList();
    this.renderSide();
  }

  // --- Side pane: loot editor or item editor -------------------------------------------------

  private renderSide(): void {
    this.side.replaceChildren();
    if (this.loot) this.renderLoot(this.loot);
    else this.renderEditor();
  }

  private renderLoot(mode: LootMode): void {
    const grid = h("div", { className: "im-loot" });
    mode.loot.forEach((s, i) => {
      const cell = h("div", { className: `im-loot-slot${i === this.lootSel ? " selected" : ""}` });
      this.deps.itemUi.renderLoose(cell, s ? { item: s.item, qty: s.qty } : null, () => {
        this.lootSel = i;
        this.renderSide();
      });
      grid.append(cell);
    });
    this.side.append(h("div", { className: "dev-empty" }, "Click items on the left to add them. Click a slot to change its amount."), grid);

    const sel = mode.loot[this.lootSel];
    if (sel) {
      const def = this.deps.items.get(sel.item);
      const max = def && isGearKind(def.kind) ? 1 : STACK_LIMIT;
      const qty = h("input", { type: "number", min: "1", max: String(max), value: String(sel.qty) });
      qty.addEventListener("change", () => {
        sel.qty = Math.max(1, Math.min(max, Math.round(Number(qty.value) || 1)));
        this.renderSide();
      });
      this.side.append(
        h("div", { className: "im-row" }, h("b", {}, def?.name ?? sel.item), qty,
          h("button", { className: "dev-btn", onclick: () => { mode.loot[this.lootSel] = null; this.renderSide(); } }, "Remove")),
      );
    }
    this.side.append(
      h(
        "div",
        { className: "im-actions" },
        h("button", { className: "dev-btn primary", onclick: () => { mode.onSave(mode.loot.map((s) => (s ? { ...s } : null))); this.close(); } }, "Save loot"),
        h("button", { className: "dev-btn", onclick: () => { mode.loot.fill(null); this.renderSide(); } }, "Clear"),
        h("button", { className: "dev-btn", onclick: () => this.close() }, "Cancel"),
        ...(mode.onRemove ? [h("button", { className: "dev-btn danger", onclick: () => { if (confirm("Remove this chest?")) { mode.onRemove!(); this.close(); } } }, "Remove chest")] : []),
      ),
    );
  }

  private newItem(): void {
    if (this.loot) return;
    let n = 1;
    while (this.deps.items.has(`new-item-${n}`)) n++;
    this.draft = ItemDefSchema.parse({ id: `new-item-${n}`, name: "New Item", kind: "material", icon: "gem" });
    this.work = null;
    this.page = "details";
    this.selected = null;
    this.renderList();
    this.renderSide();
  }

  private renderEditor(): void {
    const isNew = this.draft !== null;
    const base = this.draft ?? (this.selected ? this.deps.items.get(this.selected) : undefined);
    if (!base) {
      this.side.append(h("div", { className: "dev-empty" }, `${this.deps.items.size} items. Select one to edit, or create a new one.`));
      return;
    }
    // Work on a plain copy (kept across Details/Art); Save validates it.
    this.work ??= structuredClone(base) as ItemDef & Record<string, unknown>;
    const d = this.work;
    const errors = h("pre", { className: "im-errors" });

    const text = (label: string, key: "id" | "name", disabled = false): HTMLElement => {
      const i = h("input", { type: "text", value: String(d[key]), disabled });
      i.addEventListener("input", () => (d[key] = i.value.trim()));
      return h("label", { className: "im-field" }, label, i);
    };
    const select = <T extends string>(label: string, value: string, options: readonly T[], set: (v: T | "") => void, allowNone = false): HTMLElement => {
      const s = h("select", {});
      if (allowNone) s.append(h("option", { value: "" }, "—"));
      for (const o of options) s.append(h("option", { value: o, selected: o === value }, o));
      s.addEventListener("change", () => {
        set(s.value as T | "");
        preview();
      });
      return h("label", { className: "im-field" }, label, s);
    };
    const num = (label: string, value: number | undefined, set: (v: number | undefined) => void, step = "1"): HTMLElement => {
      const i = h("input", { type: "number", step, value: value === undefined ? "" : String(value) });
      i.addEventListener("input", () => set(i.value === "" ? undefined : Number(i.value)));
      return h("label", { className: "im-field small" }, label, i);
    };

    const iconBox = h("div", { className: "im-preview" });
    const preview = (): void => {
      iconBox.replaceChildren(itemGraphic(d));
    };
    preview();

    const desc = h("textarea", { value: d.description, rows: 2, maxLength: 400 });
    desc.addEventListener("input", () => (d.description = desc.value));
    const color = h("input", { type: "color", value: d.color });
    color.addEventListener("input", () => {
      d.color = color.value;
      preview();
    });

    // Stats + requirements: blank = not set.
    const stats = h("div", { className: "im-grid" });
    for (const k of STAT_KEYS) {
      stats.append(num(STAT_LABELS[k], d.stats[k], (v) => {
        if (v === undefined || v === 0) delete d.stats[k];
        else d.stats[k] = v;
      }, "0.1"));
    }
    const reqs = h("div", { className: "im-grid" });
    for (const dis of DISCIPLINES) {
      reqs.append(num(DISCIPLINE_NAMES[dis], d.requires[dis], (v) => {
        if (!v) delete d.requires[dis];
        else d.requires[dis] = Math.round(v);
      }));
    }

    // Use effect.
    const useBox = h("div", { className: "im-grid" });
    const renderUse = (): void => {
      useBox.replaceChildren();
      const u = d.use;
      if (u?.kind === "restore") {
        useBox.append(
          num("Health", u.hp, (v) => (u.hp = v ?? 0)),
          num("Mana", u.mana, (v) => (u.mana = v ?? 0)),
          num("Energy", u.energy, (v) => (u.energy = v ?? 0)),
        );
      } else if (u?.kind === "xp") {
        useBox.append(
          select("XP group", u.group, ["combat", "peaceful"] as const, (v) => (u.group = v || "combat")),
          num("XP amount", u.amount, (v) => (u.amount = Math.max(1, Math.round(v ?? 1)))),
        );
      }
    };
    const useSel = select("On use", d.use?.kind ?? "", ["restore", "xp"] as const, (v) => {
      if (v === "restore") d.use = { kind: "restore", hp: 20, mana: 0, energy: 0 };
      else if (v === "xp") d.use = { kind: "xp", group: "combat", amount: 400 };
      else delete d.use;
      renderUse();
    }, true);
    renderUse();

    const save = async (): Promise<void> => {
      const r = ItemDefSchema.safeParse(d);
      if (!r.success) {
        errors.textContent = r.error.issues.map((i) => `${i.path.join(".") || "item"}: ${i.message}`).join("\n");
        return;
      }
      if (isNew && this.deps.items.has(r.data.id)) {
        errors.textContent = `An item with id "${r.data.id}" already exists.`;
        return;
      }
      const err = await post("/__dev/save-item", { item: cleanDef(r.data) });
      if (err) {
        errors.textContent = err;
        return;
      }
      this.deps.items.set(r.data.id, r.data);
      this.draft = null;
      this.work = null;
      this.selected = r.data.id;
      this.deps.onChanged();
      this.deps.report(`Saved ${r.data.name} → content/items/${r.data.id}.json`);
      this.renderList();
      this.renderSide();
    };
    const remove = async (): Promise<void> => {
      const used = this.deps.usages(d.id);
      const warn = used.length ? `\n\nStill used by: ${used.slice(0, 6).join(", ")}${used.length > 6 ? "…" : ""}` : "";
      if (!confirm(`Delete ${d.name} (${d.id})?${warn}`)) return;
      const err = await post("/__dev/delete-item", { id: d.id });
      if (err) {
        errors.textContent = err;
        return;
      }
      this.deps.items.delete(d.id);
      this.setGroup(d.id, null);
      this.work = null;
      this.selected = null;
      this.deps.onChanged();
      this.deps.report(`Deleted ${d.name}.`);
      this.renderList();
      this.renderSide();
    };
    const duplicate = (): void => {
      let n = 2;
      while (this.deps.items.has(`${d.id}-${n}`)) n++;
      this.draft = { ...structuredClone(d), id: `${d.id}-${n}`, name: `${d.name} ${n}` };
      this.work = null;
      this.selected = null;
      this.renderSide();
    };

    const pages = h(
      "div",
      { className: "im-pages" },
      ...(["details", "art"] as const).map((pg) =>
        h("button", { className: `dev-btn${this.page === pg ? " active" : ""}`, onclick: () => { this.page = pg; this.renderSide(); } }, pg === "details" ? "Details" : d.art ? "Art ●" : "Art"),
      ),
    );
    const groupSel = h("select", {});
    groupSel.append(h("option", { value: "" }, "— none —"), ...this.groups.map((g) => h("option", { value: g.id, selected: g.items.includes(d.id) }, g.name)));
    groupSel.addEventListener("change", () => this.setGroup(d.id, groupSel.value || null));

    if (this.page === "art") {
      const art = new ArtEditor(d.art, {
        glyph: () => ({ icon: d.icon, color: d.color }),
        hueClass: () => `rarity-${d.rarity}`,
        onChange: (a) => {
          if (a) d.art = a;
          else delete d.art;
        },
      });
      this.side.append(pages, art.root, errors, this.actionRow(isNew, d, save, remove, duplicate));
      return;
    }

    this.side.append(
      pages,
      h("div", { className: "im-head" }, iconBox, h("div", {}, text("Name", "name"), text("Id (file name)", "id", !isNew))),
      h("label", { className: "im-field" }, "Group (editor only)", groupSel),
      h("label", { className: "im-field" }, "Description", desc),
      h(
        "div",
        { className: "im-grid" },
        select("Kind", d.kind, ITEM_KINDS, (v) => (d.kind = v || "material")),
        select("Slot", d.slot ?? "", GEAR_SLOT_KINDS, (v) => (v ? (d.slot = v) : delete d.slot), true),
        select("Weapon type", d.weaponType ?? "", WEAPON_TYPES, (v) => (v ? (d.weaponType = v) : delete d.weaponType), true),
        select("Class hue", d.style ?? "", COMBAT_STYLES, (v) => (v ? (d.style = v) : delete d.style), true),
        select("Icon", d.icon, ITEM_ICONS, (v) => (d.icon = v || "gem")),
        h("label", { className: "im-field small" }, "Tint", color),
        select("Rarity", d.rarity, RARITIES, (v) => (d.rarity = v || "common")),
        num("Tier", d.tier, (v) => (d.tier = Math.max(1, Math.min(10, Math.round(v ?? 1))))),
        num("Value", d.value, (v) => (d.value = Math.max(0, Math.round(v ?? 0)))),
      ),
      h("h3", {}, "Use"),
      useSel,
      useBox,
      h("h3", {}, "Stats"),
      stats,
      h("h3", {}, "Requires level"),
      reqs,
      errors,
      this.actionRow(isNew, d, save, remove, duplicate),
    );
  }

  private actionRow(isNew: boolean, d: ItemDef, save: () => Promise<void>, remove: () => Promise<void>, duplicate: () => void): HTMLElement {
    return h(
      "div",
      { className: "im-actions" },
      h("button", { className: "dev-btn primary", onclick: () => void save() }, isNew ? "Create item" : "Save"),
      ...(isNew
        ? [h("button", { className: "dev-btn", onclick: () => { this.draft = null; this.work = null; this.renderSide(); } }, "Discard")]
        : [
            h("button", { className: "dev-btn", onclick: duplicate }, "Duplicate"),
            h("button", { className: "dev-btn", onclick: () => this.deps.give(d.id, 1) }, "Give 1"),
            ...(isGearKind(d.kind) ? [] : [h("button", { className: "dev-btn", onclick: () => this.deps.give(d.id, STACK_LIMIT) }, `Give ${STACK_LIMIT}`)]),
            h("button", { className: "dev-btn danger", onclick: () => void remove() }, "Delete"),
          ]),
    );
  }

  // --- Groups (editor-only organisation) -------------------------------------------------

  private async loadGroups(): Promise<void> {
    if (this.groupsLoaded) return;
    this.groupsLoaded = true;
    try {
      const res = await fetch("/content/dev/item-groups.json", { cache: "no-store" });
      if (res.ok) {
        const j = (await res.json()) as { groups?: ItemGroup[] };
        this.groups = (j.groups ?? []).filter((g) => typeof g.id === "string" && Array.isArray(g.items));
      }
    } catch {
      // No groups file yet.
    }
    this.renderList();
  }

  private async saveGroups(): Promise<void> {
    const err = await post("/__dev/save-item-groups", { groups: this.groups });
    if (err) this.deps.report(`Couldn't save groups: ${err}`);
  }

  private groupOf(id: string): ItemGroup | undefined {
    return this.groups.find((g) => g.items.includes(id));
  }

  private inFilter(id: string): boolean {
    if (this.groupFilter === "all") return true;
    if (this.groupFilter === "none") return !this.groupOf(id);
    return this.groups.find((g) => g.id === this.groupFilter)?.items.includes(id) ?? false;
  }

  /** Move an item into a group (null = ungrouped). An item is in at most one group. */
  private setGroup(itemId: string, groupId: string | null): void {
    this.setGroups([itemId], groupId);
  }

  /** Move many items into a group at once (null = ungrouped). */
  private setGroups(itemIds: readonly string[], groupId: string | null): void {
    const moving = new Set(itemIds.filter((i) => this.deps.items.has(i)));
    if (moving.size === 0) return;
    for (const g of this.groups) g.items = g.items.filter((i) => !moving.has(i));
    const target = groupId ? this.groups.find((g) => g.id === groupId) : undefined;
    if (target) target.items.push(...moving);
    void this.saveGroups();
    this.deps.report(`Moved ${moving.size} item(s) to ${target ? target.name : "Ungrouped"}.`);
    this.multi.clear();
    this.renderList();
  }

  private renderGroups(): void {
    const count = (f: string): number => [...this.deps.items.keys()].filter((id) => (f === "all" ? true : f === "none" ? !this.groupOf(id) : this.groups.find((g) => g.id === f)?.items.includes(id))).length;
    const row = (id: string, label: string, editable: boolean): HTMLElement => {
      const r = h("div", { className: `im-group${this.groupFilter === id ? " active" : ""}` }, h("span", { className: "im-group-name" }, label), h("span", { className: "im-group-count" }, String(count(id))));
      r.addEventListener("click", () => {
        this.groupFilter = id;
        this.renderList();
      });
      // Drop item tiles here to move them (onto All = no change, Ungrouped = remove from group).
      r.addEventListener("dragover", (e) => {
        if (id !== "all") {
          e.preventDefault();
          r.classList.add("drop");
        }
      });
      r.addEventListener("dragleave", () => r.classList.remove("drop"));
      r.addEventListener("drop", (e) => {
        e.preventDefault();
        r.classList.remove("drop");
        const raw = e.dataTransfer?.getData("text/levi-item");
        if (!raw || id === "all") return;
        let ids: string[];
        try {
          ids = (JSON.parse(raw) as unknown[]).filter((x): x is string => typeof x === "string");
        } catch {
          ids = [raw];
        }
        this.setGroups(ids, id === "none" ? null : id);
      });
      if (editable) {
        r.addEventListener("dblclick", () => {
          const g = this.groups.find((x) => x.id === id);
          const name = g && prompt("Rename group", g.name)?.trim();
          if (g && name) {
            g.name = name.slice(0, 40);
            void this.saveGroups();
            this.renderList();
          }
        });
        const del = h("button", { className: "im-group-del", title: "Delete group (items become ungrouped)" }, "×");
        del.addEventListener("click", (e) => {
          e.stopPropagation();
          const g = this.groups.find((x) => x.id === id);
          if (!g || !confirm(`Delete group "${g.name}"? Its ${g.items.length} item(s) become ungrouped.`)) return;
          this.groups = this.groups.filter((x) => x.id !== id);
          if (this.groupFilter === id) this.groupFilter = "all";
          void this.saveGroups();
          this.renderList();
        });
        r.append(del);
      }
      return r;
    };
    const add = h("button", { className: "dev-btn", onclick: () => {
      const name = prompt("New group name")?.trim();
      if (!name) return;
      let n = this.groups.length + 1;
      while (this.groups.some((g) => g.id === `group-${n}`)) n++;
      this.groups.push({ id: `group-${n}`, name: name.slice(0, 40), items: [] });
      void this.saveGroups();
      this.renderList();
    } }, "+ Group");
    this.groupList.replaceChildren(
      row("all", "All items", false),
      row("none", "Ungrouped", false),
      ...this.groups.map((g) => row(g.id, g.name, true)),
      add,
      h("div", { className: "im-group-hint" }, "Drag items onto a group. Double-click to rename."),
    );
  }
}
