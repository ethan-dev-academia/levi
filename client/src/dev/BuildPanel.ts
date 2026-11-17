import { ROOF_KINDS, WALL_MATERIALS, type EnemyDef, type ItemDef, type NpcDef, type PropDef, type RoofKind, type WallMaterial } from "@levi/shared";
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
  ["npc", "NPC", "Click a cell to place the NPC below, facing the arrow. Click a placed NPC to edit its movement or remove it. Create NPCs with F2"],
  ["item", "Item", "Click a cell to drop the item below on the ground; players pick up their own copy (click to remove)"],
  ["enemy", "Enemy", "Click a cell to set an enemy's home spot; it roams around it and respawns there (click a spot to remove). Edit enemies with F2"],
  ["zone", "Zone", "Spawn zones: paint any shape of cells, then list which enemies live there and how many. They appear at random spots in the zone and roam all of it"],
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
    private readonly npcs: ReadonlyMap<string, NpcDef>,
    private readonly items: ReadonlyMap<string, ItemDef>,
    private readonly enemies: ReadonlyMap<string, EnemyDef>,
    private readonly placedEnemies: () => number,
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
      this.placerBox,
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
    this.presetBox.hidden = s.tool === "prop" || s.tool === "npc" || s.tool === "item";
    this.renderPlacers(force);
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

  private renderedPlacers = "";
  private readonly placerBox = h("div", { className: "dev-props" });

  /** NPC / Item tool pickers. */
  private renderPlacers(force: boolean): void {
    const s = this.tool.settings;
    this.placerBox.hidden = s.tool !== "npc" && s.tool !== "item" && s.tool !== "enemy" && s.tool !== "zone";
    const sp = this.tool.placedNpc();
    const zoneSnap = this.tool.zones.map((z) => `${z.id}:${z.name}:${z.cells.length}:${JSON.stringify(z.mobs)}`).join(";");
    const snap = `${zoneSnap}|${s.zone}|${s.zoneErase}|${s.zoneBrush}|${s.enemy}|${s.enemyWander}|${s.tool}|${s.npc}|${s.groundItem}|${s.rot}|${this.npcs.size}|${this.items.size}|${s.npcWander}|${s.recordingRoute}|${JSON.stringify(sp ?? null)}`;
    if (!force && snap === this.renderedPlacers) return;
    if (this.placerBox.contains(document.activeElement) && !force) return;
    this.renderedPlacers = snap;
    this.placerBox.replaceChildren();
    if (s.tool === "npc") {
      const sel = h("select", {});
      if (!this.npcs.size) sel.append(h("option", { value: "" }, "No NPCs yet: press F2 to make one"));
      for (const n of [...this.npcs.values()].sort((a, b) => a.name.localeCompare(b.name) || a.location.localeCompare(b.location))) {
        const label = `${n.name}${n.location ? ` · ${n.location}` : n.title ? ` (${n.title})` : ""}`;
        sel.append(h("option", { value: n.id, selected: n.id === s.npc }, label));
      }
      if (!s.npc && this.npcs.size) s.npc = [...this.npcs.keys()][0]!;
      sel.addEventListener("change", () => (s.npc = sel.value));
      if (this.propDefs.get(s.prop)?.category === "nature") this.propBox.append(this.scatterControls());
    const facing = ["South", "West", "North", "East"][s.rot] ?? "South";
      const moveBtns = (current: string, pick: (m: "none" | "area" | "route") => void): HTMLElement =>
        h("div", { className: "dev-grid cols-3" }, ...(["none", "area", "route"] as const).map((m) => {
          const b = h("button", { className: "dev-btn", onclick: () => pick(m) }, m === "none" ? "Stand" : m === "area" ? "Wander" : "Route");
          b.classList.toggle("active", current === m);
          return b;
        }));
      const radiusInput = (value: number, set: (v: number) => void): HTMLElement => {
        const r = h("input", { type: "number", min: "1", max: "6", value: String(value) });
        r.addEventListener("keydown", (e) => e.stopPropagation());
        r.addEventListener("change", () => set(Math.max(1, Math.min(6, Math.round(Number(r.value) || 1)))));
        return h("div", { className: "dev-field" }, "Wander radius (1 = 3×3)", r);
      };
      this.placerBox.append(h("h3", {}, "NPC"), sel,
        h("div", { className: "dev-field" }, `Facing ${facing}`, h("button", { className: "dev-btn", onclick: () => this.tool.rotateProp() }, "Rotate ⟳")),
        h("h3", {}, "New NPCs move"),
        moveBtns(s.npcWander, (m) => { s.npcWander = m; this.refresh(true); }),
        ...(s.npcWander === "area" ? [radiusInput(s.npcRadius, (v) => (s.npcRadius = v))] : []),
        h("div", { className: "dev-empty" }, "Click a placed NPC to edit it. Pauses between moves are random."));

      // The placed NPC being edited.
      const sp = this.tool.placedNpc();
      if (sp) {
        const name = this.npcs.get(sp.npc)?.name ?? sp.npc;
        const box = h("div", { className: "dev-building" },
          h("div", { className: "dev-region-meta" }, `${name} · ${sp.id} · (${sp.x}, ${sp.z})`),
          moveBtns(sp.wander, (m) => {
            this.tool.updateNpc(sp.id, { wander: m });
            if (m === "route") s.recordingRoute = sp.route.length === 0;
            this.refresh(true);
          }));
        if (sp.wander === "area") box.append(radiusInput(sp.radius, (v) => this.tool.updateNpc(sp.id, { radius: v })));
        if (sp.wander === "route") {
          box.append(h("div", { className: "dev-empty" }, s.recordingRoute
            ? `Recording: click cells to add stops (${sp.route.length} so far). They walk spot → stop 1 → … → back.`
            : `${sp.route.length} stop(s).`),
          h("div", { className: "dev-grid cols-3" },
            h("button", { className: `dev-btn${s.recordingRoute ? " active" : ""}`, onclick: () => { s.recordingRoute = !s.recordingRoute; this.refresh(true); } }, s.recordingRoute ? "Finish route" : "Add stops"),
            h("button", { className: "dev-btn", onclick: () => this.tool.updateNpc(sp.id, { route: sp.route.slice(0, -1) }) }, "Undo stop"),
            h("button", { className: "dev-btn", onclick: () => this.tool.updateNpc(sp.id, { route: [] }) }, "Clear")));
        }
        box.append(h("div", { className: "dev-grid cols-3" },
          h("button", { className: "dev-btn", onclick: () => this.tool.updateNpc(sp.id, { rot: (sp.rot + 1) & 3 }) }, "Turn ⟳"),
          h("button", { className: "dev-btn", onclick: () => { s.editNpc = null; s.recordingRoute = false; this.refresh(true); } }, "Done"),
          h("button", { className: "dev-btn danger", onclick: () => this.tool.removeNpc(sp.id) }, "Remove")));
        this.placerBox.append(h("h3", {}, "Selected NPC"), box);
      }
    } else if (s.tool === "zone") {
      this.placerBox.append(h("h3", {}, "Spawn zones"));
      const list = h("div", { className: "dev-zone-list" });
      for (const z of this.tool.zones) {
        const mobs = z.mobs.map((m) => `${m.count} ${this.enemies.get(m.enemy)?.name ?? m.enemy}`).join(", ") || "no enemies yet";
        const row = h("button", { className: `dev-zone-row${z.id === s.zone ? " active" : ""}`, onclick: () => { s.zone = z.id; this.refresh(true); } },
          h("b", {}, z.name), h("small", {}, `${z.cells.length} cells · ${mobs}`));
        list.append(row);
      }
      if (!this.tool.zones.length) list.append(h("div", { className: "dev-empty" }, "No zones yet."));
      this.placerBox.append(list, h("button", { className: "dev-btn", onclick: () => { this.tool.newZone(); this.refresh(true); } }, "+ New zone"));

      const z = this.tool.selectedZone();
      if (z) {
        const name = h("input", { type: "text", value: z.name });
        name.addEventListener("keydown", (e) => e.stopPropagation());
        name.addEventListener("change", () => this.tool.updateZone(z.id, { name: name.value.trim() || z.name }));
        const mode = h("div", { className: "dev-grid cols-2" }, ...([false, true] as const).map((erase) => {
          const b = h("button", { className: "dev-btn", onclick: () => { s.zoneErase = erase; this.refresh(true); } }, erase ? "Erase cells" : "Paint cells");
          b.classList.toggle("active", s.zoneErase === erase);
          return b;
        }));
        const brush = h("div", { className: "dev-grid cols-4" }, ...[1, 2, 3, 5].map((n) => {
          const b = h("button", { className: "dev-btn", onclick: () => { s.zoneBrush = n; this.refresh(true); } }, `${n * 2 - 1}×${n * 2 - 1}`);
          b.classList.toggle("active", s.zoneBrush === n);
          return b;
        }));
        const mobBox = h("div", { className: "dev-zone-mobs" });
        z.mobs.forEach((m, i) => {
          const sel = h("select", {});
          for (const e of [...this.enemies.values()].sort((a, b) => a.level - b.level || a.name.localeCompare(b.name))) {
            sel.append(h("option", { value: e.id, selected: e.id === m.enemy }, `${e.name} (Lv ${e.level})`));
          }
          sel.addEventListener("change", () => this.tool.updateZone(z.id, { mobs: z.mobs.map((x, j) => (j === i ? { ...x, enemy: sel.value } : x)) }));
          const count = h("input", { type: "number", min: "1", max: "50", value: String(m.count) });
          count.addEventListener("keydown", (e) => e.stopPropagation());
          count.addEventListener("change", () => {
            const n = Math.max(1, Math.min(50, Math.round(Number(count.value) || 1)));
            this.tool.updateZone(z.id, { mobs: z.mobs.map((x, j) => (j === i ? { ...x, count: n } : x)) });
          });
          const del = h("button", { className: "dev-btn danger", title: "Remove", onclick: () => this.tool.updateZone(z.id, { mobs: z.mobs.filter((_, j) => j !== i) }) }, "×");
          mobBox.append(h("div", { className: "dev-zone-mob" }, count, sel, del));
        });
        const addMob = h("button", { className: "dev-btn", onclick: () => {
          const first = [...this.enemies.values()].find((e) => !e.dummy) ?? [...this.enemies.values()][0];
          if (first) this.tool.updateZone(z.id, { mobs: [...z.mobs, { enemy: first.id, count: 3 }] });
        } }, "+ Enemy type");
        this.placerBox.append(
          h("h3", {}, "Selected zone"),
          h("div", { className: "dev-field" }, "Name", name),
          h("div", { className: "dev-empty" }, `${z.cells.length} cells. Drag on the ground to paint its shape.`),
          mode, h("div", { className: "dev-field" }, "Brush"), brush,
          h("h3", {}, "Lives here"), mobBox, addMob,
          h("div", { className: "dev-grid cols-2" },
            h("button", { className: "dev-btn", onclick: () => { s.zone = null; this.refresh(true); } }, "Done"),
            h("button", { className: "dev-btn danger", onclick: () => { if (confirm(`Delete ${z.name}?`)) this.tool.deleteZone(z.id); } }, "Delete zone")),
        );
      }
    } else if (s.tool === "enemy") {
      const sel = h("select", {});
      for (const e of [...this.enemies.values()].sort((a, b) => a.level - b.level || a.name.localeCompare(b.name))) {
        sel.append(h("option", { value: e.id, selected: e.id === s.enemy }, `${e.name} (Lv ${e.level})`));
      }
      if (!s.enemy && this.enemies.size) s.enemy = [...this.enemies.keys()][0]!;
      sel.addEventListener("change", () => (s.enemy = sel.value));
      const moves = h("div", { className: "dev-grid cols-2" }, ...(["none", "area"] as const).map((m) => {
        const b = h("button", { className: "dev-btn", onclick: () => { s.enemyWander = m; this.refresh(true); } }, m === "none" ? "Stand" : "Roam");
        b.classList.toggle("active", s.enemyWander === m);
        return b;
      }));
      const r = h("input", { type: "number", min: "1", max: "8", value: String(s.enemyRadius) });
      r.addEventListener("keydown", (e) => e.stopPropagation());
      r.addEventListener("change", () => (s.enemyRadius = Math.max(1, Math.min(8, Math.round(Number(r.value) || 2)))));
      this.placerBox.append(h("h3", {}, "Enemy"), sel, h("h3", {}, "Movement"), moves,
        ...(s.enemyWander === "area" ? [h("div", { className: "dev-field" }, "Roam radius", r)] : []),
        h("div", { className: "dev-empty" }, `${this.placedEnemies()} enemy spot(s) on this map.`));
    } else if (s.tool === "item") {
      const sel = h("select", {});
      for (const it of [...this.items.values()].sort((a, b) => a.name.localeCompare(b.name))) sel.append(h("option", { value: it.id, selected: it.id === s.groundItem }, it.name));
      if (!s.groundItem && this.items.size) s.groundItem = [...this.items.values()].sort((a, b) => a.name.localeCompare(b.name))[0]!.id;
      sel.addEventListener("change", () => (s.groundItem = sel.value));
      const qty = h("input", { type: "number", min: "1", max: "10", value: String(s.groundQty) });
      qty.addEventListener("change", () => (s.groundQty = Math.max(1, Math.min(10, Math.round(Number(qty.value) || 1)))));
      qty.addEventListener("keydown", (e) => e.stopPropagation());
      this.placerBox.append(h("h3", {}, "Ground item"), sel, h("div", { className: "dev-field" }, "Amount", qty));
    }
  }

  private renderedProps = "";

  /** Prop palette, facing and sign text (only while the Prop tool is active). */
  private renderProps(force: boolean): void {
    const s = this.tool.settings;
    this.propBox.hidden = s.tool !== "prop";
    const snap = `${s.tool}|${s.prop}|${s.rot}|${s.scatter}|${s.scatterErase}`;
    if (!force && snap === this.renderedProps) return;
    if (this.propBox.contains(document.activeElement) && !force) return;
    this.renderedProps = snap;
    this.propBox.replaceChildren();
    if (s.tool !== "prop") return;
    const defs = [...this.propDefs.values()];
    for (const cat of ["nature", "furniture", "storage", "decor", "signage"] as const) {
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

  /** Scatter brush options for nature props: on/off, size, density, which props to mix. */
  private scatterControls(): HTMLElement {
    const s = this.tool.settings;
    const box = h("div", { className: "dev-scatter" });
    const toggle = h("button", { className: "dev-btn", onclick: () => { s.scatter = !s.scatter; this.refresh(true); } }, s.scatter ? "Scatter brush: on" : "Scatter brush: off");
    toggle.classList.toggle("active", s.scatter);
    box.append(h("h3", {}, "Scatter"), toggle);
    if (!s.scatter) {
      box.append(h("div", { className: "dev-hint" }, "Turn on to drag-paint a random mix of trees, rocks or plants."));
      return box;
    }
    const mode = h("div", { className: "dev-grid cols-2" }, ...([false, true] as const).map((erase) => {
      const b = h("button", { className: "dev-btn", onclick: () => { s.scatterErase = erase; this.refresh(true); } }, erase ? "Erase" : "Paint");
      b.classList.toggle("active", s.scatterErase === erase);
      return b;
    }));
    const slider = (label: string, min: number, max: number, step: number, value: number, set: (v: number) => void, fmt: (v: number) => string): HTMLElement => {
      const out = h("span", {}, fmt(value));
      const input = h("input", { type: "range", min: String(min), max: String(max), step: String(step), value: String(value) });
      input.addEventListener("input", () => { set(Number(input.value)); out.textContent = fmt(Number(input.value)); });
      return h("label", { className: "dev-field" }, label, input, out);
    };
    box.append(
      mode,
      slider("Brush", 1, 10, 1, s.scatterRadius, (v) => (s.scatterRadius = v), (v) => `${v * 2 + 1} wide`),
      slider("Density", 0.01, 0.5, 0.01, s.scatterDensity, (v) => (s.scatterDensity = v), (v) => `${Math.round(v * 100)}%`),
      h("h3", {}, "Mix (none ticked = selected prop)"),
    );
    const grid = h("div", { className: "dev-grid cols-2" });
    for (const d of [...this.propDefs.values()].filter((x) => x.category === "nature")) {
      const cb = h("input", { type: "checkbox", checked: s.scatterMix.includes(d.id) });
      cb.addEventListener("change", () => {
        s.scatterMix = cb.checked ? [...s.scatterMix, d.id] : s.scatterMix.filter((x) => x !== d.id);
      });
      grid.append(h("label", { className: "dev-check" }, cb, d.name));
    }
    box.append(grid, h("div", { className: "dev-hint" }, "Each cell rolls once per drag. Solid props never touch, so paths stay open. Undo works."));
    return box;
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
      // Height of the ground floor above the terrain (not the absolute world height, which was easy to break).
      (() => {
        const ground = this.tool.groundTop(sel);
        const above = Math.round((sel.baseY - ground) * 100) / 100;
        return h("div", { className: "dev-field" }, "Floor above ground",
          num(above, 0.1, (v) => this.tool.updateSelected({ baseY: Math.round((ground + Math.max(-0.5, Math.min(8, v))) * 100) / 100 })),
          h("button", { className: "dev-btn", title: "Put the floor just above the highest ground under the building", onclick: () => this.tool.updateSelected({ baseY: Math.round((ground + 0.1) * 100) / 100 }) }, "Snap to ground"));
      })(),
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
