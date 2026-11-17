import {
  ABILITY_SLOTS,
  DISCIPLINE_NAMES,
  levelForXp,
  levelProgress,
  MAX_LEVEL,
  SKILL_MILESTONES,
  xpForLevel,
  type AbilitySlot,
  type Character,
  type CombatStyle,
  type Intent,
  type SkillDef,
} from "@levi/shared";
import { skillIcon } from "./skillIcons.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const NODE = 64;
const DRAG_THRESHOLD = 5;

export interface SkillTreeDeps {
  character(): Character;
  send(intent: Intent): void;
  inCombat(): boolean;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/**
 * A combat path's skill tree as its own window: tiers left → right with
 * connecting branches (learned path in gold), a details panel for the
 * clicked skill, and drag & drop of learned skills onto the Q W E R D F bar.
 */
export class SkillTreeWindow {
  private readonly root = el("div", "skill-window");
  private style: CombatStyle | null = null;
  private selected: string | null = null;
  private drag: { skill: SkillDef; style: CombatStyle; x: number; y: number; ghost: HTMLElement | null; from: AbilitySlot | null } | null = null;

  constructor(host: HTMLElement, private readonly deps: SkillTreeDeps) {
    this.root.hidden = true;
    this.root.addEventListener("pointerdown", (e) => e.stopPropagation());
    host.append(this.root);
    window.addEventListener("pointermove", (e) => this.onMove(e));
    window.addEventListener("pointerup", (e) => this.onUp(e));
    window.addEventListener("keydown", (e) => {
      if (e.code === "Escape" && this.isOpen) this.close();
    });
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  open(style: CombatStyle): void {
    if (this.style !== style) this.selected = null;
    this.style = style;
    this.root.hidden = false;
    this.render();
  }

  close(): void {
    this.root.hidden = true;
  }

  /** Redraw after the character changed (learned / bound skills). */
  refresh(): void {
    if (this.isOpen) this.render();
  }

  /**
   * HUD ability slots are drag sources too: drag a bound skill to another
   * key to move/swap it, or off the bar to unbind it.
   */
  bindHudSlot(slot: HTMLElement, key: AbilitySlot): void {
    slot.dataset["ability"] = key;
    slot.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const b = this.deps.character().barSlot(key);
      if (!b) return;
      e.preventDefault();
      this.drag = { skill: b.skill, style: b.style, x: e.clientX, y: e.clientY, ghost: null, from: key };
    });
  }

  // --- Rendering -------------------------------------------------------------------------------

  private render(): void {
    const style = this.style;
    if (!style) return;
    const c = this.deps.character();
    const tree = c.tree(style);
    this.root.replaceChildren();
    if (!tree) return;
    const xp = c.save.xp[style];
    const lvl = levelForXp(xp);

    // Header: path, level + XP, reset, close.
    const bar = el("div", "sw-xp");
    const fill = el("div", "sw-xp-fill");
    fill.style.width = `${Math.round(levelProgress(xp) * 100)}%`;
    bar.append(fill);
    const reset = el("button", "menu-btn danger", "Reset tree");
    reset.addEventListener("click", () => {
      if (confirm(`Reset your ${DISCIPLINE_NAMES[style]} skills? Your basic attack stays.`)) this.deps.send({ type: "resetSkills", style });
    });
    const close = el("button", "menu-btn", "Close");
    close.addEventListener("click", () => this.close());
    const head = el("header", "sw-head");
    const titles = el("div", "sw-titles");
    titles.append(el("h2", "", tree.name), el("div", "sw-sub", `${DISCIPLINE_NAMES[style]} level ${lvl}${lvl < MAX_LEVEL ? ` · ${xp.toLocaleString()} / ${xpForLevel(lvl + 1).toLocaleString()} XP` : " · max"}`), bar);
    head.append(titles, reset, close);
    this.root.append(head);
    if (tree.blurb) this.root.append(el("div", "sw-blurb", tree.blurb));
    if (this.deps.inCombat()) this.root.append(el("div", "menu-lock", "In combat: skills and keys are locked."));

    // Tree: one column per tier, branches between columns.
    const area = el("div", "sw-tree");
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "sw-lines");
    area.append(svg);
    this.root.append(area);
    const pos = new Map<string, { x: number; y: number }>();
    const nodes = new Map<string, HTMLElement>();
    for (const tier of SKILL_MILESTONES) {
      for (const n of tree.skills.filter((s) => s.tier === tier)) {
        const node = this.node(c, style, n, lvl);
        nodes.set(n.id, node);
        area.append(node);
      }
    }
    const layout = (): void => {
      const w = area.clientWidth;
      const h = area.clientHeight;
      const colW = w / SKILL_MILESTONES.length;
      SKILL_MILESTONES.forEach((tier, i) => {
        const list = tree.skills.filter((s) => s.tier === tier);
        list.forEach((n, j) => {
          const x = colW * i + colW / 2;
          const y = list.length === 1 ? h / 2 : h / 2 + (j === 0 ? -1 : 1) * Math.min(80, h / 4);
          pos.set(n.id, { x, y });
          const node = nodes.get(n.id)!;
          node.style.left = `${x - NODE / 2}px`;
          node.style.top = `${y - NODE / 2}px`;
        });
      });
      // Branches: each node to the previous-tier nodes it can come from.
      svg.replaceChildren();
      svg.setAttribute("width", String(w));
      svg.setAttribute("height", String(h));
      SKILL_MILESTONES.forEach((tier, i) => {
        if (i === 0) return;
        const prev = tree.skills.filter((s) => s.tier === SKILL_MILESTONES[i - 1]);
        for (const n of tree.skills.filter((s) => s.tier === tier)) {
          const from = n.requires.length ? prev.filter((p) => n.requires.includes(p.id)) : prev;
          for (const p of from) {
            const a = pos.get(p.id)!;
            const b = pos.get(n.id)!;
            const line = document.createElementNS(SVG_NS, "path");
            const mx = (a.x + b.x) / 2;
            line.setAttribute("d", `M${a.x + NODE / 2 - 4},${a.y} C${mx},${a.y} ${mx},${b.y} ${b.x - NODE / 2 + 4},${b.y}`);
            const learned = c.isUnlocked(style, p.id) && c.isUnlocked(style, n.id);
            const open = c.isUnlocked(style, p.id) && !c.unlockBlocker(style, n);
            line.setAttribute("class", learned ? "learned" : open ? "open" : "");
            svg.append(line);
          }
        }
      });
    };
    requestAnimationFrame(layout);
    // Level markers under each column.
    const marks = el("div", "sw-levels");
    for (const t of SKILL_MILESTONES) marks.append(el("span", lvl >= t ? "reached" : "", `Lv ${t}`));
    this.root.append(marks);


