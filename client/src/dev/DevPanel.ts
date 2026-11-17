import { TERRAIN_MATERIALS, WALK_AUTO, WALK_BLOCKED, WALK_FORCED, type Region, type WalkOverride } from "@levi/shared";
import type { BuildPanel } from "./BuildPanel.js";
import { h } from "./dom.js";
import type { SculptTool, TerrainSculptor } from "./TerrainSculptor.js";

export type DevMode = "terrain" | "build" | "items";

const TOOLS: ReadonlyArray<[SculptTool, string]> = [
  ["raise", "Raise"], ["lower", "Lower"], ["smooth", "Smooth"], ["flatten", "Flatten"],
  ["set", "Set"], ["paint", "Paint"], ["walk", "Collision"], ["void", "Void"],
  ["region", "Region"],
];

const WALK_MODES: ReadonlyArray<[WalkOverride, string]> = [
  [WALK_BLOCKED, "Block"], [WALK_FORCED, "Walkable"], [WALK_AUTO, "Auto"],
];

const REGION_KINDS: ReadonlyArray<Region["kind"]> = ["island", "sky", "zone"];

export interface DevPanelActions {
  undo(): void;
  canUndo(): boolean;
  hasUnsaved(): boolean;
  setMode(mode: DevMode): void;
  save(): void;
  setSpawnHere(): void;
  setWaterLevel(level: number): void;
  setShowCollision(show: boolean): void;
  toggleFreeCam(): void;
  setFlySpeed(speed: number): void;
  floatRegion(id: string, lift: number): void;
  sinkOutsideRegions(seabed: number): void;
  goToRegion(id: string): void;
  testCombat(): void;
  openItemManager(): void;
  resetLoot(): void;
  clearBag(): void;
  resetQuests(): void;
  resetCharacter(): void;
}

/** DOM for the F1 panel. Holds no game state; reads/writes sculptor settings. */
export class DevPanel {
  readonly root: HTMLElement;
  private readonly status: HTMLElement;
  private readonly undoBtn: HTMLButtonElement;
  private readonly coords: HTMLElement;
  private readonly toolButtons = new Map<SculptTool, HTMLButtonElement>();
  private readonly contextual: HTMLElement;
  private readonly waterInput: HTMLInputElement;
  private readonly freeCamBtn: HTMLButtonElement;
  private readonly regionList: HTMLElement;
  private readonly liftInput: HTMLInputElement;
  private readonly seabedInput: HTMLInputElement;
  private readonly title: HTMLElement;
  private readonly terrainSection: HTMLElement;
  private readonly itemsSection: HTMLElement;
  private readonly modeButtons = new Map<DevMode, HTMLButtonElement>();
  private _mode: DevMode = "terrain";

