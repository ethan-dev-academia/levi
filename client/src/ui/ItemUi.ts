import {
  acceptsGroup,
  DISCIPLINE_NAMES,
  DISCIPLINES,
  EQUIP_SLOTS,
  isGearKind,
  itemStyle,
  RARITIES,
  STACK_LIMIT,
  STAT_KEYS,
  STAT_LABELS,
  type Character,
  type Discipline,
  type EquipSlot,
  type Intent,
  type ItemDef,
  type ItemStack,
  type SlotRef,
} from "@levi/shared";
import { itemGraphic } from "./itemIcons.js";

const STYLE_NAME = { ranger: "Ranger", brawler: "Brawler", mage: "Mage" } as const;
const DRAG_THRESHOLD = 5;
const RARITY_CLASSES = RARITIES.map((r) => `rarity-${r}`);

export interface ItemUiDeps {
  character(): Character;
  send(intent: Intent): void;
  message(text: string): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function refOf(node: HTMLElement): SlotRef | null {
  const area = node.dataset["area"];
  if (area === "eq") {
    const slot = node.dataset["slot"] as EquipSlot | undefined;
    return slot && (EQUIP_SLOTS as readonly string[]).includes(slot) ? { area: "eq", slot } : null;
  }
  if (area === "inv" || area === "hot") return { area, index: Number(node.dataset["index"]) };
  return null;
}

function setRef(node: HTMLElement, ref: SlotRef): void {
  node.dataset["area"] = ref.area;
  if (ref.area === "eq") node.dataset["slot"] = ref.slot;
  else node.dataset["index"] = String(ref.index);
}

/**
 * Everything item-slot related, shared by bag, hotbar and equipment:
 * drawing (class-hue backing, icon, stack count), hover tooltips, drag &
 * drop, click-to-use/equip, a right-click menu and the tome skill chooser.
 * Only ever sends intents; the sim decides what's allowed.
 */
export class ItemUi {
  private readonly tooltip = el("div", "item-tooltip");
  private readonly menu = el("div", "item-menu");
  private readonly chooser = el("div", "item-chooser");
  private ghost: HTMLElement | null = null;
  private press: { ref: SlotRef; x: number; y: number; node: HTMLElement } | null = null;
  /** Slots showing items that aren't yours (chest loot, item pickers): stack + click action. */
  private readonly loose = new WeakMap<HTMLElement, { stack: ItemStack; onClick: () => void }>();
  private dragging = false;

  constructor(private readonly deps: ItemUiDeps) {
    this.tooltip.hidden = true;
    this.menu.hidden = true;
    this.chooser.hidden = true;
    document.body.append(this.tooltip, this.menu, this.chooser);

    document.addEventListener("pointerdown", (e) => this.onDown(e));
    document.addEventListener("pointermove", (e) => this.onMove(e));
    document.addEventListener("pointerup", (e) => this.onUp(e));
    document.addEventListener("contextmenu", (e) => this.onContext(e));
    document.addEventListener("pointerover", (e) => this.onOver(e));
    document.addEventListener("keydown", (e) => {
      if (e.code === "Escape") this.closeOverlays();
    });
  }

  get isDragging(): boolean {
    return this.dragging;
  }

  /**
   * Draw a slot holding an item that isn't in your bag (chest loot, editor
   * pickers): same look and tooltip; clicking runs `onClick`.
   */
  renderLoose(node: HTMLElement, stack: ItemStack | null, onClick: () => void, placeholder?: string): void {
    node.classList.add("islot", "loose");
    node.classList.remove(...RARITY_CLASSES, "filled");
    node.replaceChildren();
    const def = stack ? this.deps.character().def(stack.item) : undefined;
    if (!stack || !def) {
      this.loose.delete(node);
      if (placeholder) node.append(el("span", "islot-ph", placeholder));
      node.onclick = onClick;
      return;
    }
    this.loose.set(node, { stack, onClick });
    node.onclick = () => {
      this.tooltip.hidden = true;
      onClick();
    };
    node.classList.add("filled", `rarity-${def.rarity}`);
    node.append(itemGraphic(def));
    if (stack.qty > 1) node.append(el("span", "islot-qty", String(stack.qty)));
  }

  /** Draw one slot (call again whenever its contents change). */
  renderSlot(node: HTMLElement, ref: SlotRef, stack: ItemStack | null, placeholder?: string): void {
    setRef(node, ref);
    node.classList.add("islot");
    node.classList.remove(...RARITY_CLASSES, "filled");
    node.replaceChildren();
    const def = stack ? this.deps.character().def(stack.item) : undefined;
    if (!stack || !def) {
      if (placeholder) node.append(el("span", "islot-ph", placeholder));
      return;
    }
    node.classList.add("filled", `rarity-${def.rarity}`);
    node.append(itemGraphic(def));
    if (stack.qty > 1) node.append(el("span", "islot-qty", String(stack.qty)));
  }

