import { ROOF_KINDS, WALL_MATERIALS, type PropDef, type RoofKind, type WallMaterial } from "@levi/shared";
import type { BuildTool, BuildToolId, RoomPreset } from "./BuildTool.js";
import { h } from "./dom.js";

const TOOLS: ReadonlyArray<[BuildToolId, string, string]> = [
  ["room", "Room", "Drag a box: floor + walls (preset below)"],
  ["wall", "Wall", "Drag along cell edges. Drag over existing walls to remove them"],
  ["door", "Door", "Click/drag an edge: open doorway"],
  ["window", "Window", "Click/drag an edge: window (blocks walking)"],
  ["floor", "Floor", "Drag a box of floor tiles (no walls)"],
  ["stairs", "Stairs", "Click a cell: 3-long stairs climbing away from the camera. Click again to remove"],
  ["ladder", "Ladder", "Click a cell: ladder up one storey (click again on the next storey to stack)"],
  ["prop", "Prop", "Click a cell to place the prop below (click it again to remove). [ ] rotates"],
  ["erase", "Erase", "Drag a box: remove tiles, walls, stairs and props on this storey"],
  ["select", "Select", "Click a building to select it"],
];

const PRESETS: ReadonlyArray<[RoomPreset, string]> = [["house", "House"], ["shed", "Shed"], ["floor", "Floor only"]];

const SWATCH: Record<WallMaterial, string> = { wood: "#8a5a35", brick: "#a3533b", stone: "#8f8a80", plaster: "#d8cdb4" };

/** F1 → Build tab. Pure DOM over BuildTool state. */
export class BuildPanel {
  readonly root: HTMLElement;
  private readonly toolButtons = new Map<BuildToolId, HTMLButtonElement>();
  private readonly toolHint: HTMLElement;
  private readonly presetRow: HTMLElement;
  private readonly materialRow: HTMLElement;
  private readonly storeyLabel: HTMLElement;
  private readonly selectedBox: HTMLElement;
  private readonly propBox: HTMLElement;
  private readonly presetBox: HTMLElement;
  private rendered = "";

  constructor(
    private readonly tool: BuildTool,
    private readonly propDefs: ReadonlyMap<string, PropDef>,
  ) {
    const grid = h("div", { className: "dev-grid" });
    for (const [id, label, hint] of TOOLS) {
      const b = h("button", { className: "dev-btn", title: hint, onclick: () => this.selectTool(id) }, label);
      this.toolButtons.set(id, b);
      grid.append(b);
    }
    this.toolHint = h("div", { className: "dev-empty" });
    this.presetRow = h("div", { className: "dev-grid cols-3" });
    this.materialRow = h("div", { className: "dev-swatches" });
    this.storeyLabel = h("span", { className: "dev-storey" });
    this.selectedBox = h("div", { className: "dev-building" });
    this.propBox = h("div", { className: "dev-props" });

    this.root = h(
      "section",
      { className: "dev-build" },
      grid,
      this.toolHint,
      this.propBox,
      (this.presetBox = h("div", {}, h("h3", {}, "Room preset"), this.presetRow, h("h3", {}, "Material"), this.materialRow)),
      h("h3", {}, "Storey"),
      h(
        "div",
        { className: "dev-grid cols-3" },
        h("button", { className: "dev-btn", onclick: () => tool.setStorey(tool.settings.storey - 1) }, "▼ Down"),
        this.storeyLabel,
        h("button", { className: "dev-btn", onclick: () => tool.setStorey(tool.settings.storey + 1) }, "▲ Up"),
      ),
      h("h3", {}, "Selected building"),
      this.selectedBox,
    );
    this.selectTool(tool.settings.tool);
  }

  private selectTool(id: BuildToolId): void {
    this.tool.settings.tool = id;
    this.refresh(true);
  }

  refresh(force = false): void {
    const s = this.tool.settings;
    for (const [id, b] of this.toolButtons) b.classList.toggle("active", id === s.tool);
    this.toolHint.textContent = TOOLS.find(([id]) => id === s.tool)?.[2] ?? "";

    this.presetRow.replaceChildren(
      ...PRESETS.map(([p, label]) => {
        const b = h("button", { className: "dev-btn", onclick: () => { s.preset = p; this.refresh(true); } }, label);
        b.classList.toggle("active", s.preset === p);
        return b;
      }),
    );
    this.materialRow.replaceChildren(
      ...WALL_MATERIALS.map((m) => {
        const sw = h("div", { className: "dev-swatch", title: m });
        sw.style.background = SWATCH[m];
        sw.classList.toggle("active", s.material === m);
        sw.addEventListener("click", () => { s.material = m; this.refresh(true); });
        return sw;
      }),
    );
    this.presetBox.hidden = s.tool === "prop";
    this.renderProps(force);
    const sel = this.tool.selected;
    this.storeyLabel.textContent = sel ? `Storey ${s.storey} / ${sel.storeys.length - 1}` : "Ground";

    // Rebuild the selected-building form only when it changed and isn't being typed in.
    const snap = JSON.stringify(sel);
    if (!force && snap === this.rendered) return;
    if (this.selectedBox.contains(document.activeElement) && !force) return;
    this.rendered = snap;
    this.renderSelected();
  }

