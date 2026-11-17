import { ART_CHARS, ART_SIZES, ItemArtSchema, type ItemArt } from "@levi/shared";
import { artSvg, itemIcon } from "../ui/itemIcons.js";
import type { ITEM_ICONS } from "@levi/shared";
import { h } from "./dom.js";

type Tool = "pencil" | "eraser" | "fill" | "picker";
const CANVAS_PX = 320;
const MAX_UNDO = 60;
const DEFAULT_PALETTE = ["#15120e", "#5b3a22", "#8a5a35", "#c9a46a", "#d0d4da", "#9aa0a8", "#f0e2b0", "#d05a4a"];

export interface ArtEditorOptions {
  /** Glyph + tint to trace from. */
  glyph(): { icon: (typeof ITEM_ICONS)[number]; color: string };
  /** CSS class for the rarity backing in previews ("rarity-common"...). */
  hueClass(): string;
  onChange(art: ItemArt | undefined): void;
}

/**
 * Pixel-art editor for item icons. Edits a palette-indexed grid; the game
 * draws it as vector rects (crisp at any size). Pencil / eraser / fill /
 * picker, mirror drawing, undo, palette editing, resize, trace-from-glyph.
 */
export class ArtEditor {
  readonly root: HTMLElement;
  private size: number;
  private palette: string[];
  private grid: Int8Array;
  private tool: Tool = "pencil";
  private color = 0;
  private mirror = false;
  private readonly undo: Array<{ size: number; palette: string[]; grid: Int8Array }> = [];
  private readonly canvas = h("canvas", { width: CANVAS_PX, height: CANVAS_PX, className: "art-canvas" });
  private readonly ctx: CanvasRenderingContext2D;
  private readonly toolsRow = h("div", { className: "art-tools" });
  private readonly paletteRow = h("div", { className: "art-palette" });
  private readonly previews = h("div", { className: "art-previews" });
  private painting = false;

  constructor(art: ItemArt | undefined, private readonly opts: ArtEditorOptions) {
    this.size = art?.size ?? 16;
    this.palette = art ? [...art.palette] : [...DEFAULT_PALETTE];
    this.grid = new Int8Array(this.size * this.size).fill(-1);
    if (art) {
      art.rows.forEach((row, y) => {
        for (let x = 0; x < row.length; x++) {
          const ch = row[x]!;
          this.grid[y * this.size + x] = ch === "." ? -1 : ART_CHARS.indexOf(ch);
        }
      });
    }
    this.ctx = this.canvas.getContext("2d")!;

    this.canvas.addEventListener("pointerdown", (e) => this.down(e));
    this.canvas.addEventListener("pointermove", (e) => this.painting && this.paintAt(e));
    window.addEventListener("pointerup", () => (this.painting = false));
    this.canvas.addEventListener("contextmenu", (e) => e.preventDefault());

    const sizeSel = h("select", {});
    for (const s of ART_SIZES) sizeSel.append(h("option", { value: String(s), selected: s === this.size }, `${s}×${s}`));
    sizeSel.addEventListener("change", () => this.resize(Number(sizeSel.value)));

    this.root = h(
      "div",
      { className: "art-editor" },
      this.toolsRow,
      this.canvas,
      this.paletteRow,
      h(
        "div",
        { className: "art-row" },
        sizeSel,
        h("button", { className: "dev-btn", onclick: () => this.doUndo() }, "Undo"),
        h("button", { className: "dev-btn", onclick: () => { this.checkpoint(); this.grid.fill(-1); this.commit(); } }, "Clear"),
        h("button", { className: "dev-btn", title: "Rasterise the item's glyph into pixels", onclick: () => void this.trace() }, "Trace glyph"),
        h("button", { className: "dev-btn danger", title: "Go back to the glyph", onclick: () => this.removeArt() }, "Use glyph"),
      ),
      h("div", { className: "dev-empty" }, "Left-click paints, right-click erases. Right-click a swatch to delete it, double-click to change it."),
      this.previews,
    );
    this.renderTools();
    this.renderPalette();
    this.draw();
    this.renderPreviews();
  }

  // --- Model -------------------------------------------------------------------------

  private toArt(): ItemArt {
    const rows: string[] = [];
    for (let y = 0; y < this.size; y++) {
      let r = "";
      for (let x = 0; x < this.size; x++) {
        const v = this.grid[y * this.size + x]!;
        r += v < 0 ? "." : ART_CHARS[v];
      }
      rows.push(r);
    }
    return { size: this.size, palette: [...this.palette], rows };
  }

  private checkpoint(): void {
    this.undo.push({ size: this.size, palette: [...this.palette], grid: this.grid.slice() });
    if (this.undo.length > MAX_UNDO) this.undo.shift();
  }