    this.root.append(this.detail(c, style));
    this.root.append(el("div", "sw-hint", "Drag a learned skill onto Q W E R D F to use it. Drag between keys to swap, or off the bar to unbind."));
  }

  private node(c: Character, style: CombatStyle, n: SkillDef, lvl: number): HTMLElement {
    const unlocked = c.isUnlocked(style, n.id);
    const blocker = unlocked ? null : c.unlockBlocker(style, n);
    const state = unlocked ? "learned" : blocker ? (lvl >= n.tier ? "locked choice" : "locked") : "available";
    const key = c.keyOf(style, n.id);
    const node = el("button", `sw-node ${state}${this.selected === n.id ? " selected" : ""}`);
    node.dataset["name"] = n.name;
    node.append(skillIcon(n, style), el("span", "sw-name", n.name));
    if (key) node.append(el("span", "tn-key", key));
    node.addEventListener("click", () => {
      this.selected = n.id;
      this.render();
    });
    node.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || !unlocked) return;
      this.drag = { skill: n, style, x: e.clientX, y: e.clientY, ghost: null, from: null };
    });
    return node;
  }

  private detail(c: Character, style: CombatStyle): HTMLElement {
    const box = el("div", "sw-detail");
    const secret = c.tree(style)?.secrets.find((s) => s.id === this.selected);
    if (secret && !c.isUnlocked(style, secret.id)) {
      box.append(el("div", "sw-empty", "A secret art. Its way is hidden; you'll know when you've earned it."));
      return box;
    }
    const n = secret ?? c.tree(style)?.skills.find((s) => s.id === this.selected);
    if (!n) {
      box.append(el("div", "sw-empty", "Click a skill to see what it does."));
      return box;
    }
    const icon = el("div", "sw-detail-icon");
    icon.append(skillIcon(n, style));
    const body = el("div", "sw-detail-body");
    const res = style === "mage" ? "mana" : "energy";
    body.append(
      el("div", "sd-name", n.name),
      el("div", "sd-meta", `${n.tier === 0 ? "Secret art" : `Level ${n.tier}`} · ${n.cost} ${res} · ${n.cooldown}s cooldown`),
      el("div", "sd-desc", n.description),
    );
    if (n.lore) body.append(el("div", "sd-lore", n.lore));
    if (!c.isUnlocked(style, n.id)) {
      const why = c.unlockBlocker(style, n);
      if (why) body.append(el("div", "sd-block", why));
      else {
        const learn = el("button", "menu-btn primary", `Learn ${n.name}`);
        learn.addEventListener("click", () => this.deps.send({ type: "unlockSkill", style, skill: n.id }));
        body.append(learn);
      }
    } else {
      const keys = el("div", "sd-keys");
      for (const k of ABILITY_SLOTS) {
        const on = c.keyOf(style, n.id) === k;
        const b = el("button", `sd-key${on ? " on" : ""}`, k);
        b.addEventListener("click", () => this.deps.send({ type: "setLoadout", style, key: k, skill: on ? null : n.id }));
        keys.append(b);
      }
      body.append(el("div", "sd-sub", "Bind to a key (or drag the skill onto your bar):"), keys);
    }
    box.append(icon, body);
    return box;
  }

  // --- Drag & drop onto the ability bar ------------------------------------------------------------

  private onMove(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    if (!d.ghost && Math.hypot(e.clientX - d.x, e.clientY - d.y) > DRAG_THRESHOLD) {
      d.ghost = el("div", "sw-ghost");
      d.ghost.append(skillIcon(d.skill, d.style));
      document.body.append(d.ghost);
      document.body.classList.add("dragging-skill");
    }
    if (d.ghost) {
      d.ghost.style.left = `${e.clientX - 24}px`;
      d.ghost.style.top = `${e.clientY - 24}px`;
    }
  }

  private onUp(e: PointerEvent): void {
    const d = this.drag;
    this.drag = null;
    if (!d?.ghost) return;
    d.ghost.remove();
    document.body.classList.remove("dragging-skill");
    const c = this.deps.character();
    const target = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-ability]");
    const to = target?.dataset["ability"] as AbilitySlot | undefined;
    if (to) {
      if (to === d.from) return;
      const displaced = c.save.bar[to];
      this.deps.send({ type: "setLoadout", style: d.style, key: to, skill: d.skill.id });
      // Swapping two bar slots keeps both skills.
      if (d.from && displaced && displaced.skill !== d.skill.id) this.deps.send({ type: "setLoadout", style: displaced.style, key: d.from, skill: displaced.skill });
    } else if (d.from) {
      this.deps.send({ type: "setLoadout", style: d.style, key: d.from, skill: null });
    }
  }
}