  private renderedProps = "";

  /** Prop palette, facing and sign text (only while the Prop tool is active). */
  private renderProps(force: boolean): void {
    const s = this.tool.settings;
    this.propBox.hidden = s.tool !== "prop";
    const snap = `${s.tool}|${s.prop}|${s.rot}`;
    if (!force && snap === this.renderedProps) return;
    if (this.propBox.contains(document.activeElement) && !force) return;
    this.renderedProps = snap;
    this.propBox.replaceChildren();
    if (s.tool !== "prop") return;
    const defs = [...this.propDefs.values()];
    for (const cat of ["furniture", "storage", "decor", "signage"] as const) {
      const list = defs.filter((d) => d.category === cat);
      if (list.length === 0) continue;
      this.propBox.append(
        h("h3", {}, cat),
        h(
          "div",
          { className: "dev-grid cols-3" },
          ...list.map((d) => {
            const b = h("button", { className: "dev-btn", title: d.solid ? "Blocks walking" : "Walkable", onclick: () => { s.prop = d.id; this.refresh(true); } }, d.name);
            b.classList.toggle("active", s.prop === d.id);
            return b;
          }),
        ),
      );
    }
    const facing = ["South", "West", "North", "East"][s.rot] ?? "South";
    this.propBox.append(
      h("div", { className: "dev-field" }, `Facing ${facing}`, h("button", { className: "dev-btn", onclick: () => this.tool.rotateProp() }, "Rotate ⟳")),
    );
    if (this.propDefs.get(s.prop)?.readable) {
      const text = h("textarea", { value: s.signText, maxLength: 1000, rows: 3 });
      text.addEventListener("input", () => (s.signText = text.value));
      this.propBox.append(h("h3", {}, "Sign text (new signs)"), text);
    }
  }

  private renderSelected(): void {
    const sel = this.tool.selected;
    this.selectedBox.replaceChildren();
    if (!sel) {
      this.selectedBox.append(h("div", { className: "dev-empty" }, "None. Drag a Room to create one, or use Select."));
      return;
    }
    const name = h("input", { type: "text", value: sel.name, maxLength: 64 });
    name.addEventListener("change", () => name.value.trim() && this.tool.updateSelected({ name: name.value.trim() }));

    const material = h("select", {});
    for (const m of WALL_MATERIALS) material.append(h("option", { value: m, selected: m === sel.material }, m));
    material.addEventListener("change", () => this.tool.updateSelected({ material: material.value as WallMaterial }));

    const roof = h("select", {});
    for (const k of ROOF_KINDS) roof.append(h("option", { value: k, selected: k === sel.roof.kind }, k));
    roof.addEventListener("change", () => this.tool.updateSelected({ roof: { kind: roof.value as RoofKind } }));

    const num = (value: number, step: number, apply: (v: number) => void): HTMLInputElement => {
      const i = h("input", { type: "number", step: String(step), value: String(value) });
      i.addEventListener("change", () => {
        const v = Number(i.value);
        if (Number.isFinite(v)) apply(v);
      });
      return i;
    };

    this.selectedBox.append(
      h("div", { className: "dev-region-row" }, name, material),
      h("div", { className: "dev-region-meta" }, `${sel.id} · ${sel.storeys.length} storey(s) · ${sel.stairs.length} stair(s)`),
      h("div", { className: "dev-field" }, "Roof", roof),
      h("div", { className: "dev-field" }, "Roof pitch", num(sel.roof.pitch, 0.1, (v) => this.tool.updateSelected({ roof: { pitch: Math.max(0.1, Math.min(2, v)) } }))),
      h("div", { className: "dev-field" }, "Floor height", num(sel.baseY, 0.1, (v) => this.tool.updateSelected({ baseY: v }))),
      h("div", { className: "dev-field" }, "Storey height", num(sel.floorHeight, 0.1, (v) => this.tool.updateSelected({ floorHeight: Math.max(2, Math.min(6, v)) }))),
      h(
        "div",
        { className: "dev-grid cols-2" },
        h("button", { className: "dev-btn", onclick: () => this.tool.select(null) }, "Deselect"),
        h("button", { className: "dev-btn", onclick: () => confirm(`Delete ${sel.name}? (Undoable)`) && this.tool.deleteSelected() }, "Delete"),
      ),
    );
  }
}