  // --- Tooltip ----------------------------------------------------------------------

  private onOver(e: PointerEvent): void {
    const node = (e.target as HTMLElement | null)?.closest<HTMLElement>(".islot");
    if (!node || this.dragging || !this.menu.hidden) {
      this.tooltip.hidden = true;
      return;
    }
    const ref = refOf(node);
    const c = this.deps.character();
    const stack = this.loose.get(node)?.stack ?? (ref ? c.get(ref) : null);
    const def = stack ? c.def(stack.item) : undefined;
    if (!stack || !def) {
      this.tooltip.hidden = true;
      return;
    }
    this.fillTooltip(def, stack);
    const r = node.getBoundingClientRect();
    this.tooltip.hidden = false;
    const tw = this.tooltip.offsetWidth;
    const th = this.tooltip.offsetHeight;
    const left = Math.max(8, Math.min(window.innerWidth - tw - 8, r.left + r.width / 2 - tw / 2));
    const top = r.top - th - 8 > 8 ? r.top - th - 8 : r.bottom + 8;
    this.tooltip.style.left = `${left}px`;
    this.tooltip.style.top = `${top}px`;
    node.addEventListener("pointerleave", () => (this.tooltip.hidden = true), { once: true });
  }

  private fillTooltip(def: ItemDef, stack: ItemStack): void {
    const c = this.deps.character();
    const hue = itemStyle(def);
    const t = this.tooltip;
    t.replaceChildren();
    t.className = `item-tooltip rarity-${def.rarity}`;
    t.append(el("div", "tt-name", def.name));
    const kind = def.weaponType
      ? `${def.weaponType[0]!.toUpperCase()}${def.weaponType.slice(1)}`
      : def.kind === "armour" && def.slot
        ? def.slot === "offhand" ? "Off-hand" : `Armour · ${def.slot}`
        : `${def.kind[0]!.toUpperCase()}${def.kind.slice(1)}`;
    const rarity = `${def.rarity[0]!.toUpperCase()}${def.rarity.slice(1)}`;
    t.append(el("div", "tt-kind", hue ? `${rarity} · ${kind} · ${STYLE_NAME[hue]}` : `${rarity} · ${kind}`));
    for (const k of STAT_KEYS) {
      const v = def.stats[k];
      if (!v) continue;
      t.append(el("div", "tt-stat", `${v > 0 ? "+" : ""}${Number.isInteger(v) ? v : v.toFixed(2)} ${STAT_LABELS[k]}`));
    }
    if (def.use?.kind === "restore") {
      const parts = [def.use.hp && `${def.use.hp} health`, def.use.mana && `${def.use.mana} mana`, def.use.energy && `${def.use.energy} energy`].filter(Boolean);
      t.append(el("div", "tt-use", `Restores ${parts.join(", ")}`));
    } else if (def.use?.kind === "xp") {
      t.append(el("div", "tt-use", `${def.use.amount} XP into a ${def.use.group === "combat" ? "combat" : "peacetime"} skill (or Dungeoneering)`));
    }
    for (const [d, lvl] of Object.entries(def.requires) as Array<[Discipline, number]>) {
      const met = c.level(d) >= lvl;
      t.append(el("div", `tt-req${met ? "" : " unmet"}`, `Requires ${DISCIPLINE_NAMES[d]} ${lvl}`));
    }
    if (def.description) t.append(el("div", "tt-desc", def.description));
    if (!isGearKind(def.kind)) t.append(el("div", "tt-foot", `Stack ${stack.qty} / ${STACK_LIMIT}`));
    else if (stack.mods?.reforge || stack.mods?.enchantments.length) t.append(el("div", "tt-foot", "Enchanted"));
  }

  // --- Drag, click ----------------------------------------------------------------------

  private onDown(e: PointerEvent): void {
    if (!this.menu.hidden && !this.menu.contains(e.target as Node)) this.menu.hidden = true;
    if (e.button !== 0) return;
    const node = (e.target as HTMLElement | null)?.closest<HTMLElement>(".islot");
    const ref = node ? refOf(node) : null;
    if (!node || !ref || !this.deps.character().get(ref)) return;
    e.preventDefault();
    this.press = { ref, x: e.clientX, y: e.clientY, node };
  }

  private onMove(e: PointerEvent): void {
    if (!this.press) return;
    if (!this.dragging && Math.hypot(e.clientX - this.press.x, e.clientY - this.press.y) > DRAG_THRESHOLD) {
      this.dragging = true;
      this.tooltip.hidden = true;
      this.ghost = this.press.node.cloneNode(true) as HTMLElement;
      this.ghost.classList.add("islot-ghost");
      document.body.append(this.ghost);
      this.press.node.classList.add("dragging");
    }
    if (this.ghost) {
      this.ghost.style.left = `${e.clientX - 22}px`;
      this.ghost.style.top = `${e.clientY - 22}px`;
    }
  }

