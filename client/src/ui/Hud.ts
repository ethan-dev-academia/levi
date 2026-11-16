import type { AbilitySlot, ItemSlot } from "@levi/shared";

type SlotKey = AbilitySlot | `${ItemSlot}`;

function div(className: string, parent?: HTMLElement): HTMLDivElement {
  const d = document.createElement("div");
  d.className = className;
  parent?.appendChild(d);
  return d;
}

/**
 * Bottom-centre combat HUD:
 *   [portrait] [Q W E R | D F]  [1 2]
 *              [ HP bar       ]  [3 4]
 *              [ resource bar ]
 * Presentational only: values come from authoritative state.
 */
export class Hud {
  readonly portrait: HTMLCanvasElement;
  private readonly slots = new Map<SlotKey, { el: HTMLElement; cd: HTMLElement }>();
  private readonly level: HTMLElement;
  private readonly hp: { fill: HTMLElement; label: HTMLElement };
  private readonly mp: { fill: HTMLElement; label: HTMLElement };

  constructor(root: HTMLElement) {
    const portraitWrap = div("hud-portrait", root);
    this.portrait = document.createElement("canvas");
    this.portrait.width = 168;
    this.portrait.height = 168;
    portraitWrap.appendChild(this.portrait);
    this.level = div("hud-level", portraitWrap);

    const core = div("hud-core", root);
    const row = div("hud-row", core);
    for (const k of ["Q", "W", "E", "R"] as const) this.addSlot(row, k, "slot");
    div("hud-divider", row);
    for (const k of ["D", "F"] as const) this.addSlot(row, k, "slot small");

    this.hp = this.addBar(core, "hp");
    this.mp = this.addBar(core, "mp");

    const items = div("hud-items", root);
    for (const k of ["1", "2", "3", "4"] as const) this.addSlot(items, k, "slot item");

    this.setLevel(1);
    this.setHealth(100, 100);
    this.setResource(100, 100);
  }

  private addSlot(parent: HTMLElement, key: SlotKey, className: string): void {
    const el = div(className, parent);
    const cd = div("cd", el);
    const label = document.createElement("span");
    label.className = "key";
    label.textContent = key;
    el.appendChild(label);
    this.slots.set(key, { el, cd });
  }

  private addBar(parent: HTMLElement, kind: "hp" | "mp"): { fill: HTMLElement; label: HTMLElement } {
    const bar = div(`bar ${kind}`, parent);
    const fill = div("fill", bar);
    const label = document.createElement("span");
    bar.appendChild(label);
    return { fill, label };
  }

  flash(key: SlotKey): void {
    const s = this.slots.get(key);
    if (!s) return;
    s.el.classList.add("flash");
    setTimeout(() => s.el.classList.remove("flash"), 110);
  }

  /** fraction: 1 = just used, 0 = ready. */
  setCooldown(key: SlotKey, fraction: number): void {
    this.slots.get(key)?.cd.style.setProperty("--cd", String(Math.max(0, Math.min(1, fraction))));
  }

  setLevel(level: number): void {
    this.level.textContent = String(level);
  }

  setHealth(cur: number, max: number): void {
    this.setBar(this.hp, cur, max);
  }

  setResource(cur: number, max: number): void {
    this.setBar(this.mp, cur, max);
  }

  private setBar(bar: { fill: HTMLElement; label: HTMLElement }, cur: number, max: number): void {
    bar.fill.style.width = `${max > 0 ? (100 * cur) / max : 0}%`;
    bar.label.textContent = `${Math.round(cur)} / ${Math.round(max)}`;
  }
}