  constructor(
    host: HTMLElement,
    private readonly sculptor: TerrainSculptor,
    private readonly buildPanel: BuildPanel,
    private readonly actions: DevPanelActions,
    waterLevel: number,
    flySpeed: number,
  ) {
    const s = sculptor.settings;
    this.freeCamBtn = h("button", { className: "dev-btn", onclick: () => actions.toggleFreeCam() }, "Free camera  (C)");
    this.status = h("span", { className: "dev-status" }, "Saved");
    this.undoBtn = h("button", { className: "dev-btn", onclick: () => actions.undo() }, "Undo");
    this.coords = h("span", { className: "dev-coords" });
    this.contextual = h("div");
    this.regionList = h("div", { className: "dev-regions" });
    this.liftInput = h("input", { type: "number", step: "5", value: "80" });
    this.seabedInput = h("input", { type: "number", step: "1", value: "-8" });

    const toolGrid = h("div", { className: "dev-grid" });
    for (const [tool, label] of TOOLS) {
      const b = h("button", { className: "dev-btn", onclick: () => this.selectTool(tool) }, label);
      this.toolButtons.set(tool, b);
      toolGrid.append(b);
    }

    this.waterInput = h("input", { type: "number", step: "0.25", value: String(waterLevel) });
    this.waterInput.addEventListener("change", () => {
      const v = Number(this.waterInput.value);
      if (Number.isFinite(v)) actions.setWaterLevel(v);
    });

    const collision = h("input", { type: "checkbox" });
    collision.addEventListener("change", () => actions.setShowCollision(collision.checked));

    const sinkBtn = h("button", {
      className: "dev-btn",
      onclick: () => {
        const v = Number(this.seabedInput.value);
        if (!Number.isFinite(v)) return;
        if (confirm(`Flatten EVERYTHING outside the ${sculptor.regions.length} region(s) to ocean floor ${v}? (Undoable)`)) {
          actions.sinkOutsideRegions(v);
        }
      },
    }, "Ocean outside regions");

    this.title = h("h2", {}, "Dev · Terrain");
    const tabs = h("div", { className: "dev-grid cols-3 dev-tabs" });
    for (const [mode, label] of [["terrain", "Terrain"], ["build", "Build"], ["items", "Items"]] as const) {
      const b = h("button", { className: "dev-btn", onclick: () => this.setMode(mode) }, label);
      this.modeButtons.set(mode, b);
      tabs.append(b);
    }
    this.terrainSection = h(
      "section",
      {},
      toolGrid,
      this.slider("Radius", 1, 40, 1, s.radius, (v) => (s.radius = v)),
      this.slider("Strength", 0.2, 20, 0.1, s.strength, (v) => (s.strength = v)),
      this.contextual,
      h("label", { className: "dev-check" }, collision, "Show collision (red = blocked)"),
      h("h3", {}, "Regions"),
      this.regionList,
      h("div", { className: "dev-field" }, "Float lift (+Y)", this.liftInput),
      h("div", { className: "dev-field" }, sinkBtn, this.seabedInput),
      h("h3", {}, "Map"),
      h("div", { className: "dev-field" }, "Water level", this.waterInput),
      h("div", { className: "dev-field" }, this.coords, h("button", { className: "dev-btn", onclick: () => actions.setSpawnHere() }, "Set spawn here")),
    );
    this.itemsSection = h(
      "section",
      {},
      h("div", { className: "dev-empty" }, "Every item in the game: browse, edit, create, duplicate, delete, and give yourself copies to test. Saving writes content/items/<id>.json."),
      h("button", { className: "dev-btn primary", onclick: () => actions.openItemManager() }, "Open item manager"),
    );
    this.root = h(
      "aside",
      { id: "dev-panel", hidden: true },
      h("header", {}, this.title, this.status),
      tabs,
      this.terrainSection,
      buildPanel.root,
      this.itemsSection,
      h("h3", {}, "Camera"),
      h("div", { className: "dev-grid cols-2" }, this.freeCamBtn),
      this.slider("Fly speed", 5, 150, 5, flySpeed, (v) => actions.setFlySpeed(v)),
      h("h3", {}, "Player"),
      h(
        "div",
        { className: "dev-grid cols-2" },
        h("button", { className: "dev-btn", title: "Pretend you're in combat for 10s (gear/hotbar/skills lock)", onclick: () => actions.testCombat() }, "Combat 10s"),
        h("button", { className: "dev-btn", title: "Start as a brand-new player: character, quests, chests and ground items all reset", onclick: () => confirm("Fresh start? Your character, quests, looted chests and picked-up items all reset, exactly like a new player.") && actions.resetCharacter() }, "Fresh start"),
        h("button", { className: "dev-btn", title: "Forget all quest progress, story flags, Adventuring XP and quest items", onclick: () => confirm("Reset all quests (progress, flags, Adventuring XP and quest items)?") && actions.resetQuests() }, "Reset quests"),
        h("button", { className: "dev-btn", title: "Refill every chest you've looted with its designed loot", onclick: () => actions.resetLoot() }, "Reset loot"),
        h("button", { className: "dev-btn", title: "Empty your bag and hotbar (worn gear stays)", onclick: () => actions.clearBag() }, "Clear bag"),
      ),
      h("h3", {}, "File"),
      h("div", { className: "dev-grid cols-2" }, this.undoBtn, h("button", { className: "dev-btn primary", onclick: () => actions.save() }, "Save")),
      this.hint(),
    );
    host.appendChild(this.root);
    this.selectTool(s.tool);
    this.setMode("terrain");
  }