  private doUndo(): void {
    const s = this.undo.pop();
    if (!s) return;
    this.size = s.size;
    this.palette = s.palette;
    this.grid = s.grid;
    this.color = Math.min(this.color, this.palette.length - 1);
    this.renderPalette();
    this.commit();
  }

  /** Redraw and report the new art. */
  private commit(): void {
    this.draw();
    this.renderPreviews();
    const art = this.toArt();
    this.opts.onChange(ItemArtSchema.safeParse(art).success ? art : undefined);
  }

  private removeArt(): void {
    this.checkpoint();
    this.grid.fill(-1);
    this.draw();
    this.renderPreviews();
    this.opts.onChange(undefined);
  }

  private resize(n: number): void {
    if (n === this.size) return;
    this.checkpoint();
    const old = this.grid;
    const o = this.size;
    const g = new Int8Array(n * n).fill(-1);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) g[y * n + x] = old[Math.floor((y * o) / n) * o + Math.floor((x * o) / n)]!;
    }
    this.size = n;
    this.grid = g;
    this.commit();
  }

  // --- Painting -------------------------------------------------------------------------

  private cellOf(e: PointerEvent): [number, number] | null {
    const r = this.canvas.getBoundingClientRect();
    const x = Math.floor(((e.clientX - r.left) / r.width) * this.size);
    const y = Math.floor(((e.clientY - r.top) / r.height) * this.size);
    return x >= 0 && y >= 0 && x < this.size && y < this.size ? [x, y] : null;
  }

  private down(e: PointerEvent): void {
    e.preventDefault();
    const c = this.cellOf(e);
    if (!c) return;
    const erase = e.button === 2;
    if (this.tool === "picker" && !erase) {
      const v = this.grid[c[1] * this.size + c[0]]!;
      if (v >= 0) {
        this.color = v;
        this.tool = "pencil";
        this.renderTools();
        this.renderPalette();
      }
      return;
    }
    this.checkpoint();
    if (this.tool === "fill" && !erase) {
      this.fill(c[0], c[1], this.color);
      this.commit();
      return;
    }
    this.painting = true;
    this.eraseStroke = erase || this.tool === "eraser";
    this.paintAt(e);
  }

  private eraseStroke = false;

  private paintAt(e: PointerEvent): void {
    const c = this.cellOf(e);
    if (!c) return;
    const v = this.eraseStroke ? -1 : this.color;
    const set = (x: number, y: number): void => {
      this.grid[y * this.size + x] = v;
    };
    set(c[0], c[1]);
    if (this.mirror) set(this.size - 1 - c[0], c[1]);
    this.commit();
  }

  private fill(x: number, y: number, v: number): void {
    const n = this.size;
    const target = this.grid[y * n + x]!;
    if (target === v) return;
    const stack = [[x, y]];
    while (stack.length) {
      const [cx, cy] = stack.pop()!;
      if (cx! < 0 || cy! < 0 || cx! >= n || cy! >= n || this.grid[cy! * n + cx!] !== target) continue;
      this.grid[cy! * n + cx!] = v;
      stack.push([cx! + 1, cy!], [cx! - 1, cy!], [cx!, cy! + 1], [cx!, cy! - 1]);
    }
  }

  /** Rasterise the current glyph into the grid (quantised to ≤16 colours). */
  private async trace(): Promise<void> {
    const g = this.opts.glyph();
    const svg = itemIcon(g.icon, g.color);
    svg.setAttribute("width", String(this.size));
    svg.setAttribute("height", String(this.size));
    svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    const img = new Image();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = c.height = this.size;
    const cx = c.getContext("2d")!;
    cx.drawImage(img, 0, 0, this.size, this.size);
    const data = cx.getImageData(0, 0, this.size, this.size).data;
    this.checkpoint();
    const palette: string[] = [];
    const hex = (r: number, g2: number, b: number): string => `#${[r, g2, b].map((v) => (Math.round(v / 17) * 17).toString(16).padStart(2, "0")).join("")}`;
    const nearest = (col: string): number => {
      const [r, g2, b] = [1, 3, 5].map((i) => parseInt(col.slice(i, i + 2), 16));
      let best = 0;
      let bd = Infinity;
      palette.forEach((p, i) => {
        const d = (parseInt(p.slice(1, 3), 16) - r!) ** 2 + (parseInt(p.slice(3, 5), 16) - g2!) ** 2 + (parseInt(p.slice(5, 7), 16) - b!) ** 2;
        if (d < bd) { bd = d; best = i; }
      });
      return best;
    };
    for (let i = 0; i < this.size * this.size; i++) {
      if (data[i * 4 + 3]! < 110) {
        this.grid[i] = -1;
        continue;
      }
      const col = hex(data[i * 4]!, data[i * 4 + 1]!, data[i * 4 + 2]!);
      let idx = palette.indexOf(col);
      if (idx < 0) {
        if (palette.length < 16) idx = palette.push(col) - 1;
        else idx = nearest(col);
      }
      this.grid[i] = idx;
    }
    this.palette = palette.length ? palette : [...DEFAULT_PALETTE];
    this.color = 0;
    this.renderPalette();
    this.commit();
  }

  // --- View ------------------------------------------------------------------------------

  private draw(): void {
    const n = this.size;
    const cell = CANVAS_PX / n;
    const c = this.ctx;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const v = this.grid[y * n + x]!;
        c.fillStyle = v >= 0 ? this.palette[v]! : (x + y) % 2 ? "#23252c" : "#1b1d22";
        c.fillRect(x * cell, y * cell, cell, cell);
      }
    }
    c.strokeStyle = "rgba(255,255,255,0.06)";
    c.lineWidth = 1;
    c.beginPath();
    for (let i = 1; i < n; i++) {
      c.moveTo(Math.round(i * cell) + 0.5, 0);
      c.lineTo(Math.round(i * cell) + 0.5, CANVAS_PX);
      c.moveTo(0, Math.round(i * cell) + 0.5);
      c.lineTo(CANVAS_PX, Math.round(i * cell) + 0.5);
    }
    c.stroke();
    if (this.mirror) {
      c.strokeStyle = "rgba(139,92,246,0.6)";
      c.beginPath();
      c.moveTo(CANVAS_PX / 2, 0);
      c.lineTo(CANVAS_PX / 2, CANVAS_PX);
      c.stroke();
    }
  }

  private renderTools(): void {
    const tools: Array<[Tool, string]> = [["pencil", "Pencil"], ["eraser", "Eraser"], ["fill", "Fill"], ["picker", "Pick"]];
    this.toolsRow.replaceChildren(
      ...tools.map(([t, label]) => {
        const b = h("button", { className: `dev-btn${this.tool === t ? " active" : ""}`, onclick: () => { this.tool = t; this.renderTools(); } }, label);
        return b;
      }),
      (() => {
        const b = h("button", { className: `dev-btn${this.mirror ? " active" : ""}`, title: "Mirror left/right while drawing", onclick: () => { this.mirror = !this.mirror; this.renderTools(); this.draw(); } }, "Mirror");
        return b;
      })(),
    );
  }

  private renderPalette(): void {
    this.paletteRow.replaceChildren();
    this.palette.forEach((col, i) => {
      const sw = h("button", { className: `art-swatch${i === this.color ? " active" : ""}`, title: col });
      sw.style.background = col;
      sw.addEventListener("click", () => {
        this.color = i;
        if (this.tool === "eraser" || this.tool === "picker") this.tool = "pencil";
        this.renderTools();
        this.renderPalette();
      });
      sw.addEventListener("dblclick", () => this.pickColor(col, (c) => {
        this.checkpoint();
        this.palette[i] = c;
        this.renderPalette();
        this.commit();
      }));
      sw.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        if (this.palette.length <= 1) return;
        this.checkpoint();
        this.palette.splice(i, 1);
        for (let k = 0; k < this.grid.length; k++) {
          const v = this.grid[k]!;
          if (v === i) this.grid[k] = -1;
          else if (v > i) this.grid[k] = v - 1;
        }
        this.color = Math.min(this.color, this.palette.length - 1);
        this.renderPalette();
        this.commit();
      });
      this.paletteRow.append(sw);
    });
    if (this.palette.length < 16) {
      const add = h("button", { className: "art-swatch add", title: "Add a colour" }, "+");
      add.addEventListener("click", () => this.pickColor("#ffffff", (c) => {
        this.checkpoint();
        this.palette.push(c);
        this.color = this.palette.length - 1;
        this.renderPalette();
        this.commit();
      }));
      this.paletteRow.append(add);
    }
  }

  private pickColor(initial: string, done: (c: string) => void): void {
    const input = h("input", { type: "color", value: initial });
    input.style.position = "fixed";
    input.style.opacity = "0";
    input.style.pointerEvents = "none";
    document.body.append(input);
    input.addEventListener("change", () => {
      done(input.value);
      input.remove();
    });
    input.addEventListener("blur", () => setTimeout(() => input.remove(), 200));
    input.click();
  }

  private renderPreviews(): void {
    const art = this.toArt();
    const empty = !art.rows.some((r) => /[^.]/.test(r));
    this.previews.replaceChildren(
      ...[32, 48, 64].map((px) => {
        const box = h("div", { className: `islot filled art-preview ${this.opts.hueClass()}` });
        box.style.width = box.style.height = `${px}px`;
        if (!empty) box.append(artSvg(art));
        return box;
      }),
    );
  }
}
