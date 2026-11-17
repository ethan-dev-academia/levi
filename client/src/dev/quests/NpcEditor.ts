import type { DialogueNode, ModelDef, NpcDef, QuestEngine } from "@levi/shared";
import { renderPortrait } from "../../render/portrait.js";
import { h } from "../dom.js";
import { conditionList, describeEffect, effectList, field, guard, numInput, selectInput, textArea, textInput, type EditorLookups } from "./fields.js";

const NODE_W = 210;
const SVG_NS = "http://www.w3.org/2000/svg";

export interface NpcEditorDeps {
  lookups: EditorLookups;
  model(id: string): ModelDef | undefined;
  /** Character models an NPC can use (humanoid, npc-falcon...). */
  modelIds(): string[];
  /** Live quest state, for "Play" (conditions read your real progress). */
  engine(): QuestEngine;
}

/**
 * NPC editor: appearance (palette + live preview) and the dialogue graph.
 * Lines are cards on a pannable canvas with arrows for "next" and for each
 * choice; select a card to edit it in the inspector. Edits `npc` in place.
 */
export class NpcEditor {
  readonly root = h("div", { className: "ne-root" });
  private selected: string | null = null;
  private pan = { x: 40, y: 40 };
  private playing: { node: DialogueNode; log: string[] } | null = null;

  constructor(
    private readonly npc: NpcDef,
    private readonly isNew: boolean,
    private readonly deps: NpcEditorDeps,
    /** Structural change (redraw everything that depends on it). */
    private readonly changed: () => void,
  ) {
    this.layoutMissing();
    this.render();
  }

  /** Give lines without a saved position a simple column layout. */
  private layoutMissing(): void {
    this.npc.nodes.forEach((n, i) => {
      n.pos ??= { x: (i % 4) * (NODE_W + 40), y: Math.floor(i / 4) * 170 };
    });
  }

  private render(): void {
    this.root.replaceChildren(this.appearance(), this.graphArea(), this.inspector());
  }

  // --- Appearance -------------------------------------------------------------------------

  private appearance(): HTMLElement {
    const n = this.npc;
    const l = this.deps.lookups;
    // "Same person as": preview (and use) that NPC's look instead.
    const look = (n.looksLike && l.npcs.get(n.looksLike)) || n;
    const model = this.deps.model(look.model);
    const preview = h("canvas", { width: 160, height: 160, className: "ne-preview" });
    const redraw = (): void => {
      if (model) renderPortrait(model, preview, look.palette, 0.35);
    };
    const sameAs = selectInput(n.looksLike ?? "", [...l.npcs.values()].filter((x) => x.id !== n.id && !x.looksLike).map((x): [string, string] => [x.id, x.location ? `${x.name} · ${x.location}` : x.name]),
      (v) => { if (v) n.looksLike = v; else delete n.looksLike; this.render(); }, "— (own look)");
    const swatches = h("div", { className: "ne-palette" });
    if (n.looksLike) swatches.append(h("div", { className: "dev-empty" }, `Uses ${look.name}'s look. Edit it there, or set "Same person as" to own look.`));
    else for (const [slot, base] of Object.entries(model?.palette ?? {})) {
      const c = h("input", { type: "color", value: n.palette[slot] ?? base, title: slot });
      c.addEventListener("input", () => {
        n.palette[slot] = c.value;
        redraw();
      });
      const reset = h("button", { className: "qe-x", title: "Use the default", onclick: () => { delete n.palette[slot]; c.value = base; redraw(); } }, "↺");
      swatches.append(h("label", { className: "ne-swatch" }, h("span", {}, slot), c, reset));
    }
    queueMicrotask(redraw);
    const idInput = textInput(n.id, (v) => (n.id = v.trim()));
    idInput.disabled = !this.isNew;
    return h(
      "div",
      { className: "ne-appearance" },
      preview,
      h("div", { className: "ne-basics" },
        field("Name", textInput(n.name, (v) => (n.name = v))),
        field("Title", textInput(n.title, (v) => (n.title = v), "e.g. Warden of the Landing")),
        field("Id (file name)", idInput),
        field("Size", numInput(n.scale, (v) => (n.scale = Math.max(0.6, Math.min(1.6, v ?? 1))), "0.05")),
        field("Location (editor note)", textInput(n.location, (v) => (n.location = v), "e.g. Training Grounds")),
        field("Same person as", sameAs),
        field("Model", selectInput(n.model, this.deps.modelIds().map((m): [string, string] => [m, m]), (v) => { n.model = v; this.render(); })),
      ),
      swatches,
    );
  }

  // --- Graph --------------------------------------------------------------------------------

  private graphArea(): HTMLElement {
    const area = h("div", { className: "ne-graph" });
    const layer = h("div", { className: "ne-layer" });
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "ne-edges");
    layer.append(svg);
    layer.style.transform = `translate(${this.pan.x}px, ${this.pan.y}px)`;