  get mode(): DevMode {
    return this._mode;
  }

  setMode(mode: DevMode): void {
    this._mode = mode;
    for (const [m, b] of this.modeButtons) b.classList.toggle("active", m === mode);
    this.terrainSection.hidden = mode !== "terrain";
    this.buildPanel.root.hidden = mode !== "build";
    this.itemsSection.hidden = mode !== "items";
    this.title.textContent = mode === "terrain" ? "Dev · Terrain" : mode === "build" ? "Dev · Build" : "Dev · Items";
    this.actions.setMode(mode);
    this.refresh();
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  toggle(): void {
    this.root.hidden = !this.root.hidden;
  }

  setFreeCamActive(active: boolean): void {
    this.freeCamBtn.classList.toggle("active", active);
  }

  setCoords(x: number, z: number): void {
    this.coords.textContent = `Player ${x.toFixed(1)}, ${z.toFixed(1)}`;
  }

  /** Reflect sculptor dirty/undo state and the region list. */
  refresh(): void {
    const unsaved = this.actions.hasUnsaved();
    this.status.textContent = unsaved ? "Unsaved changes" : "Saved";
    this.status.classList.toggle("unsaved", unsaved);
    this.undoBtn.disabled = !this.actions.canUndo();
    this.buildPanel.refresh();
    if (document.activeElement !== this.waterInput) this.waterInput.value = String(this.sculptor.waterLevel);
    this.renderRegions();
  }

  private renderedRegions = "";

  private renderRegions(): void {
    const regions = this.sculptor.regions;
    // Rebuild only on change, and never while the user is typing a name.
    const snapshot = JSON.stringify(regions);
    if (snapshot === this.renderedRegions || this.regionList.contains(document.activeElement)) return;
    this.renderedRegions = snapshot;
    this.regionList.replaceChildren();
    if (regions.length === 0) {
      this.regionList.append(h("div", { className: "dev-empty" }, "No regions. Pick the Region tool and drag on the ground."));
      return;
    }
    for (const r of regions) {
      const name = h("input", { type: "text", value: r.name, maxLength: 64 });
      name.addEventListener("change", () => name.value.trim() && this.sculptor.updateRegion(r.id, { name: name.value.trim() }));
      const kind = h("select", {});
      for (const k of REGION_KINDS) kind.append(h("option", { value: k, selected: k === r.kind }, k));
      kind.addEventListener("change", () => this.sculptor.updateRegion(r.id, { kind: kind.value as Region["kind"] }));

      const size = `${Math.round(r.bounds.x1 - r.bounds.x0)}×${Math.round(r.bounds.z1 - r.bounds.z0)}`;
      const alt = r.altitude !== undefined ? ` · alt ${r.altitude}` : "";
      this.regionList.append(
        h(
          "div",
          { className: "dev-region" },
          h("div", { className: "dev-region-row" }, name, kind),
          h("div", { className: "dev-region-meta" }, `${r.id} · ${size}${alt}`),
          h(
            "div",
            { className: "dev-grid cols-3" },
            h("button", { className: "dev-btn", onclick: () => this.actions.goToRegion(r.id) }, "Go"),
            h("button", {
              className: "dev-btn",
              onclick: () => {
                const lift = Number(this.liftInput.value);
                if (Number.isFinite(lift) && confirm(`Float "${r.name}" up by ${lift}? Land is lifted, everything else in the box becomes void. (Undoable)`)) {
                  this.actions.floatRegion(r.id, lift);
                }
              },
            }, "Float"),
            h("button", { className: "dev-btn", onclick: () => confirm(`Delete region "${r.name}"? (Terrain is kept)`) && this.sculptor.deleteRegion(r.id) }, "Delete"),
          ),
        ),
      );
    }
  }

  private selectTool(tool: SculptTool): void {
    this.sculptor.settings.tool = tool;
    for (const [t, b] of this.toolButtons) b.classList.toggle("active", t === tool);
    this.renderContextual();
  }

  private renderContextual(): void {
    const s = this.sculptor.settings;
    this.contextual.replaceChildren();

    if (s.tool === "set") {
      const input = h("input", { type: "number", step: "0.25", value: String(s.setHeight) });
      input.addEventListener("input", () => {
        const v = Number(input.value);
        if (Number.isFinite(v)) s.setHeight = v;
      });
      this.contextual.append(h("div", { className: "dev-field" }, "Target height", input));
    } else if (s.tool === "paint") {
      const grid = h("div", { className: "dev-swatches" });
      for (const m of TERRAIN_MATERIALS) {
        const sw = h("div", { className: "dev-swatch", title: m.name });
        sw.style.background = m.id === 0 ? "repeating-linear-gradient(45deg,#555 0 4px,#333 4px 8px)" : m.color;
        sw.classList.toggle("active", s.material === m.id);
        sw.addEventListener("click", () => {
          s.material = m.id;
          this.renderContextual();
        });
        grid.append(sw);
      }
      const name = TERRAIN_MATERIALS.find((m) => m.id === s.material)?.name ?? "";
      this.contextual.append(h("h3", {}, `Material · ${name}`), grid);
    } else if (s.tool === "walk") {
      const grid = h("div", { className: "dev-grid cols-3" });
      for (const [mode, label] of WALK_MODES) {
        const b = h("button", { className: "dev-btn", onclick: () => { s.walkMode = mode; this.renderContextual(); } }, label);
        b.classList.toggle("active", s.walkMode === mode);
        grid.append(b);
      }
      this.contextual.append(h("h3", {}, "Collision brush"), grid);
    } else if (s.tool === "void") {
      const grid = h("div", { className: "dev-grid cols-2" });
      for (const [cut, label] of [[true, "Cut void"], [false, "Fill ground"]] as const) {
        const b = h("button", { className: "dev-btn", onclick: () => { s.voidCut = cut; this.renderContextual(); } }, label);
        b.classList.toggle("active", s.voidCut === cut);
        grid.append(b);
      }
      this.contextual.append(h("h3", {}, "Void brush · land ringed by void floats"), grid);
    } else if (s.tool === "region") {
      this.contextual.append(h("div", { className: "dev-empty" }, "Drag on the ground to draw a new region box."));
    }
  }

  private slider(label: string, min: number, max: number, step: number, value: number, set: (v: number) => void): HTMLElement {
    const out = h("output", {}, String(value));
    const input = h("input", { type: "range", min: String(min), max: String(max), step: String(step), value: String(value) });
    input.addEventListener("input", () => {
      const v = Number(input.value);
      set(v);
      out.textContent = String(v);
    });
    return h("div", { className: "dev-row" }, label, input, out);
  }

  private hint(): HTMLElement {
    const k = (t: string): HTMLElement => h("kbd", {}, t);
    return h(
      "div",
      { className: "dev-hint" },
      k("LMB"), " sculpt / build · ", k("RMB"), " walk · ", k("Ctrl"), "+", k("RMB"), " teleport", h("br"),
      "Build: rooms/sheds open towards the camera · stairs climb away from it", h("br"),
      k("["), k("]"), " radius · ", k("Ctrl"), "+", k("Z"), " undo · ", k("Ctrl"), "+", k("S"), " save · ", k("F1"), " close", h("br"),
      "Free cam: ", k("W"), k("A"), k("S"), k("D"), " fly · ", k("Q"), k("E"), " down/up · ", k("Shift"), " fast · ", k("RMB"), " look · wheel dolly",
    );
  }
}
