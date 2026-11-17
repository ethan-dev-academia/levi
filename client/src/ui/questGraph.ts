import type { QuestDef } from "@levi/shared";

const SVG_NS = "http://www.w3.org/2000/svg";
const CARD_W = 190;
const CARD_H = 52;
const COL_GAP = 70;
const ROW_GAP = 14;
const ACT_GAP = 40;

export const QUEST_CATEGORY_COLOR: Record<QuestDef["category"], string> = {
  act: "#d9b04a",
  world: "#5aa0e0",
  skill: "#6cc24a",
  adventurer: "#c47ad6",
};

export type QuestNodeStatus = "done" | "active" | "available" | "locked";

export interface QuestGraphOptions {
  /** The quests to draw (links are only drawn between these). */
  quests: readonly QuestDef[];
  status(id: string): QuestNodeStatus;
  selected: string | null;
  onPick(id: string): void;
  /** Second line on a card. */
  meta(q: QuestDef): string;
  /** Hover tooltip. */
  tooltip(q: QuestDef): string;
  actLabel(act: number): string;
}

function div(className: string, text?: string): HTMLDivElement {
  const e = document.createElement("div");
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/**
 * Quests as a flow chart: one card per quest, arrows from a required quest
 * to the quests it unlocks. Each act is a band read left to right; links into
 * a later act are dashed. Drag to pan, wheel to zoom, hover a card to trace
 * its chain, click to pick it. Shared by the F2 editor and the player's map.
 */
export function questGraph(o: QuestGraphOptions): HTMLElement {
  const quests = o.quests;
  const byId = new Map(quests.map((q) => [q.id, q]));
  const reqs = (q: QuestDef): string[] => q.requirements.quests.filter((r) => byId.has(r));

  // Column = longest chain of same-act requirements before this quest (cycles cut).
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const q = byId.get(id)!;
    const d = reqs(q).filter((r) => byId.get(r)!.act === q.act).reduce((m, r) => Math.max(m, depthOf(r) + 1), 0);
    visiting.delete(id);
    depth.set(id, d);
    return d;
  };
  for (const q of quests) depthOf(q.id);

  const rank = { act: 0, world: 1, adventurer: 2, skill: 3 } as const;
  const acts = [...new Set(quests.map((q) => q.act))].sort((a, b) => a - b);
  const pos = new Map<string, { x: number; y: number }>();
  const bands: Array<{ act: number; y: number; h: number }> = [];
  let y0 = 30;
  for (const act of acts) {
    const cols = new Map<number, QuestDef[]>();
    for (const q of quests.filter((x) => x.act === act)) {
      const d = depth.get(q.id)!;
      if (!cols.has(d)) cols.set(d, []);
      cols.get(d)!.push(q);
    }
    let rows = 0;
    for (const d of [...cols.keys()].sort((a, b) => a - b)) {
      const col = cols.get(d)!;
      // Story first, then follow the rows of whatever unlocked each quest, so lines cross less.
      const avg = (q: QuestDef): number => {
        const ys = reqs(q).filter((r) => byId.get(r)!.act === act).map((r) => pos.get(r)?.y).filter((v): v is number => v !== undefined);
        return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : Number.MAX_SAFE_INTEGER;
      };
      col.sort((a, b) => rank[a.category] - rank[b.category] || avg(a) - avg(b) || a.name.localeCompare(b.name));
      col.forEach((q, i) => pos.set(q.id, { x: 30 + d * (CARD_W + COL_GAP), y: y0 + 22 + i * (CARD_H + ROW_GAP) }));
      rows = Math.max(rows, col.length);
    }
    const bandH = 22 + rows * (CARD_H + ROW_GAP);
    bands.push({ act, y: y0, h: bandH });
    y0 += bandH + ACT_GAP;
  }
  const maxDepth = Math.max(0, ...depth.values());
  const W = 60 + (maxDepth + 1) * (CARD_W + COL_GAP);
  const H = y0;

  const canvas = div("qg-canvas");
  canvas.style.width = `${W}px`;
  canvas.style.height = `${H}px`;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", String(W));
  svg.setAttribute("height", String(H));
  svg.setAttribute("class", "qg-lines");
  svg.innerHTML = `<defs><marker id="qg-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="currentColor"/></marker></defs>`;
  canvas.append(svg);

  for (const b of bands) {
    const band = div("qg-band");
    band.style.top = `${b.y}px`;
    band.style.height = `${b.h}px`;
    band.style.width = `${W}px`;
    band.append(div("qg-band-label", o.actLabel(b.act)));
    canvas.append(band);
  }

  const edges: Array<{ from: string; to: string; el: SVGPathElement }> = [];
  for (const q of quests) {
    const b = pos.get(q.id)!;
    for (const r of reqs(q)) {
      const a = pos.get(r)!;
      const crossAct = byId.get(r)!.act !== q.act;
      const x1 = a.x + CARD_W, y1 = a.y + CARD_H / 2, x2 = b.x, y2 = b.y + CARD_H / 2;
      const mx = (x1 + x2) / 2;
      const p = document.createElementNS(SVG_NS, "path");
      p.setAttribute("d", crossAct
        ? `M${a.x + CARD_W / 2},${a.y + CARD_H} C${a.x + CARD_W / 2},${a.y + CARD_H + 60} ${b.x + CARD_W / 2},${b.y - 60} ${b.x + CARD_W / 2},${b.y - 2}`
        : x2 > x1 ? `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2 - 2},${y2}` : `M${x1},${y1} C${x1 + 60},${y1 + 80} ${x2 - 60},${y2 + 80} ${x2 - 2},${y2}`);
      p.setAttribute("marker-end", "url(#qg-arrow)");
      if (crossAct) p.classList.add("cross");
      if (o.status(r) === "done") p.classList.add("walked");
      svg.append(p);
      edges.push({ from: r, to: q.id, el: p });
    }
  }

  const cards = new Map<string, HTMLElement>();
  for (const q of quests) {
    const p = pos.get(q.id)!;
    const st = o.status(q.id);
    const card = div(`qg-card ${st}${q.category === "act" ? " key" : ""}${q.id === o.selected ? " selected" : ""}`);
    const name = div("qg-name");
    const dot = document.createElement("i");
    dot.className = `qg-dot ${st}`;
    name.append(dot, document.createTextNode(q.name));
    card.append(name, div("qg-meta", o.meta(q)));
    card.style.left = `${p.x}px`;
    card.style.top = `${p.y}px`;
    card.style.borderLeftColor = QUEST_CATEGORY_COLOR[q.category];
    card.title = o.tooltip(q);
    card.addEventListener("click", () => o.onPick(q.id));
    cards.set(q.id, card);
    canvas.append(card);
  }

  // Hover: light up what this quest needs and what it leads to.
  const chain = (start: string, up: boolean): Set<string> => {
    const out = new Set<string>([start]);
    const stack = [start];
    while (stack.length) {
      const id = stack.pop()!;
      for (const e of edges) {
        const next = up ? (e.to === id ? e.from : null) : e.from === id ? e.to : null;
        if (next && !out.has(next)) {
          out.add(next);
          stack.push(next);
        }
      }
    }
    return out;
  };
  for (const [id, card] of cards) {
    card.addEventListener("pointerenter", () => {
      const lit = new Set([...chain(id, true), ...chain(id, false)]);
      canvas.classList.add("focus");
      for (const [cid, c] of cards) c.classList.toggle("lit", lit.has(cid));
      for (const e of edges) e.el.classList.toggle("lit", lit.has(e.from) && lit.has(e.to));
    });
    card.addEventListener("pointerleave", () => {
      canvas.classList.remove("focus");
      for (const c of cards.values()) c.classList.remove("lit");
      for (const e of edges) e.el.classList.remove("lit");
    });
  }

  // Viewport: drag to pan, wheel to zoom (around the cursor).
  const view = div("qg-view");
  view.append(canvas);
  let zoom = 1, panX = 0, panY = 0;
  const apply = (): void => {
    canvas.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
  };
  view.addEventListener("wheel", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const r = view.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const next = Math.max(0.3, Math.min(1.6, zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
    panX = mx - ((mx - panX) * next) / zoom;
    panY = my - ((my - panY) * next) / zoom;
    zoom = next;
    apply();
  }, { passive: false });
  let drag: { x: number; y: number; px: number; py: number } | null = null;
  view.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    if ((e.target as HTMLElement).closest(".qg-card")) return;
    drag = { x: e.clientX, y: e.clientY, px: panX, py: panY };
    view.setPointerCapture(e.pointerId);
    view.classList.add("dragging");
  });
  view.addEventListener("pointermove", (e) => {
    if (!drag) return;
    panX = drag.px + e.clientX - drag.x;
    panY = drag.py + e.clientY - drag.y;
    apply();
  });
  view.addEventListener("pointerup", () => {
    drag = null;
    view.classList.remove("dragging");
  });
  // Start zoomed to fit (not below 60%); if it still doesn't fit, scroll toward
  // the selected or first active quest without leaving empty space at the edges.
  requestAnimationFrame(() => {
    const vw = view.clientWidth, vh = view.clientHeight;
    zoom = Math.max(0.6, Math.min(1, vw / W, vh / H));
    const focus = o.selected ?? quests.find((q) => o.status(q.id) === "active")?.id;
    const p = focus ? pos.get(focus) : undefined;
    const fit = (want: number, size: number, viewSize: number): number => Math.max(Math.min(0, viewSize - size * zoom), Math.min(0, want));
    panX = p ? fit(vw / 2 - (p.x + CARD_W / 2) * zoom, W, vw) : 0;
    panY = p ? fit(vh / 2 - (p.y + CARD_H / 2) * zoom, H, vh) : 0;
    apply();
  });
  return view;
}

/** Colour key for the chart. */
export function questGraphLegend(extra: string): HTMLElement {
  const legend = div("qg-legend");
  for (const c of Object.keys(QUEST_CATEGORY_COLOR) as Array<QuestDef["category"]>) {
    const s = document.createElement("span");
    const sw = document.createElement("i");
    sw.style.background = QUEST_CATEGORY_COLOR[c];
    s.append(sw, document.createTextNode(c === "act" ? "act (key)" : c));
    legend.append(s);
  }
  for (const [st, label] of [["done", "done"], ["active", "in progress"], ["available", "can start"]] as const) {
    const s = document.createElement("span");
    const dot = document.createElement("i");
    dot.className = `qg-dot ${st}`;
    s.append(dot, document.createTextNode(label));
    legend.append(s);
  }
  legend.append(div("qg-hint", extra));
  return legend;
}