    const entryAt = new Map<string, string[]>();
    for (const e of this.npc.entries) entryAt.set(e.start, [...(entryAt.get(e.start) ?? []), e.label || e.id]);
    const cards = new Map<string, HTMLElement>();
    for (const node of this.npc.nodes) {
      const card = this.card(node, entryAt.get(node.id) ?? [], () => this.drawEdges(svg, cards));
      cards.set(node.id, card);
      layer.append(card);
    }
    area.append(layer);

    // Pan by dragging the background.
    area.addEventListener("pointerdown", (e) => {
      if (e.target !== area && e.target !== layer && e.target !== svg) return;
      const sx = e.clientX, sy = e.clientY, px = this.pan.x, py = this.pan.y;
      area.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent): void => {
        this.pan = { x: px + ev.clientX - sx, y: py + ev.clientY - sy };
        layer.style.transform = `translate(${this.pan.x}px, ${this.pan.y}px)`;
      };
      area.addEventListener("pointermove", move);
      area.addEventListener("pointerup", () => area.removeEventListener("pointermove", move), { once: true });
      if (this.selected) {
        this.selected = null;
        this.render();
      }
    });

    const toolbar = h(
      "div",
      { className: "ne-toolbar" },
      h("button", { className: "dev-btn", onclick: () => this.addNode() }, "+ Line"),
      h("button", { className: `dev-btn${this.selected === null ? " active" : ""}`, onclick: () => { this.selected = null; this.render(); } }, "Start points"),
      h("button", { className: "dev-btn primary", onclick: () => this.startPlay() }, "▶ Play"),
      h("span", { className: "ne-hint" }, "Drag cards to arrange · drag the background to pan"),
    );
    queueMicrotask(() => this.drawEdges(svg, cards));
    const wrap = h("div", { className: "ne-graph-wrap" }, toolbar, area);
    if (this.playing) wrap.append(this.playPanel());
    return wrap;
  }

  private card(node: DialogueNode, entries: string[], redrawEdges: () => void): HTMLElement {
    const l = this.deps.lookups;
    const card = h("div", { className: `ne-card ${node.speaker}${node.id === this.selected ? " selected" : ""}` });
    card.style.left = `${node.pos!.x}px`;
    card.style.top = `${node.pos!.y}px`;
    card.style.width = `${NODE_W}px`;
    card.dataset["node"] = node.id;
    const head = h("div", { className: "ne-card-head" }, h("span", {}, node.speaker === "npc" ? this.npc.name : "Player"), h("small", {}, node.id));
    card.append(head);
    for (const e of entries) card.append(h("div", { className: "ne-entry" }, `▶ ${e}`));
    card.append(h("div", { className: "ne-card-text" }, node.text));
    node.options.forEach((o, i) => {
      const row = h("div", { className: "ne-opt" }, `${i + 1}. ${o.text}`);
      row.dataset["opt"] = String(i);
      if (o.when.length) row.title = "Has conditions";
      card.append(row);
    });
    const fx = [...node.effects, ...node.options.flatMap((o) => o.effects)];
    if (fx.length) card.append(h("div", { className: "ne-fx" }, fx.map((e) => describeEffect(e, l)).join(" · ")));
    if (!node.options.length && node.next === null) card.append(h("div", { className: "ne-end" }, "■ end"));

    // Drag to move; click to select.
    card.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      const sx = e.clientX, sy = e.clientY, ox = node.pos!.x, oy = node.pos!.y;
      let moved = false;
      card.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent): void => {
        const dx = ev.clientX - sx, dy = ev.clientY - sy;
        if (!moved && Math.hypot(dx, dy) < 4) return;
        moved = true;
        node.pos = { x: Math.round(ox + dx), y: Math.round(oy + dy) };
        card.style.left = `${node.pos.x}px`;
        card.style.top = `${node.pos.y}px`;
        redrawEdges();
      };
      card.addEventListener("pointermove", move);
      card.addEventListener("pointerup", () => {
        card.removeEventListener("pointermove", move);
        if (!moved) {
          this.selected = node.id;
          this.render();
        }
      }, { once: true });
    });
    return card;
  }

  /** Arrows: card bottom → next card; each choice row → its target. */
  private drawEdges(svg: SVGSVGElement, cards: Map<string, HTMLElement>): void {
    svg.replaceChildren();
    const path = (x1: number, y1: number, x2: number, y2: number, cls: string): void => {
      const p = document.createElementNS(SVG_NS, "path");
      const dy = Math.max(40, Math.abs(y2 - y1) / 2);
      p.setAttribute("d", `M${x1},${y1} C${x1},${y1 + dy} ${x2},${y2 - dy} ${x2},${y2}`);
      p.setAttribute("class", cls);
      svg.append(p);
      const head = document.createElementNS(SVG_NS, "path");
      head.setAttribute("d", `M${x2 - 5},${y2 - 8} L${x2},${y2} L${x2 + 5},${y2 - 8}`);
      head.setAttribute("class", cls);
      svg.append(head);
    };
    for (const node of this.npc.nodes) {
      const from = cards.get(node.id);
      if (!from) continue;
      const fx = from.offsetLeft, fy = from.offsetTop, fw = from.offsetWidth, fh = from.offsetHeight;
      if (node.options.length === 0 && node.next) {
        const to = cards.get(node.next);
        if (to) path(fx + fw / 2, fy + fh, to.offsetLeft + to.offsetWidth / 2, to.offsetTop, "next");
      }
      node.options.forEach((o, i) => {
        if (!o.next) return;
        const to = cards.get(o.next);
        const row = from.querySelector<HTMLElement>(`[data-opt="${i}"]`);
        if (!to || !row) return;
        path(fx + fw - 10, fy + row.offsetTop + row.offsetHeight / 2, to.offsetLeft + to.offsetWidth / 2, to.offsetTop, "option");
      });
    }
    // Size the SVG to cover every card.
    let w = 400, hgt = 300;
    for (const c of cards.values()) {
      w = Math.max(w, c.offsetLeft + c.offsetWidth + 60);
      hgt = Math.max(hgt, c.offsetTop + c.offsetHeight + 60);
    }
    svg.setAttribute("width", String(w));
    svg.setAttribute("height", String(hgt));
  }

  private addNode(): void {
    let n = this.npc.nodes.length + 1;
    while (this.npc.nodes.some((x) => x.id === `line-${n}`)) n++;
    const after = this.npc.nodes.find((x) => x.id === this.selected);
    const node: DialogueNode = {
      id: `line-${n}`, speaker: "npc", text: "New line.", next: null, options: [], effects: [],
      pos: after?.pos ? { x: after.pos.x, y: after.pos.y + 170 } : { x: -this.pan.x + 60, y: -this.pan.y + 60 },
    };
    // Chain from the selected line when it has nowhere to go yet.
    if (after && after.options.length === 0 && after.next === null) after.next = node.id;
    this.npc.nodes.push(node);
    if (this.npc.entries.length === 0) this.npc.entries.push({ id: "default", label: "Default", when: [], start: node.id });
    this.selected = node.id;
    this.render();
  }

  // --- Inspector ------------------------------------------------------------------------------

  private inspector(): HTMLElement {
    const box = h("div", { className: "ne-inspector" });
    const l = this.deps.lookups;
    const nodeOpts = this.npc.nodes.map((n): [string, string] => [n.id, `${n.id}: ${n.text.slice(0, 24)}`]);
    const redraw = (): void => this.render();
    const node = this.npc.nodes.find((n) => n.id === this.selected);

    if (!node) {
      // Start points: which conversation opens, given the player's progress.
      box.append(h("h3", {}, "Start points"), h("div", { className: "dev-empty" }, "Tried top to bottom; the first whose conditions all pass starts the conversation. Put specific ones (quest steps) above general ones."));
      this.npc.entries.forEach((e, i) => {
        const move = (d: number): void => {
          const j = i + d;
          if (j < 0 || j >= this.npc.entries.length) return;
          [this.npc.entries[i], this.npc.entries[j]] = [this.npc.entries[j]!, this.npc.entries[i]!];
          redraw();
        };
        box.append(h(
          "div",
          { className: "qe-step" },
          h("div", { className: "qe-step-head" },
            textInput(e.label, (v) => (e.label = v), "Label"),
            h("button", { className: "qe-x", onclick: () => move(-1) }, "↑"),
            h("button", { className: "qe-x", onclick: () => move(1) }, "↓"),
            h("button", { className: "qe-x", onclick: () => { this.npc.entries.splice(i, 1); redraw(); } }, "×")),
          field("Starts at", selectInput(e.start, nodeOpts, (v) => { e.start = v; redraw(); })),
          conditionList(e.when, l, redraw),
        ));
      });
      box.append(h("button", { className: "dev-btn", onclick: () => {
        let n = this.npc.entries.length + 1;
        while (this.npc.entries.some((x) => x.id === `entry-${n}`)) n++;
        this.npc.entries.push({ id: `entry-${n}`, label: "", when: [], start: this.npc.nodes[0]?.id ?? "" });
        redraw();
      } }, "+ Start point"));
      return box;
    }

    const renameTo = (id: string): void => {
      const old = node.id;
      if (!id || id === old || this.npc.nodes.some((n) => n.id === id)) return;
      node.id = id;
      for (const n of this.npc.nodes) {
        if (n.next === old) n.next = id;
        for (const o of n.options) if (o.next === old) o.next = id;
      }
      for (const e of this.npc.entries) if (e.start === old) e.start = id;
      this.selected = id;
      redraw();
    };
    const idInput = guard(h("input", { type: "text", value: node.id }));
    idInput.addEventListener("change", () => renameTo(idInput.value.trim()));

    box.append(
      h("h3", {}, "Line"),
      h("div", { className: "im-grid" },
        field("Id", idInput),
        field("Speaker", selectInput(node.speaker, [["npc", this.npc.name], ["player", "Player"]], (v) => { node.speaker = v as "npc" | "player"; redraw(); })),
      ),
      field("Text", (() => { const t = textArea(node.text, (v) => (node.text = v), 4); t.addEventListener("change", redraw); return t; })()),
    );
    if (node.options.length === 0) {
      box.append(field("Then go to", selectInput(node.next ?? "", nodeOpts.filter(([id]) => id !== node.id), (v) => { node.next = v || null; redraw(); }, "(end conversation)")));
    }
    box.append(effectList(node.effects, l, redraw, "When shown"));

    box.append(h("h3", {}, "Choices"), h("div", { className: "dev-empty" }, node.options.length ? "Each choice can lead somewhere different, be hidden by conditions, and make things happen." : "No choices: the line just continues."));
    node.options.forEach((o, i) => {
      box.append(h(
        "div",
        { className: "qe-step" },
        h("div", { className: "qe-step-head" }, h("b", {}, `${i + 1}.`),
          textInput(o.text, (v) => (o.text = v)),
          h("button", { className: "qe-x", onclick: () => { node.options.splice(i, 1); redraw(); } }, "×")),
        field("Goes to", selectInput(o.next ?? "", nodeOpts, (v) => { o.next = v || null; redraw(); }, "(end conversation)")),
        conditionList(o.when, l, redraw, "Shown only when"),
        effectList(o.effects, l, redraw, "If chosen"),
      ));
    });
    box.append(
      h("button", { className: "dev-btn", onclick: () => { node.options.push({ text: "Choice", next: null, when: [], effects: [] }); redraw(); } }, "+ Choice"),
      h("div", { className: "im-actions" },
        h("button", { className: "dev-btn", onclick: () => this.addNode() }, "+ Line after this"),
        h("button", { className: "dev-btn danger", onclick: () => {
          if (!confirm(`Delete line "${node.id}"? Links to it become "end".`)) return;
          this.npc.nodes = this.npc.nodes.filter((n) => n !== node);
          for (const n of this.npc.nodes) {
            if (n.next === node.id) n.next = null;
            for (const o of n.options) if (o.next === node.id) o.next = null;
          }
          this.npc.entries = this.npc.entries.filter((e) => e.start !== node.id);
          this.selected = null;
          redraw();
        } }, "Delete line")),
    );
    return box;
  }

  // --- Play test ---------------------------------------------------------------------------------

  private startPlay(): void {
    const engine = this.deps.engine();
    const node = engine.entryNode(this.npc);
    if (!node) {
      alert("No start point matches your character right now (check the start points' conditions).");
      return;
    }
    this.playing = { node, log: [] };
    this.selected = node.id;
    this.render();
  }

  private playPanel(): HTMLElement {
    const p = this.playing!;
    const engine = this.deps.engine();
    const l = this.deps.lookups;
    const go = (next: string | null, effects: string[]): void => {
      p.log.push(...effects);
      const n = next ? this.npc.nodes.find((x) => x.id === next) : undefined;
      if (!n) {
        this.playing = null;
        this.render();
        return;
      }
      p.node = n;
      this.selected = n.id;
      this.render();
    };
    const visible = engine.options(p.node);
    const box = h("div", { className: "ne-play" },
      h("div", { className: "dl-name" }, p.node.speaker === "npc" ? this.npc.name : "You"),
      h("div", { className: "dl-text" }, p.node.text));
    if (p.node.effects.length) box.append(h("div", { className: "ne-fx" }, `Would: ${p.node.effects.map((e) => describeEffect(e, l)).join(" · ")}`));
    if (visible.length) {
      for (const { option } of visible) {
        box.append(h("button", { className: "dl-opt", onclick: () => go(option.next, option.effects.map((e) => describeEffect(e, l))) },
          `${option.text}${option.effects.length ? `  (${option.effects.map((e) => describeEffect(e, l)).join(", ")})` : ""}`));
      }
    } else {
      box.append(h("button", { className: "dev-btn", onclick: () => go(p.node.next, []) }, p.node.next ? "Continue ▸" : "End"));
    }
    box.append(h("button", { className: "qe-x ne-play-close", title: "Stop", onclick: () => { this.playing = null; this.render(); } }, "×"),
      h("div", { className: "dev-empty" }, "Preview only: effects are listed, not applied. Conditions use your real progress."));
    return box;
  }
}