  private onUp(e: PointerEvent): void {
    const press = this.press;
    this.press = null;
    if (!press) return;
    if (this.dragging) {
      this.dragging = false;
      this.ghost?.remove();
      this.ghost = null;
      press.node.classList.remove("dragging");
      const target = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>(".islot");
      const to = target ? refOf(target) : null;
      if (to) this.deps.send({ type: "moveItem", from: press.ref, to });
      return;
    }
    this.primary(press.ref);
  }

  /** Left click: equip gear, use consumables, take off worn items. */
  primary(ref: SlotRef): void {
    this.tooltip.hidden = true;
    const c = this.deps.character();
    const stack = c.get(ref);
    const def = stack ? c.def(stack.item) : undefined;
    if (!stack || !def) return;
    if (ref.area === "eq") this.deps.send({ type: "unequip", slot: ref.slot });
    else if (isGearKind(def.kind)) this.deps.send({ type: "equip", from: ref });
    else if (def.use?.kind === "xp") this.chooseDiscipline(ref, def);
    else if (def.use) this.deps.send({ type: "useSlot", from: ref });
    else this.deps.message(def.description || `It's ${def.name.toLowerCase()}.`);
  }

  // --- Right-click menu ------------------------------------------------------------------

  private onContext(e: MouseEvent): void {
    const node = (e.target as HTMLElement | null)?.closest<HTMLElement>(".islot");
    const ref = node ? refOf(node) : null;
    const c = this.deps.character();
    const stack = ref ? c.get(ref) : null;
    const def = stack ? c.def(stack.item) : undefined;
    if (!ref || !stack || !def) return;
    e.preventDefault();
    this.tooltip.hidden = true;
    const options: Array<[string, () => void]> = [];
    if (ref.area === "eq") options.push(["Unequip", () => this.deps.send({ type: "unequip", slot: ref.slot })]);
    else if (isGearKind(def.kind)) options.push(["Equip", () => this.deps.send({ type: "equip", from: ref })]);
    else if (def.use) options.push([def.use.kind === "xp" ? "Read" : def.kind === "consumable" && def.icon === "potion" ? "Drink" : "Eat", () => this.primary(ref)]);
    options.push(["Examine", () => this.deps.message(def.description || def.name)]);
    options.push(["Cancel", () => {}]);
    this.menu.replaceChildren(el("div", "im-title", def.name));
    for (const [label, run] of options) {
      const b = el("button", "im-opt", label);
      b.addEventListener("click", () => {
        this.menu.hidden = true;
        run();
      });
      this.menu.append(b);
    }
    this.menu.hidden = false;
    this.menu.style.left = `${Math.min(window.innerWidth - 160, e.clientX)}px`;
    this.menu.style.top = `${Math.min(window.innerHeight - this.menu.offsetHeight - 8, e.clientY)}px`;
  }

  // --- Tome chooser ------------------------------------------------------------------------

  private chooseDiscipline(ref: SlotRef, def: ItemDef): void {
    if (def.use?.kind !== "xp") return;
    const group = def.use.group;
    const c = this.deps.character();
    this.chooser.replaceChildren(
      el("div", "ic-title", def.name),
      el("div", "ic-sub", `Choose a skill to receive ${def.use.amount} XP`),
    );
    const grid = el("div", "ic-grid");
    for (const d of DISCIPLINES) {
      if (!acceptsGroup(d, group)) continue;
      const b = el("button", "ic-opt");
      b.append(el("span", "", DISCIPLINE_NAMES[d]), el("b", "", String(c.level(d))));
      b.addEventListener("click", () => {
        this.chooser.hidden = true;
        this.deps.send({ type: "useSlot", from: ref, discipline: d });
      });
      grid.append(b);
    }
    const cancel = el("button", "ic-cancel", "Cancel");
    cancel.addEventListener("click", () => (this.chooser.hidden = true));
    this.chooser.append(grid, cancel);
    this.chooser.hidden = false;
  }

  /** Hotbar keys 1–4 use the same rules as clicking (tomes ask for a skill). */
  useHotbar(index: number): void {
    const c = this.deps.character();
    const stack = c.save.hotbar[index];
    const def = stack ? c.def(stack.item) : undefined;
    if (def?.use?.kind === "xp" || (def && isGearKind(def.kind))) this.primary({ area: "hot", index });
    else this.deps.send({ type: "useItem", slot: (index + 1) as 1 | 2 | 3 | 4 });
  }

  closeOverlays(): void {
    this.menu.hidden = true;
    this.chooser.hidden = true;
    this.tooltip.hidden = true;
  }
}
